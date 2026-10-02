/**
 * @fileoverview Tests for cern_inspire_search_literature through `runToolContract`
 * over an `InspireService` on a fake fetch: input validation and blank-as-unset
 * handling, request mapping, the handler's own error contracts, the required
 * enrichment on a zero-result page, an under-cap page, and capped pages, every
 * zero-hit and broad-match notice the design specifies, `format()` parity with
 * `structuredContent`, upstream text kept out of inline markdown slots, and the
 * shared upstream failure classes on the wire. No live network.
 * @module tests/tools/search-literature.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type RunToolContractOptions,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchLiteratureTool } from '@/mcp-server/tools/definitions/search-literature.tool.js';
import { describeFailureClasses } from '../fixtures/failure-suite.js';
import { MARKUP_AS_TEXT, MARKUP_FREE, PUBLISHER_MARKUP } from '../fixtures/inspire-markup.js';
import {
  emptyBody,
  htmlResponse,
  jsonResponse,
  literatureMetadata,
  literaturePage,
  sparseLiteratureMetadata,
} from '../fixtures/inspire-upstream.js';
import { type ServiceHarness, startHarness, stopHarness } from '../fixtures/service-harness.js';
import {
  bodyText,
  errorEnvelope,
  fullText,
  leaves,
  structured,
  type ToolResult,
} from '../fixtures/tool-result.js';

vi.mock('@/services/inspire/inspire-service.js', async (importOriginal) =>
  (await import('../fixtures/active-service.js')).withActiveService(await importOriginal()),
);

type Input = z.input<typeof searchLiteratureTool.input>;
type Output = z.infer<typeof searchLiteratureTool.output> & {
  appliedFilters: string;
  cap: number;
  nextPage?: number;
  notice?: string;
  shown: number;
  totalCount: number;
  truncated: boolean;
};

let h: ServiceHarness;

beforeEach(() => {
  h = startHarness();
});

afterEach(() => {
  stopHarness();
});

const run = (input: Input, options?: RunToolContractOptions) =>
  runToolContract(searchLiteratureTool, input, options);

/** A call with arguments the schema's input type would not accept, as a misbehaving client sends. */
const runRaw = (input: Record<string, unknown>) => run(input as Input);

const paper = (n: number, overrides: Parameters<typeof literatureMetadata>[0] = {}) =>
  literatureMetadata({
    control_number: 1000 + n,
    titles: [{ title: `Paper ${n}` }],
    ...overrides,
  });

const pageOf = (count: number, options: { next?: boolean; total?: number } = {}) =>
  literaturePage(
    Array.from({ length: count }, (_, i) => paper(i + 1)),
    options,
  );

const routePage = (body: unknown = pageOf(1)) => h.route('/literature', jsonResponse(body));

const lines = (result: ToolResult) => bodyText(result).split('\n');

const params = () => h.requests[0]?.params;

describe('input', () => {
  it('applies the defaults and sends only q, size, page, and fields', async () => {
    routePage();

    const result = await run({ query: 't higgs' });

    expect(result.isError).toBeFalsy();
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['fields', 'page', 'q', 'size']);
    expect(params()?.get('page')).toBe('1');
    expect(params()?.get('size')).toBe('10');
    expect(structured<Output>(result)).toMatchObject({ page: 1, size: 10, cap: 10 });
  });

  it('reads a blank string on every optional input as unset', async () => {
    routePage();

    const result = await run({
      query: 't higgs',
      sort: '',
      document_types: '',
      subjects: '',
      year_from: '',
      year_to: '',
      page: '',
      size: '',
    } as Input);

    expect(result.isError).toBeFalsy();
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['fields', 'page', 'q', 'size']);
    expect(params()?.get('page')).toBe('1');
    expect(params()?.get('size')).toBe('10');
    expect(structured<Output>(result).appliedFilters).toBe('none');
  });

  it('reads empty arrays for the facet filters as unset', async () => {
    routePage();

    await run({ query: 't higgs', document_types: [], subjects: [] });

    expect(h.requests[0]?.names).not.toContain('doc_type');
    expect(h.requests[0]?.names).not.toContain('subject');
  });

  it('trims the query before sending it', async () => {
    routePage();

    await run({ query: '   t higgs and topcite 500+  ' });

    expect(params()?.get('q')).toBe('t higgs and topcite 500+');
  });

  it('accepts a query of exactly 1000 characters', async () => {
    routePage();

    const result = await run({ query: 'x'.repeat(1000) });

    expect(result.isError).toBeFalsy();
    expect(params()?.get('q')).toHaveLength(1000);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing query', {}],
    ['an empty query', { query: '' }],
    ['a whitespace-only query', { query: '   \t ' }],
    ['a query over 1000 characters', { query: 'x'.repeat(1001) }],
    ['an unknown sort', { query: 'x', sort: 'newest' }],
    ['a differently cased sort', { query: 'x', sort: 'MostCited' }],
    ['size 0', { query: 'x', size: 0 }],
    ['size 101', { query: 'x', size: 101 }],
    ['a fractional size', { query: 'x', size: 2.5 }],
    ['a size given as text', { query: 'x', size: '10' }],
    ['page 0', { query: 'x', page: 0 }],
    ['a negative page', { query: 'x', page: -1 }],
    ['year_from 1899', { query: 'x', year_from: 1899 }],
    ['year_to 2101', { query: 'x', year_to: 2101 }],
    ['a fractional year', { query: 'x', year_from: 2012.5 }],
    ['an unknown document type', { query: 'x', document_types: ['preprint'] }],
    ['five document types', { query: 'x', document_types: 'article,published,review,thesis,note' }],
    ['an unknown subject', { query: 'x', subjects: 'Chemistry' }],
    [
      'five subjects',
      { query: 'x', subjects: ['Theory-HEP', 'Lattice', 'Computing', 'Other', 'Unknown'] },
    ],
    ['a non-string document type entry', { query: 'x', document_types: [1] }],
  ])('rejects %s as InvalidParams without calling INSPIRE', async (_label, input) => {
    const result = await runRaw(input);

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('cern_inspire_search_literature');
    expect(h.requests).toHaveLength(0);
  });

  it.each([
    ['size 1', { size: 1 }, 'size', '1'],
    ['size 100', { size: 100 }, 'size', '100'],
    ['page 100 with size 100', { page: 100, size: 100 }, 'page', '100'],
  ])('accepts %s', async (_label, extra, name, expected) => {
    routePage();

    const result = await run({ query: 'x', ...extra });

    expect(result.isError).toBeFalsy();
    expect(params()?.get(name)).toBe(expected);
  });

  it('keeps document_types and subjects within four entries', async () => {
    routePage();

    const result = await run({
      query: 'x',
      document_types: 'article, published, review, thesis',
      subjects: ['Theory-HEP', 'Lattice', 'Computing', 'Other'],
    });

    expect(result.isError).toBeFalsy();
    expect(params()?.getAll('doc_type')).toEqual(['article', 'published', 'review', 'thesis']);
    expect(params()?.getAll('subject')).toEqual(['Theory-HEP', 'Lattice', 'Computing', 'Other']);
  });
});

describe('request mapping', () => {
  it('omits sort for relevance and sends mostrecent and mostcited as given', async () => {
    routePage();
    await run({ query: 'x', sort: 'relevance' });
    await run({ query: 'x', sort: 'mostrecent' });
    await run({ query: 'x', sort: 'mostcited' });

    expect(h.requests.map((r) => r.params.get('sort'))).toEqual([null, 'mostrecent', 'mostcited']);
  });

  it('splits a comma-joined document_types string, folds case, and drops repeats', async () => {
    routePage();

    await run({ query: 'x', document_types: ' Published , REVIEW,published,, ' });

    expect(params()?.getAll('doc_type')).toEqual(['published', 'review']);
  });

  it('folds subject case to the canonical spelling', async () => {
    routePage();

    await run({ query: 'x', subjects: ['theory-hep', 'EXPERIMENT-HEP'] });

    expect(params()?.getAll('subject')).toEqual(['Theory-HEP', 'Experiment-HEP']);
  });

  it.each([
    ['both bounds', { year_from: 2012, year_to: 2015 }, '2012--2015'],
    ['year_from alone', { year_from: 2012 }, '2012--'],
    ['year_to alone', { year_to: 1990 }, '--1990'],
    ['equal bounds', { year_from: 2020, year_to: 2020 }, '2020--2020'],
    ['the widest range', { year_from: 1900, year_to: 2100 }, '1900--2100'],
  ])('sends earliest_date for %s', async (_label, years, expected) => {
    routePage();

    const result = await run({ query: 'x', ...years });

    expect(result.isError).toBeFalsy();
    expect(params()?.get('earliest_date')).toBe(expected);
  });

  it('sends no earliest_date without a year bound', async () => {
    routePage();

    await run({ query: 'x' });

    expect(h.requests[0]?.names).not.toContain('earliest_date');
  });
});

describe('declared error contracts', () => {
  it('declares exactly the six reasons the design lists, with tool-specific recovery text', () => {
    const errors = searchLiteratureTool.errors ?? [];

    expect(errors.map((e) => e.reason)).toEqual([
      'beyond_result_window',
      'invalid_year_range',
      'invalid_query',
      'inspire_rate_limited',
      'pacer_shed',
      'upstream_unreadable',
    ]);
    expect(errors.find((e) => e.reason === 'invalid_query')?.recovery).toContain(
      'cern_inspire_search_literature',
    );
    expect(errors.find((e) => e.reason === 'beyond_result_window')?.recovery).toContain(
      'cern_inspire_search_literature',
    );
    for (const reason of ['beyond_result_window', 'invalid_year_range', 'invalid_query']) {
      expect(errors.find((e) => e.reason === reason)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
      });
    }
  });

  it('routes an unreadable body to a later retry of the same page and size, never a smaller size that shifts the page', () => {
    const unreadable = searchLiteratureTool.errors?.find((e) => e.reason === 'upstream_unreadable');

    expect(unreadable?.recovery).toBe(
      'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_search_literature with the same page and size.',
    );
  });

  it('fails year_from later than year_to as invalid_year_range, before any request', async () => {
    const result = await run({ query: 'x', year_from: 2020, year_to: 2010 });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_year_range');
    expect(error.message).toBe('year_from (2020) is later than year_to (2010).');
    expect(error.data?.recovery?.hint).toBe(
      'Swap year_from and year_to so the range runs forward, or drop one bound for an open range, then retry this call.',
    );
    expect(fullText(result)).toContain('Recovery: Swap year_from and year_to');
    expect(fullText(result)).toContain('reason invalid_year_range');
    expect(h.requests).toHaveLength(0);
  });

  it('accepts year_from one year before year_to and the equal-year range', async () => {
    routePage();

    expect((await run({ query: 'x', year_from: 2019, year_to: 2020 })).isError).toBeFalsy();
    expect((await run({ query: 'x', year_from: 2020, year_to: 2020 })).isError).toBeFalsy();
  });

  it('fails page × size over 10,000 as beyond_result_window, before any request', async () => {
    const result = await run({ query: 'x', page: 101, size: 100 });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('beyond_result_window');
    expect(error.data).toMatchObject({ page: 101, size: 100 });
    expect(error.message).toContain('page 101 × size 100');
    expect(error.data?.recovery?.hint).toContain('Narrow the query with year_from/year_to');
    expect(fullText(result)).toContain('reason beyond_result_window');
    expect(h.requests).toHaveLength(0);
  });

  it.each([
    [100, 100, false],
    [101, 100, true],
    [10_000, 1, false],
    [10_001, 1, true],
    [201, 50, true],
    [200, 50, false],
  ])('page %i × size %i: past the window is %s', async (page, size, rejected) => {
    routePage(emptyBody());

    const result = await run({ query: 'x', page, size });

    expect(result.isError === true).toBe(rejected);
    expect(h.requests).toHaveLength(rejected ? 0 : 1);
  });

  it('reports the year range before the result window when both fail', async () => {
    const error = errorEnvelope(
      await run({ query: 'x', year_from: 2020, year_to: 2010, page: 500, size: 100 }),
    );

    expect(error.data?.reason).toBe('invalid_year_range');
  });

  it('attaches the contract reason through a direct handler call as well', async () => {
    const ctx = createMockContext({ errors: searchLiteratureTool.errors });
    const input = searchLiteratureTool.input.parse({ query: 'x', page: 101, size: 100 });

    await expect(searchLiteratureTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'beyond_result_window' },
    });
  });
});

describe('required enrichment', () => {
  it('writes every required field on a zero-result page', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'zzzz nothing' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      papers: [],
      page: 1,
      size: 10,
      hasMore: false,
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 10,
      appliedFilters: 'none',
    });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBeTypeOf('string');
    expect(fullText(result)).toContain('**0 total**');
    expect(fullText(result)).toContain('**Applied filters:** none');
  });

  it('echoes the filters and sort on a zero-result page', async () => {
    routePage(emptyBody());

    const out = structured<Output>(
      await run({
        query: 't zzzz',
        sort: 'mostcited',
        document_types: 'published',
        subjects: 'theory-hep',
        year_from: 2012,
        year_to: 2015,
        size: 25,
      }),
    );

    expect(out.appliedFilters).toBe(
      'sort=mostcited; document_types=published; subjects=Theory-HEP; years=2012–2015',
    );
    expect(out).toMatchObject({ cap: 25, shown: 0, totalCount: 0, truncated: false });
  });

  it('writes every required field on an under-cap page and sets no notice or next page', async () => {
    routePage(pageOf(3));

    const result = await run({ query: 't higgs', size: 10 });

    const out = structured<Output>(result);
    expect(out.papers).toHaveLength(3);
    expect(out).toMatchObject({
      hasMore: false,
      totalCount: 3,
      truncated: false,
      shown: 3,
      cap: 10,
      appliedFilters: 'none',
    });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBeUndefined();
    expect(fullText(result)).toContain('**3 total**');
    expect(fullText(result)).not.toContain('Next page');
  });

  it('keeps a page of exactly size results under the cap when INSPIRE has no next link', async () => {
    routePage(pageOf(10));

    const out = structured<Output>(await run({ query: 't higgs', size: 10 }));

    expect(out).toMatchObject({ shown: 10, cap: 10, truncated: false, totalCount: 10 });
    expect(out.notice).toBeUndefined();
  });

  it('reports the match total, not the page length, as totalCount', async () => {
    routePage(pageOf(2, { total: 8_400 }));

    const out = structured<Output>(await run({ query: 't higgs', size: 5 }));

    expect(out).toMatchObject({ totalCount: 8_400, shown: 2, cap: 5, truncated: false });
  });

  it('marks a page with a next link truncated and points at the next page', async () => {
    routePage(pageOf(10, { next: true, total: 250 }));

    const result = await run({ query: 't higgs' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      hasMore: true,
      truncated: true,
      shown: 10,
      cap: 10,
      totalCount: 250,
      nextPage: 2,
      notice: 'More results: request page 2 for the next 10.',
    });
    expect(fullText(result)).toContain('**Next page:** 2');
    expect(fullText(result)).toContain('More results: request page 2 for the next 10.');
  });

  it('counts the next page from the requested page', async () => {
    routePage(pageOf(5, { next: true, total: 900 }));

    const out = structured<Output>(await run({ query: 't higgs', page: 7, size: 5 }));

    expect(out.nextPage).toBe(8);
    expect(out.notice).toBe('More results: request page 8 for the next 5.');
    expect(params()?.get('page')).toBe('7');
  });

  it('offers the last reachable next page at the 10,000-result window edge', async () => {
    routePage(pageOf(100, { next: true, total: 50_000 }));

    const out = structured<Output>(await run({ query: 't higgs', page: 99, size: 100 }));

    expect(out.nextPage).toBe(100);
    expect(out.notice).toBe('More results: request page 100 for the next 100.');
  });

  it('withholds the next page when it would cross the window and says to narrow the query', async () => {
    routePage(pageOf(100, { next: true, total: 50_000 }));

    const out = structured<Output>(await run({ query: 't higgs', page: 100, size: 100 }));

    expect(out.truncated).toBe(true);
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toContain('INSPIRE serves only the first 10,000 results of a query');
    expect(out.notice).toContain('narrow it with year_from/year_to');
    expect(out.notice).not.toContain('request page');
  });
});

describe('zero-hit notice', () => {
  const notice = async (input: Input) => {
    routePage(emptyBody());
    const out = structured<Output>(await run(input));
    return out.notice ?? '';
  };

  const BARE =
    'Bare words search all fields; use "t WORDS" for titles or "a NAME" for authors — see cern_inspire_list_reference topic search_syntax.';
  const BAI =
    'Author BAIs are exact and case-sensitive, and usually spell out the first name (Jane.Doe.1, not J.Doe.1); resolve the person with cern_inspire_search_authors.';

  it('always names the query', async () => {
    expect(await notice({ query: 't zzzz' })).toBe('No INSPIRE literature matched "t zzzz".');
  });

  it('echoes a wildcard query as written on both surfaces, so it can be sent again', async () => {
    routePage(emptyBody());

    const result = await run({ query: 't higgs*' });

    expect(structured<Output>(result).notice).toBe('No INSPIRE literature matched "t higgs*".');
    expect(fullText(result)).toContain('No INSPIRE literature matched "t higgs*".');
  });

  it('still escapes a link- or HTML-shaped query in the echo', async () => {
    routePage(emptyBody());

    const result = await run({ query: 't [x](javascript:alert(1)) <b>' });

    expect(structured<Output>(result).notice).toBe(
      'No INSPIRE literature matched "t \\[x\\](javascript:alert(1)) &lt;b>".',
    );
    expect(fullText(result)).toContain('"t \\[x\\](javascript:alert(1)) &lt;b>"');
    expect(fullText(result)).not.toContain('[x](');
    expect(fullText(result)).not.toContain('<b>');
  });

  it.each([
    ['a comparison', 't zzqqxx and date > 2015'],
    ['an arrow', 'affine zzqqxxwv -> nothing'],
    ['a reaction', 't P P --> ZZQQXX X'],
    ['a less-than before a number', 't zzqqxx and date < 2015'],
  ])('echoes %s as written on both surfaces, so it can be sent again', async (_label, query) => {
    routePage(emptyBody());

    const result = await run({ query });

    const notice = structured<Output>(result).notice ?? '';
    expect(notice).toContain(`No INSPIRE literature matched "${query}".`);
    expect(notice).not.toMatch(/&[a-z]+;/);
    expect(fullText(result)).toContain(`No INSPIRE literature matched "${query}".`);
  });

  it('adds the bare-words hint for a query with no field operator', async () => {
    expect(await notice({ query: 'zzzz nothing' })).toBe(
      `No INSPIRE literature matched "zzzz nothing". ${BARE}`,
    );
  });

  it('spells the bare-words placeholders in capitals on both surfaces, never as HTML-shaped tags', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'zzzz nothing' });

    expect(structured<Output>(result).notice).not.toMatch(/<[A-Za-z]|&[a-z]+;/);
    expect(fullText(result)).toContain('use "t WORDS" for titles or "a NAME" for authors');
    expect(fullText(result)).not.toMatch(/<[A-Za-z]/);
  });

  it('adds the filter fragment, listing the facet filters but not the sort', async () => {
    const text = await notice({
      query: 't zzzz',
      sort: 'mostcited',
      document_types: ['published', 'review'],
      year_from: 2012,
      year_to: 2015,
    });

    expect(text).toBe(
      'No INSPIRE literature matched "t zzzz". Filters narrowed the set (document_types=published,review; years=2012–2015); drop them to widen — multiple document_types or subjects must all hold.',
    );
  });

  it('does not add the filter fragment for a sort alone', async () => {
    expect(await notice({ query: 't zzzz', sort: 'mostrecent' })).toBe(
      'No INSPIRE literature matched "t zzzz".',
    );
  });

  it.each([
    ['a subjects filter', { subjects: 'Lattice' }],
    ['year_from alone', { year_from: 2030 }],
    ['year_to alone', { year_to: 1950 }],
  ])('adds the filter fragment for %s', async (_label, filters) => {
    expect(await notice({ query: 't zzzz', ...filters })).toContain('Filters narrowed the set (');
  });

  it('adds the BAI hint for an author query with a BAI-shaped token, and no bare-words hint', async () => {
    expect(await notice({ query: 'a J.Doe.1' })).toBe(
      `No INSPIRE literature matched "a J.Doe.1". ${BAI}`,
    );
  });

  it('adds the BAI hint for exactauthor: with a BAI', async () => {
    expect(await notice({ query: 'exactauthor:J.Doe.1' })).toContain(BAI);
  });

  it.each([
    ['a title query holding a BAI-shaped token', 't J.Doe.1'],
    ['an author query with a plain name', 'a Doe, Jane'],
    ['a bare BAI', 'J.Doe.1'],
  ])('does not add the BAI hint for %s', async (_label, query) => {
    expect(await notice({ query })).not.toContain('Author BAIs are exact');
  });

  it('combines the filter, bare-words, and BAI fragments in the design order', async () => {
    const text = await notice({ query: 'find J.Doe.1', subjects: 'Lattice' });

    expect(text.indexOf('Filters narrowed')).toBeGreaterThan(-1);
    expect(text.indexOf('Filters narrowed')).toBeLessThan(text.indexOf('Bare words'));
    expect(text).not.toContain('Author BAIs');
  });

  it.each([
    ['higgs boson', true],
    ['a', true],
    ['higgs t', true],
    ['higgs t boson', true],
    ['t higgs', false],
    ['T Higgs', false],
    ['a Doe, J', false],
    ['au Doe', false],
    ['cn atlas', false],
    ['date > 2015', false],
    ['topcite 500+', false],
    ['eprint 1207.7214', false],
    ['higgs and t boson', false],
    ['higgs or not a witten', false],
    ['find a witten', false],
    ['(t higgs) or (a witten)', false],
    ['refersto:recid:451647', false],
    ['collaboration:atlas', false],
    ['authors.recid:1000001', false],
    ['aff CERN', false],
    ['af CERN', false],
    ['affiliation CERN', false],
    ['affid:902725', false],
    ['affil CERN', false],
    ['inst CERN', false],
    ['institution CERN', false],
    ['zzqq and inst zzqqxxwv', false],
    ['affiliation-id:902725', false],
    ['(affiliation-id:902725)', false],
    ['higgs aff', true],
    ['affine connection zzqq', true],
    ['afterglow zzqq', true],
    ['instanton zzqq', true],
    ['institutional zzqq', true],
    ['af-ter zzqq', true],
  ])('query %j is %s as bare words', async (query, bare) => {
    const text = await notice({ query });

    expect(text.includes('Bare words search all fields')).toBe(bare);
  });

  it('reports a page past the end alone: the query and filters did match', async () => {
    routePage(literaturePage([], { total: 25 }));

    const result = await run({
      query: 'zzzz bare',
      page: 5,
      size: 10,
      document_types: 'published',
    });

    const out = structured<Output>(result);
    expect(out.notice).toBe('Page 5 is past the last page (3); request a lower page.');
    expect(out).toMatchObject({
      totalCount: 25,
      shown: 0,
      cap: 10,
      truncated: false,
      hasMore: false,
      papers: [],
    });
  });

  it('rounds the last page up when the total is not a multiple of size', async () => {
    routePage(literaturePage([], { total: 21 }));

    const out = structured<Output>(await run({ query: 't x', page: 9, size: 10 }));

    expect(out.notice).toBe('Page 9 is past the last page (3); request a lower page.');
  });

  it('echoes the query through inline(): newlines flatten and brackets are escaped', async () => {
    routePage(emptyBody());

    const result = await run({ query: 't higgs\r\n# injected\n[x](http://evil) <b>' });

    const text = structured<Output>(result).notice ?? '';
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('t higgs # injected \\[x\\](http://evil) &lt;b>');
    expect(fullText(result)).not.toMatch(/^# injected/m);
  });
});

describe('broad-match notice', () => {
  it('stays silent at exactly 100,000 matches', async () => {
    routePage(pageOf(3, { total: 100_000 }));

    expect(structured<Output>(await run({ query: 'a:' })).notice).toBeUndefined();
  });

  it('warns above 100,000 matches, naming the total and the syntax reference', async () => {
    routePage(pageOf(3, { total: 100_001 }));

    const result = await run({ query: 'a:' });

    const out = structured<Output>(result);
    expect(out.notice).toBe(
      "This query matched 100,001 of INSPIRE's ~1.9 M records. INSPIRE does not reject malformed syntax (an unparsed operator widens the match), so check the query against cern_inspire_list_reference topic search_syntax.",
    );
    expect(out.truncated).toBe(false);
    expect(fullText(result)).toContain('This query matched 100,001');
  });

  it('puts the next-page line first when a broad match is also paged', async () => {
    routePage(pageOf(10, { next: true, total: 1_500_000 }));

    const out = structured<Output>(await run({ query: 'a:' }));

    expect(out.truncated).toBe(true);
    expect(out.nextPage).toBe(2);
    expect(
      out.notice?.startsWith(
        'More results: request page 2 for the next 10. This query matched 1,500,000',
      ),
    ).toBe(true);
  });

  it('keeps the broad-match line when the window blocks the next page', async () => {
    routePage(pageOf(100, { next: true, total: 1_500_000 }));

    const out = structured<Output>(await run({ query: 'a:', page: 100, size: 100 }));

    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toContain('INSPIRE serves only the first 10,000');
    expect(out.notice).toContain('This query matched 1,500,000');
  });

  it('does not add the broad-match line to a page past the end', async () => {
    routePage(literaturePage([], { total: 500_000 }));

    const out = structured<Output>(await run({ query: 't x', page: 3, size: 10 }));

    expect(out.notice).toBe('Page 3 is past the last page (50000); request a lower page.');
  });
});

describe('papers and format() parity', () => {
  const richAbstract = 'A search for the Standard Model Higgs boson in proton-proton collisions.';

  it('returns each paper in the schema shape and renders every value into content[]', async () => {
    routePage(
      literaturePage([
        paper(1, { abstracts: [{ source: 'arXiv', value: richAbstract }] }),
        paper(2, { citation_count: 7, document_type: ['article', 'published'] }),
      ]),
    );

    const result = await run({ query: 't higgs' });

    const out = structured<Output>(result);
    expect(out).toEqual(expect.schemaMatching(searchLiteratureTool.output));
    const text = bodyText(result);
    for (const leaf of leaves(out.papers)) expect(text).toContain(String(leaf));
    expect(text).toContain('**More pages:** no');
    expect(text).toContain('**Papers on this page:** 2');
  });

  it('renders the facts of one paper into labelled lines', async () => {
    routePage(
      literaturePage([paper(1, { abstracts: [{ source: 'arXiv', value: richAbstract }] })]),
    );

    const text = bodyText(await run({ query: 't higgs' }));

    expect(text).toContain('## INSPIRE literature, page 1');
    expect(text).toContain('### 1. Paper 1');
    expect(text).toContain(
      '**recid:** 1001 · **Date:** 2012-09-17 · **Citations:** 12345 (11800 without self-citations)',
    );
    expect(text).toContain(
      '**First author:** Doe, Jane (author recid 1000001) · **Authors:** 2932',
    );
    expect(text).toContain('**Collaborations:** ATLAS');
    expect(text).toContain('**Document types:** article');
    expect(text).toContain(
      '**arXiv:** 1207.7214 (hep-ex) · **DOI:** 10.1016/j.physletb.2012.08.020 · **Publication:** Phys.Lett.B 716 (2012) 1-29',
    );
    expect(text).toContain(`**Abstract:**\n> ${richAbstract}`);
  });

  it('prints the arXiv ID and DOI as written, their *, _, and ~ unescaped, so they copy back', async () => {
    routePage(
      literaturePage([
        paper(1, {
          arxiv_eprints: [{ value: '1207.7214', categories: ['hep-ex'] }],
          dois: [{ value: '10.1234/_a*(1)~' }],
        }),
      ]),
    );

    const result = await run({ query: 't higgs' });

    expect(structured<Output>(result).papers[0]?.doi).toBe('10.1234/_a*(1)~');
    expect(bodyText(result)).toContain('**arXiv:** 1207.7214 (hep-ex) · **DOI:** 10.1234/_a*(1)~');
  });

  it('numbers papers from the page offset', async () => {
    routePage(pageOf(2, { next: true, total: 40 }));

    const text = bodyText(await run({ query: 't higgs', page: 3, size: 10 }));

    expect(text).toContain('## INSPIRE literature, page 3');
    expect(text).toContain('### 21. Paper 1');
    expect(text).toContain('### 22. Paper 2');
    expect(text).toContain('**More pages:** yes');
  });

  it('renders a sparse 1961 record with Not available instead of invented values', async () => {
    routePage(literaturePage([sparseLiteratureMetadata()]));

    const result = await run({ query: 'weak interactions' });

    const out = structured<Output>(result);
    const [only] = out.papers;
    expect(only).toEqual({
      recid: '1000',
      title: 'Partial symmetries of weak interactions',
      collaborations: [],
      date: '1961',
      documentTypes: ['article'],
      citationCount: 0,
      arxivCategories: [],
      publication: 'Nucl.Phys. 22 (1961) 579-588',
    });
    const text = bodyText(result);
    expect(text).toContain('**First author:** Not available · **Authors:** Not available');
    expect(text).toContain('**Citations:** 0');
    expect(text).toContain('**Publication:** Nucl.Phys. 22 (1961) 579-588');
    expect(text).not.toContain('**arXiv:**');
    expect(text).not.toContain('**DOI:**');
    expect(text).not.toContain('**Collaborations:**');
    expect(text).not.toContain('**Abstract');
    expect(text).not.toContain('without self-citations');
  });

  it('keeps an author without a recid and a paper without a title honest', async () => {
    routePage(literaturePage([paper(1, { first_author: { full_name: 'Doe, Jane' }, titles: [] })]));

    const result = await run({ query: 't x' });

    const text = bodyText(result);
    expect(text).toContain('### 1. (untitled)');
    expect(text).toContain('**First author:** Doe, Jane · **Authors:** 2932');
    expect(text).not.toContain('author recid');
    expect(structured<Output>(result).papers[0]?.title).toBe('');
  });

  it('labels a truncated abstract snippet and leaves the cut at a word boundary', async () => {
    const abstract = `${'quark '.repeat(80)}end`;
    routePage(literaturePage([paper(1, { abstracts: [{ source: 'arXiv', value: abstract }] })]));

    const result = await run({ query: 't x' });

    const [only] = structured<Output>(result).papers;
    expect(only?.abstractTruncated).toBe(true);
    expect(only?.abstractSnippet?.length).toBeLessThanOrEqual(300);
    expect(only?.abstractSnippet).toMatch(/quark$/);
    expect(bodyText(result)).toContain(
      '**Abstract** (truncated; cern_inspire_get_paper has it in full):',
    );
  });

  it('prefers the arXiv-sourced abstract for the snippet', async () => {
    routePage(
      literaturePage([
        paper(1, {
          abstracts: [
            { source: 'Elsevier', value: 'Publisher abstract.' },
            { source: 'arXiv', value: 'Preprint abstract.' },
          ],
        }),
      ]),
    );

    const [only] = structured<Output>(await run({ query: 't x' })).papers;

    expect(only?.abstractSnippet).toBe('Preprint abstract.');
  });

  it('renders no content blocks other than text', async () => {
    routePage(pageOf(1));

    const result = await run({ query: 't x' });

    expect(result.content.every((block) => block.type === 'text')).toBe(true);
  });
});

describe('publisher markup in titles and abstracts', () => {
  it('converts a MathML title and a JATS abstract on both surfaces, cutting the snippet from the text', async () => {
    routePage(
      literaturePage([
        paper(1, {
          titles: [{ title: PUBLISHER_MARKUP.aps1331113Title }],
          abstracts: [{ source: 'APS', value: PUBLISHER_MARKUP.aps1316657Abstract }],
        }),
      ]),
    );

    const result = await run({ query: 't x' });

    const [only] = structured<Output>(result).papers;
    const abstract = MARKUP_AS_TEXT.aps1316657Abstract;
    const snippet = only?.abstractSnippet ?? '';
    expect(only?.title).toBe(MARKUP_AS_TEXT.aps1331113Title);
    expect(only?.abstractTruncated).toBe(true);
    expect(abstract.startsWith(snippet)).toBe(true);
    expect(snippet.length).toBeGreaterThan(290);
    expect(snippet.length).toBeLessThanOrEqual(300);
    expect(abstract.charAt(snippet.length)).toBe(' ');
    const text = bodyText(result);
    expect(text).toContain(
      '### 1. Erratum: High-spin spectroscopy of ^{144}Tb: Systematic investigation of dipole bands in N=79 isotones \\[Phys. Rev. C 89, 054309 (2014)\\]',
    );
    expect(text).toContain(
      `**Abstract** (truncated; cern_inspire_get_paper has it in full):\n> ${snippet}`,
    );
    expect(text).toContain(
      '> Prompt thermal neutron capture γ-ray cross sections σ_γ were measured',
    );
    expect(text).not.toContain('&lt;');
  });

  it('measures the snippet cap on the converted text, so markup alone never truncates it', async () => {
    const markup = `<p><inline-formula><mml:math><mml:mi>γ</mml:mi></mml:math></inline-formula>-ray ${'word '.repeat(55)}end</p>`;
    const converted = `γ-ray ${'word '.repeat(55)}end`;
    expect(markup.length).toBeGreaterThan(300);
    routePage(literaturePage([paper(1, { abstracts: [{ source: 'APS', value: markup }] })]));

    const result = await run({ query: 't x' });

    const [only] = structured<Output>(result).papers;
    expect(only?.abstractSnippet).toBe(converted);
    expect(only?.abstractTruncated).toBe(false);
    expect(bodyText(result)).toContain(`**Abstract:**\n> ${converted}`);
  });

  it('renders a title that is only markup as untitled and leaves out an abstract that is only markup', async () => {
    routePage(
      literaturePage([
        paper(1, {
          titles: [{ title: '<i> </i>' }],
          abstracts: [{ source: 'APS', value: '<p> </p><p><inline-graphic/></p>' }],
        }),
      ]),
    );

    const result = await run({ query: 't x' });

    const [only] = structured<Output>(result).papers;
    expect(only?.title).toBe('');
    expect(only?.abstractSnippet).toBeUndefined();
    const text = bodyText(result);
    expect(text).toContain('### 1. (untitled)');
    expect(text).not.toContain('**Abstract');
  });

  it('decodes entities once and still escapes the angle brackets and links decoding produces', async () => {
    routePage(
      literaturePage([
        paper(1, {
          titles: [
            {
              title:
                '&lt;script&gt;alert(1)&lt;/script&gt; <i>[click](http://evil.example)</i> &amp;lt;b&amp;gt;',
            },
          ],
        }),
      ]),
    );

    const result = await run({ query: 't x' });

    expect(structured<Output>(result).papers[0]?.title).toBe(
      '<script>alert(1)</script> [click](http://evil.example) &lt;b&gt;',
    );
    const text = bodyText(result);
    expect(text).toContain(
      '### 1. &lt;script&gt;alert(1)&lt;/script&gt; \\[click\\](http://evil.example) &lt;b&gt;',
    );
    expect(text).not.toContain('<script>');
  });

  it('keeps markup-free LaTeX as received in structuredContent and escapes only what could form emphasis in content[]', async () => {
    const abstract = 'Nb$_{3}$Sn and Nb$_{3}$Sn coils reach $p_T$ of 5 GeV.';
    routePage(
      literaturePage([
        paper(1, {
          titles: [{ title: MARKUP_FREE.aps2098257Title }],
          abstracts: [{ source: 'arXiv', value: abstract }],
        }),
      ]),
    );

    const result = await run({ query: 't x' });

    const [only] = structured<Output>(result).papers;
    expect(only?.title).toBe(MARKUP_FREE.aps2098257Title);
    expect(only?.abstractSnippet).toBe(abstract);
    const text = bodyText(result);
    expect(text).toContain(
      '### 1. Measurement of the $\\nu_e-$Nucleus Charged-Current Double-Differential Cross Section at $\\left&lt; E\\_{\\nu} \\right&gt; = $ 2.4 GeV using NOvA',
    );
    expect(text).toContain('> Nb$\\_{3}$Sn and Nb$\\_{3}$Sn coils reach $p_T$ of 5 GeV.');
  });
});

describe('upstream text stays out of inline markdown slots', () => {
  const LS = String.fromCharCode(0x2028);
  const NEL = String.fromCharCode(0x85);
  const hostile = (field: string) => `${field}\r\n# Injected heading\n**Citations:** 999999`;

  it('flattens line breaks in every inline field and keeps structuredContent verbatim', async () => {
    const title = `Line one\r\n## Injected heading\nrest${LS}more${NEL}end`;
    routePage(
      literaturePage([
        paper(1, {
          titles: [{ title }],
          first_author: { full_name: hostile('Doe, Jane'), recid: 1000001 },
          collaborations: [{ value: hostile('ATLAS') }],
          document_type: [hostile('article')],
          arxiv_eprints: [{ value: '1207.7214', categories: [hostile('hep-ex')] }],
          dois: [{ value: hostile('10.1000/x') }],
          publication_info: [{ pubinfo_freetext: hostile('Nucl.Phys.') }],
          earliest_date: hostile('2012'),
        }),
      ]),
    );

    const result = await run({ query: 't x' });

    const [only] = structured<Output>(result).papers;
    expect(only?.title).toBe(title);
    expect(only?.firstAuthor?.name).toContain('\r\n# Injected heading');
    const body = lines(result);
    expect(body.filter((line) => line.startsWith('#'))).toEqual([
      '## INSPIRE literature, page 1',
      '### 1. Line one ## Injected heading rest more end',
    ]);
    expect(body.filter((line) => line.startsWith('**Citations:**'))).toEqual([]);
    expect(bodyText(result)).toContain(
      'Doe, Jane # Injected heading \\*\\*Citations:\\*\\* 999999',
    );
    expect(body.some((line) => line.trim() === '# Injected heading')).toBe(false);
  });

  it('escapes link brackets and angle brackets in titles and names', async () => {
    routePage(
      literaturePage([
        paper(1, {
          titles: [{ title: 'See [the paper](http://evil.example.org) <script>x</script>' }],
          first_author: { full_name: 'Doe [Jane] <J>', recid: 1000001 },
        }),
      ]),
    );

    const result = await run({ query: 't x' });

    const text = bodyText(result);
    expect(text).toContain(
      '### 1. See \\[the paper\\](http://evil.example.org) &lt;script&gt;x&lt;/script&gt;',
    );
    expect(text).toContain('Doe \\[Jane\\] &lt;J&gt;');
    expect(text).not.toContain('<script>');
    // <script> is outside the markup vocabulary, so it reaches format() as text and the escape above is real.
    expect(structured<Output>(result).papers[0]?.title).toBe(
      'See [the paper](http://evil.example.org) <script>x</script>',
    );
  });

  it('keeps every line of a multi-line abstract inside the blockquote', async () => {
    routePage(
      literaturePage([
        paper(1, {
          abstracts: [
            { source: 'arXiv', value: 'First.\n\n# Not a heading\r\n- not a bullet\n[x](y)' },
          ],
        }),
      ]),
    );

    const result = await run({ query: 't x' });

    const body = lines(result);
    const start = body.indexOf('**Abstract:**');
    expect(start).toBeGreaterThan(-1);
    const quoted = body.slice(start + 1);
    expect(quoted.length).toBeGreaterThanOrEqual(5);
    expect(quoted.every((line) => line.startsWith('>'))).toBe(true);
    expect(quoted.join('\n')).toContain('> # Not a heading');
    expect(quoted.join('\n')).toContain('> \\[x\\](y)');
  });
});

describe('result paging bookkeeping', () => {
  it('echoes page, size, and hasMore from the request and INSPIRE link', async () => {
    routePage(pageOf(4, { next: true, total: 41 }));

    const out = structured<Output>(await run({ query: 't x', page: 2, size: 4 }));

    expect(out).toMatchObject({ page: 2, size: 4, hasMore: true, shown: 4, cap: 4 });
  });
});

describeFailureClasses({
  label: 'cern_inspire_search_literature',
  contract: searchLiteratureTool.errors ?? [],
  invalidQuery: true,
  run: (options) => run({ query: 't higgs' }, options),
  install: (harness, reply) => harness.route('/literature', reply),
  unreadable: [
    ['an HTML page', () => htmlResponse()],
    ['truncated JSON', () => new Response('{"hits":{"total":', { status: 200 })],
    ['an empty body', () => new Response('', { status: 200 })],
    ['JSON without the search envelope', () => jsonResponse({ hits: {} })],
  ],
});
