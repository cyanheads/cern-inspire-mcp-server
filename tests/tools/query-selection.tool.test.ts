/**
 * @fileoverview Query selection contracts shared by the tools that send a caller
 * query: query characterization, empty recognized clauses (the literature tools
 * and the HEPData search), the arXiv version-suffix rewrite on every request of
 * a literature call, export filters, and reference-fallback verification.
 * @module tests/tools/query-selection.tool.test
 */
import { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportCitationsTool } from '@/mcp-server/tools/definitions/export-citations.tool.js';
import { getCitationSummaryTool } from '@/mcp-server/tools/definitions/get-citation-summary.tool.js';
import { getPaperTool } from '@/mcp-server/tools/definitions/get-paper.tool.js';
import { searchHepdataTool } from '@/mcp-server/tools/definitions/search-hepdata.tool.js';
import { searchLiteratureTool } from '@/mcp-server/tools/definitions/search-literature.tool.js';
import {
  BIBTEX_ENTRIES,
  badRequestBody,
  dataPage,
  dossierMetadata,
  emptyBody,
  exportBody,
  facetResponder,
  jsonResponse,
  literatureMetadata,
  literaturePage,
  pagedLiterature,
  textResponse,
  zeroCitationSummaryBody,
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

/** arXiv-shaped text that is not an arXiv clause value: sent as written, with no rewrite notice. */
const unrewrittenArxivForms = [
  'arxiv:1207.7214',
  'refersto:arxiv:1207.7214v2',
  'citedby:arxiv:1207.7214v2',
  'refersto arxiv:1207.7214v2',
  't "arxiv:1207.7214v2"',
  't 1207.7214v2',
  'arxiv:/1207\\.7214v2/',
  'https://arxiv.org/abs/1207.7214v2',
  'doi:10.48550/arXiv.1207.7214v2',
];

describe('query characterization', () => {
  it.each(validQueries)('forwards legitimate syntax unchanged: %s', async (query) => {
    h.route('/literature', jsonResponse(literaturePage()));
    const result = await runToolContract(searchLiteratureTool, { query });
    expect(result.isError).toBeFalsy();
    expect(h.requests[0]?.params.get('q')).toBe(query);
  });

  it.each(unrewrittenArxivForms)(
    'forwards %s unchanged, with no version notice on either surface',
    async (query) => {
      h.route('/literature', jsonResponse(literaturePage()));
      const result = await runToolContract(searchLiteratureTool, { query });
      expect(structured<{ notice?: string }>(result).notice ?? '').not.toContain('version');
      expect(fullText(result)).not.toContain('version suffix');
      expect(h.requests[0]?.params.get('q')).toBe(query);
    },
  );
});

describe('empty recognized clauses', () => {
  for (const [definition, example] of [
    [searchLiteratureTool, 'a Witten'],
    [getCitationSummaryTool, 'a Witten'],
    [exportCitationsTool, 'a Witten'],
    [searchHepdataTool, 't higgs'],
  ] as const) {
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
      't:',
      'k:',
      'cn:',
      'date:',
      'refersto:',
      'a: and arxiv:1207.7214v2',
    ])(`${definition.name} rejects %s before requests`, async (query) => {
      h.route('/literature', jsonResponse(badRequestBody(), { status: 400 }));
      h.route('/literature/facets', jsonResponse(badRequestBody(), { status: 400 }));
      h.route('/data', jsonResponse(badRequestBody(), { status: 400 }));
      const result = await runToolContract(definition, { query });
      expect(h.requests).toHaveLength(0);
      const error = errorEnvelope(result);
      expect(error.data?.reason).toBe('invalid_query');
      expect(error.data?.recovery?.hint).toContain(example);
      expect(fullText(result)).toContain(error.data?.recovery?.hint);
      expect(h.requests).toHaveLength(0);
    });
  }

  it.each([
    'collaborations.value:LHCb',
    'keywords.value:"Inclusive"',
    'literature.control_number:1797621',
    'dois.value:"10.17182/hepdata.98625"',
    'top pair differential cross section 13 TeV',
    ...validQueries,
  ])('cern_inspire_search_hepdata forwards %s to the data collection unchanged', async (query) => {
    h.route('/data', jsonResponse(dataPage()));
    const result = await runToolContract(searchHepdataTool, { query });
    expect(result.isError).toBeFalsy();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.path).toBe('/api/data');
    expect(h.requests[0]?.params.get('q')).toBe(query);
  });
});

describe('arXiv version suffixes', () => {
  const notice = (pairs: [string, string][]) =>
    `INSPIRE indexes arXiv IDs without a version suffix, so the suffix was removed: ${pairs
      .map(([written, sent]) => `"${written}" sent as "${sent}"`)
      .join('; ')}.`;

  /** Answers a literature search, a citation export, and the `fields=control_number` count. */
  const literatureResponder = (request: Request) => {
    const params = new URL(request.url).searchParams;
    if (params.has('format')) return textResponse(exportBody(BIBTEX_ENTRIES.slice(0, 1)));
    return jsonResponse(
      params.get('fields') === 'control_number'
        ? literaturePage([{ control_number: 1124337, document_type: ['article'] }])
        : literaturePage(),
    );
  };

  const nested = '(cn atlas and eprint 1207.7214v12) or not arxiv:hep-th/9711200V3';
  const nestedSent = '(cn atlas and eprint 1207.7214) or not arxiv:hep-th/9711200';
  const nestedNotice = notice([
    ['eprint 1207.7214v12', 'eprint 1207.7214'],
    ['arxiv:hep-th/9711200V3', 'arxiv:hep-th/9711200'],
  ]);

  for (const definition of [searchLiteratureTool, exportCitationsTool, getCitationSummaryTool]) {
    it(`${definition.name} sends unrewritten arXiv text as written, with no version notice`, async () => {
      const query = 'refersto:arxiv:1207.7214v2 and arxiv:1207.7214';
      h.route('/literature', literatureResponder);
      h.route('/literature/facets', facetResponder());
      const result = await runToolContract(definition, { query, year_to: 2026 });
      expect(structured<{ notice?: string }>(result).notice ?? '').not.toContain('version');
      expect(fullText(result)).not.toContain('version suffix');
      expect(h.requests.length).toBeGreaterThan(0);
      expect(h.requests.every((request) => request.params.get('q') === query)).toBe(true);
    });

    it(`${definition.name} sends the unversioned IDs on every request and names each rewrite on both surfaces`, async () => {
      h.route('/literature', literatureResponder);
      h.route('/literature/facets', facetResponder());
      const result = await runToolContract(definition, {
        query: nested,
        document_types: ['published'],
      });
      const output = structured<{ notice?: string; effectiveQuery?: string }>(result);
      expect(output.notice).toContain(nestedNotice);
      expect(fullText(result)).toContain(nestedNotice);
      expect(h.requests).toHaveLength(2);
      expect(h.requests.map((request) => request.params.get('q'))).toEqual([
        nestedSent,
        nestedSent,
      ]);
    });

    it(`${definition.name} rejects an empty clause beside a versioned ID before any request`, async () => {
      const result = await runToolContract(definition, { query: 'a: and arxiv:1207.7214v2' });
      expect(errorEnvelope(result).data?.reason).toBe('invalid_query');
      expect(h.requests).toHaveLength(0);
    });
  }

  it('cern_inspire_search_literature keeps the size-reduction and paging notices beside the rewrite', async () => {
    h.route('/literature', jsonResponse(literaturePage([literatureMetadata()], { next: true })));
    const result = await runToolContract(searchLiteratureTool, {
      query: 'arxiv:1207.7214v2',
      size: 101,
    });
    const text = structured<{ notice?: string }>(result).notice ?? '';
    const expected = notice([['arxiv:1207.7214v2', 'arxiv:1207.7214']]);
    expect(text).toBe(
      `More results: request page 2 with size 100. size 101 reduced to 100. ${expected}`,
    );
    expect(fullText(result)).toContain(expected);
    expect(h.requests[0]?.params.get('q')).toBe('arxiv:1207.7214');
  });

  it('cern_inspire_search_literature names the query it sent when nothing matched', async () => {
    h.route('/literature', jsonResponse(emptyBody()));
    const result = await runToolContract(searchLiteratureTool, { query: 'eprint 1207.7214v2' });
    const text = structured<{ notice?: string }>(result).notice ?? '';
    expect(text).toContain(notice([['eprint 1207.7214v2', 'eprint 1207.7214']]));
    expect(text).toContain('No INSPIRE literature matched "eprint 1207.7214".');
    expect(fullText(result)).toContain('No INSPIRE literature matched "eprint 1207.7214".');
  });

  it('cern_inspire_export_citations names the query it sent when nothing matched', async () => {
    h.route('/literature', textResponse(''));
    const result = await runToolContract(exportCitationsTool, { query: 'eprint 1207.7214v2' });
    const text = structured<{ notice?: string }>(result).notice ?? '';
    expect(text).toContain(notice([['eprint 1207.7214v2', 'eprint 1207.7214']]));
    expect(text).toContain('No INSPIRE literature matched "eprint 1207.7214";');
    expect(fullText(result)).toContain('No INSPIRE literature matched "eprint 1207.7214";');
  });

  it.each([1, 2])(
    'cern_inspire_export_citations sends the named-paper OR list unversioned on page %i, count request included',
    async (page) => {
      h.route('/literature', pagedLiterature(['Maldacena:1997re', 'ATLAS:2012yve']));
      const result = await runToolContract(exportCitationsTool, {
        query: 'recid:451647 or arxiv:1207.7214v2',
        page,
        size: 1,
      });
      const output = structured<{ entries: { texkey: string }[]; notice?: string }>(result);
      expect(output.entries.map((entry) => entry.texkey)).toEqual([
        page === 1 ? 'Maldacena:1997re' : 'ATLAS:2012yve',
      ]);
      const expected = notice([['arxiv:1207.7214v2', 'arxiv:1207.7214']]);
      expect(output.notice).toContain(expected);
      expect(fullText(result)).toContain(expected);
      if (page === 1) expect(output.notice).toContain('request page 2 with size 1');
      expect(h.requests).toHaveLength(page);
      for (const request of h.requests) {
        expect(request.params.get('q')).toBe('recid:451647 or arxiv:1207.7214');
      }
    },
  );

  it('cern_inspire_export_citations keeps the past-the-end notice beside the rewrite', async () => {
    h.route('/literature', pagedLiterature(['Maldacena:1997re', 'ATLAS:2012yve']));
    const result = await runToolContract(exportCitationsTool, {
      query: 'recid:451647 or 1207.7214V2',
      page: 5,
      size: 1,
    });
    const output = structured<{ entries: unknown[]; notice?: string }>(result);
    expect(output.entries).toEqual([]);
    expect(output.notice).toBe(
      `${notice([['1207.7214V2', '1207.7214']])} Page 5 is past the last page (2); request a lower page.`,
    );
    expect(fullText(result)).toContain(output.notice);
  });

  it('cern_inspire_get_citation_summary sends both facet requests unversioned and echoes the sent query as effectiveQuery and target.query', async () => {
    h.route('/literature/facets', facetResponder());
    const query = '(a Witten or arxiv:hep-th/9711200v3) and not t review';
    const sent = '(a Witten or arxiv:hep-th/9711200) and not t review';
    const result = await runToolContract(getCitationSummaryTool, { query });
    const output = structured<{
      effectiveQuery: string;
      notice?: string;
      target: { query: string };
    }>(result);
    const expected = notice([['arxiv:hep-th/9711200v3', 'arxiv:hep-th/9711200']]);
    expect(output.effectiveQuery).toBe(sent);
    expect(output.target.query).toBe(sent);
    expect(output.notice).toBe(expected);
    expect(fullText(result)).toContain(`**Query:** ${sent}`);
    expect(fullText(result)).toContain(`Query: ${sent}`);
    expect(fullText(result)).toContain(expected);
    expect(h.requests.map((request) => request.params.get('facet_name')).sort()).toEqual([
      'citation-summary',
      'citations-by-year',
    ]);
    expect(h.requests.every((request) => request.params.get('q') === sent)).toBe(true);
  });

  it('cern_inspire_get_citation_summary keeps the zero-summary notice beside the rewrite', async () => {
    h.route('/literature/facets', facetResponder({ summary: zeroCitationSummaryBody() }));
    const result = await runToolContract(getCitationSummaryTool, { query: 'arxiv:1207.7214v2' });
    const output = structured<{ notice?: string }>(result);
    expect(output.notice).toContain(notice([['arxiv:1207.7214v2', 'arxiv:1207.7214']]));
    expect(output.notice).toContain('No citeable papers matched');
    expect(fullText(result)).toContain(output.notice);
  });

  it.each(['arxiv:1207.7214v2', 'eprint 1207.7214V2', '1207.7214v2'])(
    'cern_inspire_search_hepdata sends %s as written, with no version notice',
    async (query) => {
      h.route('/data', jsonResponse(dataPage()));
      const result = await runToolContract(searchHepdataTool, { query });
      expect(result.isError).toBeFalsy();
      expect(fullText(result)).not.toContain('version suffix');
      expect(h.requests.map((request) => request.params.get('q'))).toEqual([query]);
    },
  );

  it('cern_inspire_get_paper resolves an upper-case V version suffix as the bare ID', async () => {
    h.route(
      '/literature',
      jsonResponse(
        literaturePage([literatureMetadata({ arxiv_eprints: [{ value: '1207.7214' }] })]),
      ),
      { once: true },
    );
    h.route('/literature', jsonResponse(literaturePage([dossierMetadata(3)])));
    h.route('/data', jsonResponse(dataPage()));
    const result = await runToolContract(getPaperTool, { paper: '1207.7214V2' });
    expect(structured<{ resolvedAs: string }>(result).resolvedAs).toBe('arxiv');
    expect(h.requests[0]?.params.get('q')).toBe('arxiv:1207.7214');
  });
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
