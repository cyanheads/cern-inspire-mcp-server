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
  literatureMetadata,
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
    it.each([
      'a:',
      '(a:)',
      'a: and t higgs',
      't: or a Witten',
      'a: not',
      'a:(not)',
      'a: not not',
      'a:""',
      "a:''",
      'a: " "',
      'a:("")',
      'a: not ""',
    ])(`${definition.name} rejects %s before requests`, async (query) => {
      h.route('/literature', jsonResponse(badRequestBody(), { status: 400 }));
      h.route('/literature/facets', jsonResponse(badRequestBody(), { status: 400 }));
      const result = await runToolContract(definition, { query });
      expect(h.requests).toHaveLength(0);
      const error = errorEnvelope(result);
      expect(error.data?.reason).toBe('invalid_query');
      expect(error.data?.recovery?.hint).toContain('a Witten');
      expect(fullText(result)).toContain(error.data?.recovery?.hint);
      expect(h.requests).toHaveLength(0);
    });
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
      expect(h.requests).toHaveLength(8);
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
      expect(h.requests).toHaveLength(2);
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

describe('reference fallback selection verification', () => {
  it.each(['mostcited', 'mostrecent'] as const)(
    'preserves useful unfiltered first-page fallback under %s in one request',
    async (sort) => {
      h.route('/literature', (request) =>
        new URL(request.url).searchParams.has('format')
          ? textResponse(exportBody(BIBTEX_ENTRIES))
          : jsonResponse(literaturePage()),
      );
      const search = await runToolContract(searchLiteratureTool, {
        query: 'Bibliographic reference 2012',
        size: 1,
        sort,
      });
      expect(structured<{ papers: { recid: string }[] }>(search).papers[0]?.recid).toBe('1124337');
      expect(fullText(search)).toContain('Observation of a new particle');
      const exported = await runToolContract(exportCitationsTool, {
        query: 'Bibliographic reference 2012',
        size: 1,
        sort,
      });
      expect(structured<{ entries: unknown[] }>(exported).entries).toHaveLength(1);
      expect(h.requests).toHaveLength(2);
    },
  );

  it.each(['bibtex', 'latex-eu', 'latex-us'] as const)(
    'preserves filtered %s Boolean selection through exhausted pages',
    async (format) => {
      const keys = ['One:2020a', 'Two:2020b'];
      const responder = pagedLiterature(keys, { leftover: true });
      h.route('/literature', responder);
      for (const page of [1, 2, 3]) {
        const result = await runToolContract(exportCitationsTool, {
          query: '(arxiv:1207.7214 or arxiv:1207.7235)',
          document_types: ['published'],
          page,
          size: 1,
          format,
        });
        expect(
          structured<{ entries: { texkey: string }[] }>(result).entries.map(
            (entry) => entry.texkey,
          ),
        ).toEqual(keys.slice(page - 1, page));
        expect(structured<{ truncated: boolean }>(result).truncated).toBe(page === 1);
        if (page < 3) expect(fullText(result)).toContain(keys[page - 1]);
      }
      expect(h.requests).toHaveLength(6);
    },
  );

  for (const definition of [searchLiteratureTool, exportCitationsTool]) {
    it.each([
      'arxiv:1207.7214',
      'doi:10.1016/j.physletb.2012.08.020',
      '((arxiv:1207.7214))',
      'arxiv:1207.7214 or arxiv:1207.7235',
      'refersto:recid:451647',
    ])(`${definition.name} keeps valid filtered selection for %s`, async (query) => {
      h.route('/literature', (request) => {
        const params = new URL(request.url).searchParams;
        if (params.has('format')) return textResponse(exportBody(BIBTEX_ENTRIES));
        return jsonResponse(
          params.get('fields') === 'control_number'
            ? literaturePage([{ control_number: 1124337, document_type: ['article'] }])
            : literaturePage(),
        );
      });
      const result = await runToolContract(definition, {
        query,
        document_types: ['published'],
        size: 1,
      });
      expect(result.isError).toBeFalsy();
      const output = structured<{ papers?: unknown[]; entries?: unknown[] }>(result);
      expect(output.papers ?? output.entries).toHaveLength(1);
      expect(h.requests).toHaveLength(2);
      expect(h.requests.every((request) => request.params.get('q') === query)).toBe(true);
    });

    it(`${definition.name} keeps later unfiltered reference fallback within the verified count`, async () => {
      h.route('/literature', (request) =>
        new URL(request.url).searchParams.has('format')
          ? textResponse(exportBody(BIBTEX_ENTRIES.slice(0, 1)))
          : jsonResponse(literaturePage([literatureMetadata()], { total: 2 })),
      );
      const result = await runToolContract(definition, {
        query: 'Bibliographic reference',
        page: 2,
        size: 1,
        sort: 'mostcited',
      });
      const output = structured<{ papers?: unknown[]; entries?: unknown[] }>(result);
      expect(output.papers ?? output.entries).toHaveLength(1);
      expect(fullText(result)).toMatch(/Observation of a new particle|ATLAS:2012/);
      expect(h.requests).toHaveLength(2);
    });

    it.each([
      { document_types: ['thesis'] },
      { document_types: ['published', 'thesis'] },
      { subjects: ['Theory-HEP', 'Experiment-HEP'] },
      { year_to: 2011 },
    ])(`${definition.name} suppresses a required-title fallback under %j`, async (filters) => {
      const query = '(arxiv:1207.7214 or doi:10.1016/j.physletb.2012.08.020)';
      h.route('/literature', (request) => {
        const params = new URL(request.url).searchParams;
        if (params.has('format')) return textResponse(exportBody(BIBTEX_ENTRIES));
        return jsonResponse(
          literaturePage([
            { control_number: 1124337, titles: [{ title: 'Required fallback title' }] },
          ]),
        );
      });
      const result = await runToolContract(definition, { query, size: 1, ...filters });
      expect(result.isError).toBeFalsy();
      const output = structured<{
        papers?: unknown[];
        entries?: unknown[];
        totalCount?: number;
        truncated: boolean;
      }>(result);
      expect(output.papers ?? output.entries).toEqual([]);
      expect(output.truncated).toBe(false);
      expect(fullText(result)).not.toContain('Required fallback title');
      expect(fullText(result)).not.toContain('ATLAS:2012yve');
      expect(h.requests).toHaveLength(2);
      expect(h.requests.every((request) => request.params.get('q') === query)).toBe(true);
      const count = h.requests.find((request) => request.params.get('fields') === 'control_number');
      expect(count).toBeDefined();
      expect(count?.params.has('page')).toBe(false);
      for (const key of ['doc_type', 'subject', 'earliest_date']) {
        expect(count?.params.getAll(key)).toEqual(h.requests[0]?.params.getAll(key));
      }
    });

    it(`${definition.name} suppresses a repeated exhausted page and keeps its verified total`, async () => {
      h.route('/literature', (request) =>
        new URL(request.url).searchParams.has('format')
          ? textResponse(exportBody(BIBTEX_ENTRIES))
          : jsonResponse(literaturePage()),
      );
      const result = await runToolContract(definition, {
        query: 'arxiv:1207.7214',
        page: 2,
        size: 1,
        sort: 'mostcited',
      });
      const output = structured<{
        papers?: unknown[];
        entries?: unknown[];
        totalCount?: number;
        truncated: boolean;
      }>(result);
      expect(output.papers ?? output.entries).toEqual([]);
      expect(output.truncated).toBe(false);
      expect(h.requests).toHaveLength(2);
      expect(fullText(result)).not.toContain('Observation of a new particle');
    });

    it(`${definition.name} propagates required verification failure on both surfaces`, async () => {
      h.route('/literature', (request) => {
        const params = new URL(request.url).searchParams;
        if (params.get('fields') === 'control_number')
          return jsonResponse(badRequestBody('Count [bad](https://example.org) <value>.'), {
            status: 400,
          });
        return params.has('format')
          ? textResponse(exportBody(BIBTEX_ENTRIES))
          : jsonResponse(literaturePage());
      });
      const result = await runToolContract(definition, { query: 'arxiv:1207.7214', year_to: 2011 });
      const error = errorEnvelope(result);
      expect(error.data?.reason).toBe('invalid_query');
      expect(error.message).toBe(
        'INSPIRE rejected the request: Count [bad](https://example.org) <value>.',
      );
      expect(fullText(result)).toContain('Count \\[bad\\]');
      expect(fullText(result)).not.toContain('ATLAS:2012yve');
    });
  }
});
