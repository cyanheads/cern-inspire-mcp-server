/**
 * @fileoverview Query selection contracts shared by literature tools.
 * @module tests/tools/query-selection.tool.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportCitationsTool } from '@/mcp-server/tools/definitions/export-citations.tool.js';
import { getCitationSummaryTool } from '@/mcp-server/tools/definitions/get-citation-summary.tool.js';
import { searchLiteratureTool } from '@/mcp-server/tools/definitions/search-literature.tool.js';
import {
  BIBTEX_ENTRIES,
  badRequestBody,
  exportBody,
  jsonResponse,
  literaturePage,
  pagedLiterature,
  textResponse,
} from '../fixtures/inspire-upstream.js';
import { type ServiceHarness, startHarness, stopHarness } from '../fixtures/service-harness.js';
import { errorEnvelope, fullText, structured } from '../fixtures/tool-result.js';

vi.mock('@/services/inspire/inspire-service.js', async (importOriginal) =>
  (await import('../fixtures/active-service.js')).withActiveService(await importOriginal()),
);

let h: ServiceHarness;
beforeEach(() => {
  h = startHarness();
});
afterEach(() => {
  stopHarness();
});

const validQueries = [
  'a: Witten',
  'a Witten',
  'a:(Witten or Maldacena)',
  'a:(not Witten)',
  'a: not Witten and Maldacena',
  '(t:higgs and not a:Witten)',
  't "a:"',
  't:"and or not"',
  't:/foo a: or bar/',
  't /foo a: or bar/',
  '/foo a: or bar/',
  'refersto:t:/foo a: not/',
  'https://example.org/a:',
  'doi:10.1016/j.physletb.2012.08.020',
  'arxiv:1207.7214',
  'authors.full_name:Witten',
  'refersto:recid:451647',
  'citedby:recid:1124337',
];

describe('query characterization', () => {
  it.each(validQueries)('forwards legitimate syntax unchanged: %s', async (query) => {
    h.route('/literature', jsonResponse(literaturePage()));
    const result = await runToolContract(searchLiteratureTool, { query });
    expect(result.isError).toBeFalsy();
    expect(h.requests[0]?.params.get('q')).toBe(query);
  });
});

describe('empty recognized clauses', () => {
  for (const definition of [searchLiteratureTool, getCitationSummaryTool, exportCitationsTool]) {
    it.each(['a:', '(a:)', 'a: and t higgs', 't: or a Witten', 'a: not', 'a:(not)', 'a: not not'])(
      `${definition.name} rejects %s before requests`,
      async (query) => {
        h.route('/literature', jsonResponse(badRequestBody(), { status: 400 }));
        h.route('/literature/facets', jsonResponse(badRequestBody(), { status: 400 }));
        const result = await runToolContract(definition, { query });
        expect(h.requests).toHaveLength(0);
        const error = errorEnvelope(result);
        expect(error.data?.reason).toBe('invalid_query');
        expect(error.data?.recovery?.hint).toContain('a Witten');
        expect(fullText(result)).toContain(error.data?.recovery?.hint);
        expect(h.requests).toHaveLength(0);
      },
    );
  }
});

describe('export filters', () => {
  it.each(['bibtex', 'latex-eu', 'latex-us'] as const)(
    'walks filtered %s pages through the last and past-end OR leftover',
    async (format) => {
      const keys = ['One:2020a', 'Two:2020b', 'Three:2020c', 'Four:2020d', 'Five:2020e'];
      const responder = pagedLiterature(keys, { leftover: true });
      h.route('/literature', (request) => {
        const params = new URL(request.url).searchParams;
        expect(params.getAll('doc_type')).toEqual(['published', 'review']);
        expect(params.getAll('subject')).toEqual(['Theory-HEP']);
        expect(params.get('earliest_date')).toBe('--1990');
        return responder(request);
      });
      for (let page = 1; page <= 4; page++) {
        const result = await runToolContract(exportCitationsTool, {
          query: 'recid:1 or recid:2',
          format,
          page,
          size: 2,
          document_types: ['published', 'review'],
          subjects: ['Theory-HEP'],
          year_to: 1990,
        });
        const output = structured<{
          entries: { texkey: string }[];
          truncated: boolean;
          appliedFilters: string;
        }>(result);
        expect(output.entries.map((entry) => entry.texkey)).toEqual(
          keys.slice((page - 1) * 2, page * 2),
        );
        expect(output.truncated).toBe(page < 3);
        expect(fullText(result)).toContain(output.appliedFilters);
        for (const entry of output.entries) expect(fullText(result)).toContain(entry.texkey);
      }
      expect(h.requests).toHaveLength(7);
      expect(h.requests[0]?.params.get('size')).toBe('3');
      expect(h.requests[0]?.params.has('page')).toBe(false);
    },
  );

  it.each([1, 3])('echoes filters on empty page %i', async (page) => {
    h.route('/literature', pagedLiterature([]));
    const result = await runToolContract(exportCitationsTool, {
      query: 't higgs',
      page,
      year_from: 2024,
    });
    const output = structured<{ entries: unknown[]; appliedFilters: string }>(result);
    expect(output.entries).toEqual([]);
    expect(output.appliedFilters).toBe('years=2024–');
    expect(fullText(result)).toContain('years=2024–');
  });

  it('shares blank handling and undocumented comma/case normalization', async () => {
    h.route('/literature', pagedLiterature([]));
    const input = exportCitationsTool.input.parse({
      query: 't higgs',
      document_types: 'PUBLISHED, review',
      subjects: 'theory-hep',
      year_from: '',
      year_to: '',
    });
    expect(input.document_types).toEqual(['published', 'review']);
    expect(input.subjects).toEqual(['Theory-HEP']);
    const result = await runToolContract(exportCitationsTool, input);
    expect(result.isError).toBeFalsy();
    expect(h.requests[0]?.params.has('earliest_date')).toBe(false);
  });

  it.each([
    { document_types: ['not-a-type'] },
    { subjects: ['not-a-subject'] },
    { year_from: 1899 },
  ])('rejects invalid filters %j without requests', async (filters) => {
    const result = await runToolContract(exportCitationsTool, { query: 't higgs', ...filters });
    expect(result.isError).toBe(true);
    expect(h.requests).toHaveLength(0);
  });
  it.each([1, 2])(
    'sends filters to every request on page %i and echoes both surfaces',
    async (page) => {
      h.route('/literature', (request) =>
        new URL(request.url).searchParams.has('format')
          ? textResponse(exportBody(BIBTEX_ENTRIES), 'application/x-bibtex')
          : jsonResponse({ hits: { total: 20, hits: [] } }),
      );
      const result = await runToolContract(exportCitationsTool, {
        query: 't higgs',
        page,
        document_types: ['published', 'review'],
        subjects: ['Theory-HEP'],
        year_from: 1980,
        year_to: 1990,
      });
      expect(result.isError).toBeFalsy();
      expect(h.requests).toHaveLength(page === 1 ? 1 : 2);
      for (const request of h.requests) {
        expect(request.params.getAll('doc_type')).toEqual(['published', 'review']);
        expect(request.params.getAll('subject')).toEqual(['Theory-HEP']);
        expect(request.params.get('earliest_date')).toBe('1980--1990');
      }
      const echo = 'document_types=published,review; subjects=Theory-HEP; years=1980–1990';
      expect(structured<{ appliedFilters: string }>(result).appliedFilters).toBe(echo);
      expect(fullText(result)).toContain(echo);
    },
  );
  it('rejects reversed year bounds before requests with typed recovery', async () => {
    h.route('/literature', textResponse('', 'application/x-bibtex'));
    const result = await runToolContract(exportCitationsTool, {
      query: 't higgs',
      year_from: 2024,
      year_to: 1990,
    });
    const error = errorEnvelope(result);
    expect(error.data?.reason).toBe('invalid_year_range');
    expect(fullText(result)).toContain(error.data?.recovery?.hint);
    expect(h.requests).toHaveLength(0);
  });
});
