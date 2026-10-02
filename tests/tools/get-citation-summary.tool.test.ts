/**
 * @fileoverview Tests for cern_inspire_get_citation_summary through
 * `runToolContract` over an `InspireService` on a fake fetch: the `author` |
 * `query` choice and the `missing_target` contract, every author identifier
 * form and the profile lookup behind it, the `author_not_identifier`,
 * `author_not_found`, and `invalid_year_range` contracts, the facet and
 * self-citation filters on the wire, blank-as-unset inputs, the required
 * enrichment on a zero-result summary and a populated one, the zero-summary
 * notices, `format()` parity with `structuredContent`, upstream text kept out of
 * inline markdown slots, and the shared upstream failure classes on both the
 * profile lookup and the summary request. No live network.
 * @module tests/tools/get-citation-summary.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type RunToolContractOptions,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCitationSummaryTool } from '@/mcp-server/tools/definitions/get-citation-summary.tool.js';
import type { RawCitationSummaryResponse } from '@/services/inspire/types.js';
import { describeFailureClasses } from '../fixtures/failure-suite.js';
import {
  authorMetadata,
  authorPage,
  badRequestBody,
  CAPTURED_SERIES,
  capturedResponse,
  citationSummaryBody,
  emptyBody,
  type FacetReply,
  facetResponder,
  hit,
  htmlResponse,
  jsonResponse,
  rateLimitResponse,
  searchBody,
  zeroCitationSummaryBody,
  zeroCitationsByYearBody,
} from '../fixtures/inspire-upstream.js';
import {
  hangingFetch,
  type ServiceHarness,
  settleWithFakeTimers,
  startHarness,
  stopHarness,
} from '../fixtures/service-harness.js';
import {
  bodyText,
  errorEnvelope,
  fullText,
  leaves,
  structured,
  type ToolResult,
  textBlocks,
} from '../fixtures/tool-result.js';

vi.mock('@/services/inspire/inspire-service.js', async (importOriginal) =>
  (await import('../fixtures/active-service.js')).withActiveService(await importOriginal()),
);

type Input = z.input<typeof getCitationSummaryTool.input>;
type Output = z.infer<typeof getCitationSummaryTool.output> & {
  appliedFilters: string;
  effectiveQuery: string;
  notice?: string;
};

let h: ServiceHarness;

beforeEach(() => {
  h = startHarness();
});

afterEach(() => {
  stopHarness();
});

const run = (input: Input, options?: RunToolContractOptions) =>
  runToolContract(getCitationSummaryTool, input, options);

/** A call with arguments the schema's input type would not accept, as a misbehaving client sends. */
const runRaw = (input: Record<string, unknown>) => run(input as Input);

/** Runs on fake timers: for calls whose failures walk the retry ladder. */
const runSettled = async (input: Input, options?: RunToolContractOptions) => {
  const outcome = await settleWithFakeTimers(() => run(input, options));
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
};

/** Answers the summary facet with `body` and the series facet with `series` (the captured multi-decade author). */
const routeSummary = (
  body: object = citationSummaryBody(),
  series: FacetReply = capturedResponse(CAPTURED_SERIES.multiDecadeAuthor),
) => h.route('/literature/facets', facetResponder({ summary: body, series }));

const routeAuthor = (body: unknown = authorPage()) => h.route('/authors', jsonResponse(body));

/** The summary body with `mutate` applied to a fresh copy of its `citation_summary` aggregation. */
const summary = (
  mutate: (
    aggregation: RawCitationSummaryResponse['aggregations']['citation_summary'],
    body: RawCitationSummaryResponse,
  ) => void,
): RawCitationSummaryResponse => {
  const body = citationSummaryBody();
  mutate(body.aggregations.citation_summary, body);
  return body;
};

const lines = (result: ToolResult) => bodyText(result).split('\n');

const requestsTo = (path: string) => h.requests.filter((r) => r.path === path);

const facetRequests = (facet: 'citation-summary' | 'citations-by-year') =>
  h.requests.filter((r) => r.params.get('facet_name') === facet);

/** The summary request's parameters (the first, when a test makes more than one call). */
const facetParams = () => facetRequests('citation-summary')[0]?.params;

/** The first ten characters of each body line: the markdown structure, not the upstream words. */
const shape = (result: ToolResult) => lines(result).map((line) => line.slice(0, 10));

const errors = getCitationSummaryTool.errors ?? [];
const hint = (reason: string) => errors.find((e) => e.reason === reason)?.recovery;

describe('the author | query choice', () => {
  it('sends a query straight to the facet request, with no profile lookup', async () => {
    routeSummary();

    const result = await run({ query: 'collaboration:atlas' });

    expect(result.isError).toBeFalsy();
    expect(h.requests.map((r) => r.path)).toEqual([
      '/api/literature/facets',
      '/api/literature/facets',
    ]);
    expect(h.requests.map((r) => r.params.get('facet_name')).sort()).toEqual([
      'citation-summary',
      'citations-by-year',
    ]);
    expect(facetParams()?.get('q')).toBe('collaboration:atlas');
    expect(structured<Output>(result).target).toEqual({
      kind: 'query',
      query: 'collaboration:atlas',
    });
  });

  it('resolves an author to a profile first, then summarizes authors.recid:<recid>', async () => {
    routeAuthor();
    routeSummary();

    const result = await run({ author: 'Jane.Doe.1' });

    expect(result.isError).toBeFalsy();
    expect(h.requests.map((r) => r.path)).toEqual([
      '/api/authors',
      '/api/literature/facets',
      '/api/literature/facets',
    ]);
    const lookup = h.requests[0]?.params;
    expect(lookup?.get('q')).toBe('ids.value:Jane.Doe.1');
    expect(lookup?.get('fields')).toBe('control_number,name');
    expect(lookup?.get('size')).toBe('1');
    expect(facetParams()?.get('q')).toBe('authors.recid:1000001');
    const out = structured<Output>(result);
    expect(out.target).toEqual({
      kind: 'author',
      authorRecid: '1000001',
      authorName: 'Doe, Jane',
      query: 'authors.recid:1000001',
    });
    expect(out.effectiveQuery).toBe('authors.recid:1000001');
  });

  it('trims the query and reports the trimmed text as the target and effective query', async () => {
    routeSummary();

    const out = structured<Output>(await run({ query: '   t neutrino oscillation  ' }));

    expect(facetParams()?.get('q')).toBe('t neutrino oscillation');
    expect(out.target.query).toBe('t neutrino oscillation');
    expect(out.effectiveQuery).toBe('t neutrino oscillation');
  });

  it('reads a blank query beside an author as unset', async () => {
    routeAuthor();
    routeSummary();

    const result = await run({ author: 'Jane.Doe.1', query: '' });

    expect(result.isError).toBeFalsy();
    expect(structured<Output>(result).target.kind).toBe('author');
  });

  it('reads a whitespace-only query beside an author as unset', async () => {
    routeAuthor();
    routeSummary();

    const result = await run({ author: 'Jane.Doe.1', query: '   ' });

    expect(result.isError).toBeFalsy();
    expect(structured<Output>(result).target.kind).toBe('author');
  });

  it('reads a blank or whitespace-only author beside a query as unset', async () => {
    routeSummary();

    expect((await run({ author: '', query: 'collaboration:atlas' })).isError).toBeFalsy();
    expect((await run({ author: '   ', query: 'collaboration:atlas' })).isError).toBeFalsy();
    expect(requestsTo('/api/authors')).toHaveLength(0);
  });

  it('accepts a query of exactly 1000 characters and rejects 1001', async () => {
    routeSummary();

    expect((await run({ query: 'x'.repeat(1000) })).isError).toBeFalsy();
    const rejected = errorEnvelope(await run({ query: 'x'.repeat(1001) }));
    expect(rejected.code).toBe(JsonRpcErrorCode.InvalidParams);
  });

  it('gives an institution example for query: affid with an institution recid', () => {
    const description = getCitationSummaryTool.input.shape.query.description ?? '';

    expect(description).toContain('"affid:902725"');
    expect(description).toContain('institution');
  });
});

describe('missing_target', () => {
  it('declares the contract with the recovery naming every author identifier form', () => {
    expect(errors.find((e) => e.reason === 'missing_target')).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
    });
    expect(hint('missing_target')).toContain('cern_inspire_get_citation_summary');
    expect(hint('missing_target')).toContain('INSPIRE ID');
  });

  it.each<[string, Record<string, unknown>]>([
    ['neither input', {}],
    ['a blank author and a blank query', { author: '', query: '' }],
    ['a whitespace-only author and query', { author: '  ', query: '  ' }],
    ['only filters', { document_types: 'published', year_from: 2012 }],
  ])('fails %s as missing_target before any request', async (_label, input) => {
    const result = await runRaw(input);

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('missing_target');
    expect(error.message).toBe('Neither author nor query was given; pass exactly one.');
    expect(error.data?.recovery?.hint).toBe(hint('missing_target'));
    expect(fullText(result)).toContain('reason missing_target');
    expect(h.requests).toHaveLength(0);
  });

  it('fails both inputs as missing_target before any request', async () => {
    const result = await run({ author: 'Jane.Doe.1', query: 'collaboration:atlas' });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('missing_target');
    expect(error.message).toBe('Both author and query were given; pass exactly one.');
    expect(h.requests).toHaveLength(0);
  });

  it('reads an author name beside a query as both given, not as a name error', async () => {
    const error = errorEnvelope(await run({ author: 'Doe, Jane', query: 'x' }));

    expect(error.data?.reason).toBe('missing_target');
  });

  it('writes the required enrichment before the check fails, so the error path stays valid', async () => {
    const ctx = createMockContext({ errors: getCitationSummaryTool.errors });
    const input = getCitationSummaryTool.input.parse({});

    await expect(getCitationSummaryTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'missing_target' },
    });
  });
});

describe('author identifier forms', () => {
  it.each<[string, string, string]>([
    ['a BAI', 'Jane.Doe.1', 'ids.value:Jane.Doe.1'],
    ['a lower-case BAI, left as written', 'jane.doe.1', 'ids.value:jane.doe.1'],
    ['an ORCID', '0000-0000-0000-0001', 'ids.value:0000-0000-0000-0001'],
    [
      'a lower-case checksum x, upper-cased',
      '0000-0000-0000-000x',
      'ids.value:0000-0000-0000-000X',
    ],
    [
      'an orcid.org URL, reduced to the iD',
      'https://orcid.org/0000-0000-0000-0001',
      'ids.value:0000-0000-0000-0001',
    ],
    ['an INSPIRE ID', 'INSPIRE-00000001', 'ids.value:INSPIRE-00000001'],
    ['a lower-case INSPIRE ID, upper-cased', 'inspire-00000001', 'ids.value:INSPIRE-00000001'],
    ['an author recid', '1000001', 'control_number:1000001'],
    ['an author recid with surrounding blanks', '  1000001  ', 'control_number:1000001'],
  ])('looks %s up as q=%s', async (_label, author, q) => {
    routeAuthor();
    routeSummary();

    const result = await run({ author });

    expect(result.isError).toBeFalsy();
    expect(requestsTo('/api/authors')[0]?.params.get('q')).toBe(q);
    expect(facetParams()?.get('q')).toBe('authors.recid:1000001');
  });

  it('accepts an author recid sent as a JSON number, as some clients send it', async () => {
    routeAuthor();
    routeSummary();

    const result = await runRaw({ author: 1000001 });

    expect(result.isError).toBeFalsy();
    expect(requestsTo('/api/authors')[0]?.params.get('q')).toBe('control_number:1000001');
  });

  it('summarizes the recid the profile record carries, not the identifier given', async () => {
    routeAuthor(authorPage([authorMetadata({ control_number: 7654321 })]));
    routeSummary();

    const out = structured<Output>(await run({ author: 'Jane.Doe.1' }));

    expect(out.target.authorRecid).toBe('7654321');
    expect(facetParams()?.get('q')).toBe('authors.recid:7654321');
  });

  it('takes the recid from the hit id when the record carries no control number', async () => {
    routeAuthor(searchBody([hit({ name: { value: 'Doe, Jane' } }, '555')]));
    routeSummary();

    const out = structured<Output>(await run({ author: 'Jane.Doe.1' }));

    expect(out.target).toMatchObject({ authorRecid: '555', query: 'authors.recid:555' });
  });

  it('leaves the author name out, and labels the heading, when the profile has none', async () => {
    routeAuthor(authorPage([{ control_number: 9 }]));
    routeSummary();

    const result = await run({ author: '9' });

    expect(structured<Output>(result).target).toEqual({
      kind: 'author',
      authorRecid: '9',
      query: 'authors.recid:9',
    });
    expect(lines(result)[0]).toBe('## INSPIRE citation summary — (unnamed) (author recid 9)');
  });
});

describe('author_not_identifier', () => {
  it('declares the contract with the resolve-first recovery', () => {
    expect(errors.find((e) => e.reason === 'author_not_identifier')).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
    });
    expect(hint('author_not_identifier')).toContain('cern_inspire_search_authors');
  });

  it.each([
    ['a name with a comma', 'Doe, Jane'],
    ['a name without a comma', 'Jane Doe'],
    ['a bare surname', 'Doe'],
    ['ten digits, which are no recid', '1234567890'],
    ['an INSPIRE ID with too few digits', 'INSPIRE-0001'],
    ['an ORCID with a missing group', '0000-0000-0001'],
  ])('fails %s without calling INSPIRE', async (_label, author) => {
    const result = await run({ author });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('author_not_identifier');
    expect(error.data).toMatchObject({ author });
    expect(error.message).toContain(`author "${author}" is not a BAI, ORCID, INSPIRE ID`);
    expect(error.data?.recovery?.hint).toBe(hint('author_not_identifier'));
    expect(fullText(result)).toContain('reason author_not_identifier');
    expect(h.requests).toHaveLength(0);
  });

  it('echoes the author through callerEcho() in the message and keeps it verbatim in data', async () => {
    const author = 'Doe\r\n# injected\n[x](http://evil) <b>';

    const error = errorEnvelope(await run({ author }));

    expect(error.message).not.toMatch(/[\r\n]/);
    expect(error.message).toContain('Doe # injected \\[x\\](http://evil) &lt;b>');
    expect(error.data?.author).toBe(author);
  });

  it('echoes a wildcard name as written in the message on both surfaces', async () => {
    const result = await run({ author: 'Ellis*' });

    expect(errorEnvelope(result).message).toBe(
      'author "Ellis*" is not a BAI, ORCID, INSPIRE ID, or author recid.',
    );
    expect(fullText(result)).toContain('author "Ellis*" is not a BAI');
  });

  it('still escapes a link-shaped name in the content[] message', async () => {
    const result = await run({ author: '[x](javascript:alert(1))' });

    expect(fullText(result)).toContain('author "\\[x\\](javascript:alert(1))" is not a BAI');
    expect(fullText(result)).not.toContain('[x](');
  });
});

describe('author_not_found', () => {
  it('declares the contract with the resolve-first recovery', () => {
    expect(errors.find((e) => e.reason === 'author_not_found')).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      severity: 'notice',
    });
    expect(hint('author_not_found')).toContain('cern_inspire_search_authors');
  });

  it.each([
    ['a BAI', 'Jane.Doe.9', 'bai'],
    ['an ORCID', '0000-0000-0000-0009', 'orcid'],
    ['an INSPIRE ID', 'INSPIRE-00000009', 'inspire_id'],
    ['an author recid', '99999999', 'recid'],
  ])(
    'fails %s that matches no profile, without asking for a summary',
    async (_label, author, matchedAs) => {
      routeAuthor(emptyBody());
      routeSummary();

      const result = await run({ author });

      const error = errorEnvelope(result);
      expect(error.code).toBe(JsonRpcErrorCode.NotFound);
      expect(error.data?.reason).toBe('author_not_found');
      expect(error.data).toMatchObject({ author, matchedAs });
      expect(error.message).toBe(`No INSPIRE author profile matched "${author}" as ${matchedAs}.`);
      expect(error.data?.recovery?.hint).toBe(hint('author_not_found'));
      expect(fullText(result)).toContain('reason author_not_found');
      expect(requestsTo('/api/literature/facets')).toHaveLength(0);
    },
  );

  it('fails a profile hit that carries neither a control number nor an id', async () => {
    routeAuthor(searchBody([hit({ name: { value: 'Doe, Jane' } })]));

    const error = errorEnvelope(await run({ author: 'Jane.Doe.1' }));

    expect(error.data?.reason).toBe('author_not_found');
  });
});

describe('invalid_year_range', () => {
  it('declares the contract', () => {
    expect(errors.find((e) => e.reason === 'invalid_year_range')).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
    });
  });

  it('fails year_from later than year_to, before any request', async () => {
    const result = await run({ query: 'x', year_from: 2020, year_to: 2010 });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_year_range');
    expect(error.message).toBe('year_from (2020) is later than year_to (2010).');
    expect(error.data?.recovery?.hint).toBe(hint('invalid_year_range'));
    expect(fullText(result)).toContain('reason invalid_year_range');
    expect(h.requests).toHaveLength(0);
  });

  it('accepts one year before and the equal-year range', async () => {
    routeSummary();

    expect((await run({ query: 'x', year_from: 2019, year_to: 2020 })).isError).toBeFalsy();
    expect((await run({ query: 'x', year_from: 2020, year_to: 2020 })).isError).toBeFalsy();
  });

  it('reports the year range before the missing target when both fail', async () => {
    const error = errorEnvelope(await run({ year_from: 2020, year_to: 2010 }));

    expect(error.data?.reason).toBe('invalid_year_range');
  });
});

describe('filters on the wire', () => {
  it('sends only q and facet_name on both facet requests when no filter is set', async () => {
    routeSummary();

    const result = await run({ query: 'collaboration:atlas' });

    expect(h.requests).toHaveLength(2);
    for (const request of h.requests) {
      expect([...request.names].sort()).toEqual(['facet_name', 'q']);
    }
    expect(structured<Output>(result).appliedFilters).toBe('none');
  });

  it('reads a blank string on every optional input as unset', async () => {
    routeSummary();

    const result = await run({
      query: 'collaboration:atlas',
      document_types: '',
      subjects: '',
      year_from: '',
      year_to: '',
      exclude_self_citations: '',
    } as Input);

    expect(result.isError).toBeFalsy();
    expect(h.requests).toHaveLength(2);
    for (const request of h.requests) {
      expect([...request.names].sort()).toEqual(['facet_name', 'q']);
    }
    expect(structured<Output>(result).appliedFilters).toBe('none');
    expect(structured<Output>(result).citationsByYear).toHaveLength(71);
  });

  it('reads empty arrays for the facet filters as unset', async () => {
    routeSummary();

    await run({ query: 'x', document_types: [], subjects: [] });

    expect(h.requests).toHaveLength(2);
    for (const request of h.requests) {
      expect(request.names).not.toContain('doc_type');
      expect(request.names).not.toContain('subject');
    }
  });

  it('maps document types, subjects, and years to the facet parameters, and echoes them', async () => {
    routeSummary();

    const result = await run({
      query: 'x',
      document_types: ' Published , REVIEW,published',
      subjects: ['theory-hep', 'Lattice'],
      year_from: 2012,
      year_to: 2015,
    });

    expect(facetParams()?.getAll('doc_type')).toEqual(['published', 'review']);
    expect(facetParams()?.getAll('subject')).toEqual(['Theory-HEP', 'Lattice']);
    expect(facetParams()?.get('earliest_date')).toBe('2012--2015');
    expect(structured<Output>(result).appliedFilters).toBe(
      'document_types=published,review; subjects=Theory-HEP,Lattice; years=2012–2015',
    );
  });

  it.each([
    ['year_from alone', { year_from: 2012 }, '2012--', 'years=2012–'],
    ['year_to alone', { year_to: 1990 }, '--1990', 'years=–1990'],
    ['equal bounds', { year_from: 2020, year_to: 2020 }, '2020--2020', 'years=2020–2020'],
  ])('sends earliest_date for %s', async (_label, years, earliest, echo) => {
    routeSummary();

    const out = structured<Output>(await run({ query: 'x', ...years }));

    expect(facetParams()?.get('earliest_date')).toBe(earliest);
    expect(out.appliedFilters).toBe(echo);
  });

  it('sends the self-citation exclusion only when asked, and echoes it', async () => {
    routeSummary();

    const off = await run({ query: 'x', exclude_self_citations: false });
    const on = await run({ query: 'x', exclude_self_citations: true });

    const [offSummary, onSummary] = facetRequests('citation-summary');
    expect(offSummary?.names).not.toContain('exclude-self-citations');
    expect(onSummary?.params.get('exclude-self-citations')).toBe('true');
    expect(h.requests.every((r) => r.params.get('exclude-self-citations') !== 'false')).toBe(true);
    expect(structured<Output>(off).appliedFilters).toBe('none');
    expect(structured<Output>(on).appliedFilters).toBe('exclude_self_citations=true');
  });

  it.each<[string, Partial<Input>]>([
    ['year_from', { year_from: 2012 }],
    ['year_to', { year_to: 1990 }],
    ['exclude_self_citations', { exclude_self_citations: true }],
  ])('sends exactly one facet request, the summary, when %s is set', async (_label, filter) => {
    routeSummary();

    const result = await run({
      query: 'collaboration:atlas',
      document_types: 'published',
      ...filter,
    });

    expect(result.isError).toBeFalsy();
    expect(h.requests).toHaveLength(1);
    expect(h.requests[0]?.path).toBe('/api/literature/facets');
    expect(h.requests[0]?.params.getAll('facet_name')).toEqual(['citation-summary']);
  });

  it('applies the same filters to the summary of an author target', async () => {
    routeAuthor();
    routeSummary();

    await run({ author: 'Jane.Doe.1', document_types: 'published', exclude_self_citations: true });

    expect(requestsTo('/api/authors')[0]?.names).not.toContain('doc_type');
    expect(facetParams()?.getAll('doc_type')).toEqual(['published']);
    expect(facetParams()?.get('exclude-self-citations')).toBe('true');
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown document type', { document_types: ['preprint'] }],
    ['five document types', { document_types: 'article,published,review,thesis,note' }],
    ['an unknown subject', { subjects: 'Chemistry' }],
    ['five subjects', { subjects: ['Theory-HEP', 'Lattice', 'Computing', 'Other', 'Unknown'] }],
    ['year_from 1899', { year_from: 1899 }],
    ['year_to 2101', { year_to: 2101 }],
    ['a fractional year', { year_from: 2012.5 }],
    ['a year given as text', { year_from: '2012' }],
    ['exclude_self_citations given as text', { exclude_self_citations: 'true' }],
    ['an author over 200 characters', { author: 'x'.repeat(201), query: undefined }],
  ])('rejects %s as InvalidParams without calling INSPIRE', async (_label, extra) => {
    const result = await runRaw({ query: 'x', ...extra });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('cern_inspire_get_citation_summary');
    expect(h.requests).toHaveLength(0);
  });
});

describe('required enrichment', () => {
  it('writes every required field on a zero-result summary', async () => {
    routeSummary(zeroCitationSummaryBody());

    const result = await run({ query: 'zzzz nothing' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      target: { kind: 'query', query: 'zzzz nothing' },
      effectiveQuery: 'zzzz nothing',
      appliedFilters: 'none',
      matchedRecords: 0,
      citeablePapers: 0,
      hIndex: { all: 0, published: 0 },
    });
    expect(out.all).toEqual({ papers: 0, citations: 0 });
    expect(out.published).toEqual({ papers: 0, citations: 0 });
    expect(out.notice).toBeTypeOf('string');
    expect(fullText(result)).toContain('**Applied filters:** none');
  });

  it('echoes the filters and the resolved query on a zero-result author summary', async () => {
    routeAuthor();
    routeSummary(zeroCitationSummaryBody());

    const out = structured<Output>(
      await run({ author: 'Jane.Doe.1', document_types: 'published', year_from: 2030 }),
    );

    expect(out.effectiveQuery).toBe('authors.recid:1000001');
    expect(out.appliedFilters).toBe('document_types=published; years=2030–');
    expect(out.target.kind).toBe('author');
  });

  it('writes every required field on a populated summary and sets no notice', async () => {
    routeSummary();

    const result = await run({ query: 'collaboration:atlas', document_types: 'published' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      effectiveQuery: 'collaboration:atlas',
      appliedFilters: 'document_types=published',
      matchedRecords: 455,
      citeablePapers: 413,
    });
    expect(out.notice).toBeUndefined();
    expect(fullText(result)).toContain('**Applied filters:** document_types=published');
  });
});

describe('zero-summary notices', () => {
  const ZERO =
    'No citeable papers matched; the summary is all zeros. Check the query with cern_inspire_search_literature first.';
  const ORCID_HINT = 'Literature queries do not match ORCIDs; pass the ORCID as author instead.';

  const notice = async (input: Input, body: object = zeroCitationSummaryBody()) => {
    h = startHarness();
    routeAuthor();
    routeSummary(body, zeroCitationsByYearBody());
    return structured<Output>(await run(input)).notice;
  };

  it('says the summary is all zeros and points at literature search', async () => {
    expect(await notice({ query: 'zzzz' })).toBe(ZERO);
  });

  it.each([
    ['an ORCID after an author operator', 'a 0000-0002-1825-0097'],
    ['a bare ORCID', '0000-0002-1825-0097'],
    ['a lower-case checksum x', 'a 0000-0002-1825-009x'],
    ['an ORCID inside a longer query', 'find a 0000-0002-1825-0097 or t higgs'],
  ])('adds the ORCID hint for %s', async (_label, query) => {
    expect(await notice({ query })).toBe(`${ZERO} ${ORCID_HINT}`);
  });

  it.each([
    ['a longer digit run', '99999-0002-1825-0097'],
    ['a recid', 'refersto:recid:1124337'],
    ['a date range', 'date 2012-2015'],
  ])('does not add the ORCID hint for %s', async (_label, query) => {
    expect(await notice({ query })).toBe(ZERO);
  });

  it('does not add the ORCID hint for an author target, which already routes ORCIDs', async () => {
    expect(await notice({ author: '0000-0000-0000-0001' })).toBe(ZERO);
  });

  it('keeps the all-zeros notice when records matched but none is citeable', async () => {
    const body = summary((aggregation, whole) => {
      aggregation.doc_count = 0;
      whole.hits = { total: { value: 12 } };
    });

    const h2 = await notice({ query: 'x' }, body);

    expect(h2).toBe(ZERO);
  });

  it('sets no notice for a populated summary, even for a query holding an ORCID', async () => {
    expect(await notice({ query: 'a 0000-0002-1825-0097' }, citationSummaryBody())).toBeUndefined();
  });
});

describe('the summary and format() parity', () => {
  it('returns the summary in the schema shape and renders every value into content[]', async () => {
    routeAuthor();
    routeSummary();

    const result = await run({ author: 'Jane.Doe.1' });

    const out = structured<Output>(result);
    expect(out).toEqual(expect.schemaMatching(getCitationSummaryTool.output));
    const text = bodyText(result);
    const {
      target,
      matchedRecords,
      citeablePapers,
      hIndex,
      all,
      published,
      buckets,
      citationsByYear,
    } = out;
    expect(citationsByYear).toHaveLength(71);
    for (const leaf of leaves({
      target,
      matchedRecords,
      citeablePapers,
      hIndex,
      all,
      published,
      buckets,
      citationsByYear,
    })) {
      expect(text).toContain(String(leaf));
    }
  });

  it('renders the summary into labelled lines and one totals table', async () => {
    routeAuthor();
    routeSummary();

    const text = bodyText(await run({ author: 'Jane.Doe.1' }));

    expect(text).toContain('## INSPIRE citation summary — Doe, Jane (author recid 1000001)');
    expect(text).toContain('**Target kind:** author · **Query:** authors.recid:1000001');
    expect(text).toContain('**Matched records:** 455 · **Citeable papers:** 413');
    expect(text).toContain('**h-index:** 197 (all citeable) · 184 (published)');
    expect(text).toContain(
      [
        '| Scope | Papers | Citations | Average citations |',
        '|:--|--:|--:|--:|',
        '| All citeable | 413 | 202121 | 489.4 |',
        '| Published | 320 | 189652 | 592.7 |',
      ].join('\n'),
    );
  });

  it('renders a query target without an author in the heading', async () => {
    routeSummary();

    const result = await run({ query: 'collaboration:atlas' });

    expect(lines(result)[0]).toBe('## INSPIRE citation summary');
    expect(bodyText(result)).toContain('**Target kind:** query · **Query:** collaboration:atlas');
  });

  it('renders the seven buckets in range order, one table over both sets', async () => {
    routeSummary();

    const text = bodyText(await run({ query: 'x' }));

    expect(text).toContain(
      [
        '| Citation range | All citeable papers | Published papers |',
        '|:--|--:|--:|',
        '| 0 | 30 | 5 |',
        '| 1–9 | 40 | 20 |',
        '| 10–49 | 90 | 70 |',
        '| 50–99 | 60 | 55 |',
        '| 100–249 | 80 | 75 |',
        '| 250–499 | 60 | 55 |',
        '| 500+ | 53 | 40 |',
      ].join('\n'),
    );
  });

  it('puts a dash in a bucket cell one set lacks', async () => {
    const body = summary((aggregation) => {
      const published = aggregation.citations?.buckets?.published?.citation_buckets?.buckets;
      if (published) published.splice(3);
    });
    routeSummary(body);

    const result = await run({ query: 'x' });

    expect(structured<Output>(result).buckets.published).toHaveLength(3);
    expect(bodyText(result)).toContain('| 100–249 | 80 | — |');
    expect(bodyText(result)).toContain('| 0 | 30 | 5 |');
  });

  it('drops a bucket key outside the seven ranges', async () => {
    const body = summary((aggregation) => {
      aggregation.citations?.buckets?.all?.citation_buckets?.buckets?.push({
        key: '7--8',
        doc_count: 9,
      });
    });
    routeSummary(body);

    const result = await run({ query: 'x' });

    expect(structured<Output>(result).buckets.all).toHaveLength(7);
    expect(bodyText(result)).not.toContain('7–8');
  });

  it('drops a bucket key named after an Object.prototype member', async () => {
    const body = summary((aggregation) => {
      aggregation.citations?.buckets?.all?.citation_buckets?.buckets?.push(
        ...['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf'].map((key) => ({
          key,
          doc_count: 9,
        })),
      );
    });
    routeSummary(body);

    const result = await run({ query: 'x' });

    expect(structured<Output>(result).buckets.all.map((b) => b.range)).toEqual([
      '0',
      '1–9',
      '10–49',
      '50–99',
      '100–249',
      '250–499',
      '500+',
    ]);
    expect(bodyText(result)).not.toContain('function');
  });

  it('renders no bucket table when INSPIRE sends no buckets at all', async () => {
    const body = summary((aggregation) => {
      aggregation.citations = {};
    });
    routeSummary(body);

    const result = await run({ query: 'x' });

    expect(structured<Output>(result).buckets).toEqual({ all: [], published: [] });
    expect(bodyText(result)).not.toContain('Citation range');
  });

  it('shows averages to two decimals in content[] and keeps the float in structuredContent', async () => {
    const body = summary((aggregation) => {
      const all = aggregation.citations?.buckets?.all;
      if (all) all.average_citations = { value: 12.3456 };
    });
    routeSummary(body);

    const result = await run({ query: 'x' });

    expect(structured<Output>(result).all.averageCitations).toBe(12.3456);
    expect(bodyText(result)).toContain('| All citeable | 413 | 202121 | 12.35 |');
  });

  it('rounds a float citation total to an integer', async () => {
    const body = summary((aggregation) => {
      const all = aggregation.citations?.buckets?.all;
      if (all) all.citations_count = { value: 202121.6 };
    });
    routeSummary(body);

    const result = await run({ query: 'x' });

    expect(structured<Output>(result).all.citations).toBe(202122);
    expect(bodyText(result)).toContain('| All citeable | 413 | 202122 |');
  });

  it('says Not available for the average of a scope with no papers, and omits the field', async () => {
    const body = summary((aggregation) => {
      aggregation.citations = {
        buckets: {
          all: aggregation.citations?.buckets?.all ?? {},
          published: {
            doc_count: 0,
            citations_count: { value: 0 },
            average_citations: { value: null },
          },
        },
      };
    });
    routeSummary(body);

    const result = await run({ query: 'x' });

    const out = structured<Output>(result);
    expect(out.published).toEqual({ papers: 0, citations: 0 });
    expect(out.all.averageCitations).toBe(489.4);
    expect(bodyText(result)).toContain('| Published | 0 | 0 | Not available (no papers) |');
  });

  it('renders the zero-result summary as zeros with the average unavailable', async () => {
    routeSummary(zeroCitationSummaryBody());

    const result = await run({ query: 'zzzz' });

    const text = bodyText(result);
    expect(text).toContain('**Matched records:** 0 · **Citeable papers:** 0');
    expect(text).toContain('**h-index:** 0 (all citeable) · 0 (published)');
    expect(text).toContain('| All citeable | 0 | 0 | Not available (no papers) |');
    expect(text).toContain('| Published | 0 | 0 | Not available (no papers) |');
  });

  it('reads an h-index and totals INSPIRE leaves out as zero rather than failing', async () => {
    const body = summary((aggregation) => {
      delete aggregation['h-index'];
      delete aggregation.doc_count;
    });
    routeSummary(body);

    const out = structured<Output>(await run({ query: 'x' }));

    expect(out).toMatchObject({ hIndex: { all: 0, published: 0 }, citeablePapers: 0 });
  });

  it('renders no content blocks other than text', async () => {
    routeSummary();

    const result = await run({ query: 'x' });

    expect(result.content.every((block) => block.type === 'text')).toBe(true);
  });
});

describe('citations per year', () => {
  const ZERO =
    'No citeable papers matched; the summary is all zeros. Check the query with cern_inspire_search_literature first.';
  const FAILED =
    'Citations per year could not be read from INSPIRE this time; every other figure is complete. Retry this call for them.';
  const skipped = (list: string) =>
    `Citations per year are not included: INSPIRE's per-year series ignores ${list}, so it would not match the filtered figures. Call again without ${list} for citations per year (all years, self-citations included).`;
  const CAPTION =
    "**Citations per year** — by the citing record's earliest date, self-citations included, over every matched record (citeable or not):";

  /** The `| Year | Citations |` rows `format()` rendered, as numbers. */
  const tableRows = (result: ToolResult) =>
    lines(result).flatMap((line) => {
      const match = /^\| (\d{4}) \| (\d+) \|$/.exec(line);
      return match ? [{ year: Number(match[1]), citations: Number(match[2]) }] : [];
    });

  it('says in the description that any of the three filters leaves the series out, and names the broad-query case on the field', () => {
    expect(getCitationSummaryTool.description).toContain(
      'year_from and year_to narrow the summary to papers from those years, and exclude_self_citations recounts it without self-citations; any of them leaves out citations per year,',
    );
    expect(getCitationSummaryTool.output.shape.citationsByYear.description).toContain(
      'or when the query matches more than about 150,000 records',
    );
    expect(getCitationSummaryTool.output.shape.citationsByYear.description).toContain(
      'unless INSPIRE answers within about 2 s (a series it has cached)',
    );
  });

  it('returns the series ascending in structuredContent and the same rows as a table in content[]', async () => {
    routeAuthor();
    routeSummary();

    const result = await run({ author: 'Jane.Doe.1' });

    const out = structured<Output>(result);
    expect(out.citationsByYear).toHaveLength(71);
    expect(out.citationsByYear?.[0]).toEqual({ year: 1956, citations: 2 });
    expect(out.citationsByYear?.at(-1)).toEqual({ year: 2026, citations: 2975 });
    expect(out.citationsByYear?.map((r) => r.year)).toEqual(
      Array.from({ length: 71 }, (_, i) => 1956 + i),
    );
    expect(out.citationsByYear?.reduce((sum, r) => sum + r.citations, 0)).toBe(108_219);
    expect(tableRows(result)).toEqual(out.citationsByYear);
    expect(bodyText(result)).toContain(
      [CAPTION, '', '| Year | Citations |', '|:--|--:|', '| 1956 | 2 |', '| 1957 | 1 |'].join('\n'),
    );
    expect(out).toEqual(expect.schemaMatching(getCitationSummaryTool.output));
  });

  it('renders the year table after the citation-bucket table', async () => {
    routeSummary();

    const text = bodyText(await run({ query: 'x' }));

    const buckets = text.indexOf('| Citation range |');
    const years = text.indexOf('| Year | Citations |');
    expect(buckets).toBeGreaterThan(0);
    expect(years).toBeGreaterThan(buckets);
    expect(text.trimEnd().endsWith('| 2026 | 2975 |')).toBe(true);
  });

  it('renders the year table after the totals when INSPIRE sends no buckets', async () => {
    routeSummary(
      summary((aggregation) => {
        aggregation.citations = {};
      }),
    );

    const text = bodyText(await run({ query: 'x' }));

    expect(text).not.toContain('Citation range');
    expect(text.indexOf('| Year | Citations |')).toBeGreaterThan(text.indexOf('| Published |'));
  });

  it('keeps a gapped series gapped on both surfaces, with no zero row invented', async () => {
    routeSummary(citationSummaryBody(), capturedResponse(CAPTURED_SERIES.gapped));

    const result = await run({ query: 'collaboration:atlas' });

    const rows = structured<Output>(result).citationsByYear ?? [];
    expect(rows).toHaveLength(36);
    expect(rows.slice(0, 3).map((r) => r.year)).toEqual([1964, 1977, 1993]);
    expect(rows.every((r) => r.citations > 0)).toBe(true);
    expect(tableRows(result)).toEqual(rows);
    expect(bodyText(result)).not.toMatch(/^\| 19(6[5-9]|7[0-6]|7[89]|8\d|9[0-2]) \|/m);
  });

  it('sums the series of one paper to its citation count, 2025 included', async () => {
    routeSummary(citationSummaryBody(), capturedResponse(CAPTURED_SERIES.paper));

    const result = await run({ query: 'recid:451647' });

    const rows = structured<Output>(result).citationsByYear ?? [];
    expect(rows.reduce((sum, r) => sum + r.citations, 0)).toBe(22_635);
    expect(rows.find((r) => r.year === 2025)?.citations).toBe(1227);
    expect(bodyText(result)).toContain('| 2025 | 1227 |');
  });

  it('asks for the summary and the series on the same query, and resolves an author once', async () => {
    routeAuthor();
    routeSummary();

    await run({ author: 'Jane.Doe.1' });

    expect(h.requests.map((r) => r.path).sort()).toEqual([
      '/api/authors',
      '/api/literature/facets',
      '/api/literature/facets',
    ]);
    const [series] = facetRequests('citations-by-year');
    expect(series?.params.get('q')).toBe('authors.recid:1000001');
    expect([...(series?.names ?? [])].sort()).toEqual(['facet_name', 'q']);
    expect(facetRequests('citation-summary')).toHaveLength(1);
  });

  it('sends document_types and subjects on the series request too', async () => {
    routeSummary();

    const result = await run({
      query: 'x',
      document_types: 'published,review',
      subjects: 'theory-hep',
    });

    const [series] = facetRequests('citations-by-year');
    expect(series?.params.getAll('doc_type')).toEqual(['published', 'review']);
    expect(series?.params.getAll('subject')).toEqual(['Theory-HEP']);
    expect(series?.names).not.toContain('earliest_date');
    expect(structured<Output>(result).citationsByYear).toHaveLength(71);
  });

  it.each<[string, Partial<Input>, string]>([
    ['year_from', { year_from: 2010 }, 'year_from'],
    ['year_to', { year_to: 1990 }, 'year_to'],
    ['exclude_self_citations', { exclude_self_citations: true }, 'exclude_self_citations'],
    ['both years', { year_from: 2000, year_to: 2010 }, 'year_from and year_to'],
    [
      'every one of them beside a subject',
      { year_from: 2000, year_to: 2010, exclude_self_citations: true, subjects: 'Lattice' },
      'year_from, year_to, and exclude_self_citations',
    ],
  ])('omits the series and names the filter when %s is set', async (_label, filters, list) => {
    routeSummary();

    const result = await run({ query: 'collaboration:atlas', ...filters });

    const out = structured<Output>(result);
    expect(out).not.toHaveProperty('citationsByYear');
    expect(out.notice).toBe(skipped(list));
    expect(fullText(result)).toContain(skipped(list));
    expect(bodyText(result)).not.toContain('Citations per year');
    expect(facetRequests('citations-by-year')).toHaveLength(0);
    expect(h.requests).toHaveLength(1);
  });

  it('puts the omitted-series notice after the all-zeros notice when both apply', async () => {
    routeSummary(zeroCitationSummaryBody());

    const out = structured<Output>(await run({ query: 'zzzz', year_from: 2030 }));

    expect(out.notice).toBe(`${ZERO} ${skipped('year_from')}`);
  });

  it('returns an empty series for zero matches, with the all-zeros notice unchanged', async () => {
    routeSummary(zeroCitationSummaryBody(), zeroCitationsByYearBody());

    const result = await run({ query: 'zzzz nothing' });

    const out = structured<Output>(result);
    expect(out.citationsByYear).toEqual([]);
    expect(out.notice).toBe(ZERO);
    expect(bodyText(result)).toContain('**Citations per year:** none recorded');
    expect(bodyText(result)).not.toContain('| Year | Citations |');
  });

  it.each<[string, () => Response]>([
    ['a persistent 429', () => rateLimitResponse('1')],
    ['an HTML page', () => htmlResponse()],
    ['a persistent 500', () => new Response('upstream trouble', { status: 500 })],
    ['JSON without the citations_by_year aggregation', () => jsonResponse({ aggregations: {} })],
  ])(
    'returns the summary without the series, and a retry notice, when the series request answers %s',
    async (_label, reply) => {
      routeSummary(citationSummaryBody(), reply);

      const result = await runSettled({ query: 'collaboration:atlas' });

      const out = structured<Output>(result);
      expect(out).not.toHaveProperty('citationsByYear');
      expect(out.citeablePapers).toBe(413);
      expect(out.notice).toBe(FAILED);
      expect(fullText(result)).toContain(FAILED);
      expect(bodyText(result)).not.toContain('Citations per year');
    },
  );

  it('returns the summary when INSPIRE never answers the series, inside the call budget', async () => {
    const fake = facetResponder();
    const hang = hangingFetch();
    h = startHarness({
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.searchParams.get('facet_name') === 'citations-by-year') return hang(input, init);
        return fake(new Request(url));
      },
    });

    const result = await runSettled({ query: 'collaboration:atlas' });

    const out = structured<Output>(result);
    expect(out).not.toHaveProperty('citationsByYear');
    expect(out.notice).toBe(FAILED);
    expect(facetRequests('citations-by-year')).toHaveLength(1);
  });

  /** The summary body with INSPIRE's match count set to `matched`. */
  const matching = (matched: number) =>
    summary((_aggregation, whole) => {
      whole.hits = { total: { value: matched } };
    });

  /** Answers the summary facet with `body` and leaves the series facet unanswered until aborted. */
  const hangSeries = (body: object) => {
    const fake = facetResponder({ summary: body });
    const hang = hangingFetch();
    h = startHarness({
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.searchParams.get('facet_name') === 'citations-by-year') return hang(input, init);
        return fake(new Request(url));
      },
    });
  };

  const tooBroad = (matched: string) =>
    `Citations per year are not included: this query matches ${matched} records, and past about 150,000 INSPIRE takes longer than 15 s to count them. Repeat this call in about 30 s, since INSPIRE may finish the count meanwhile and answer from its cache, or narrow the query text, document_types, or subjects (year_from and year_to leave citations per year out).`;

  it('leaves out the series of a query past 150,000 records with a notice to repeat or narrow, on both surfaces', async () => {
    hangSeries(matching(216_736));

    const result = await runSettled({ query: 'date > 2023' });

    const out = structured<Output>(result);
    expect(out).not.toHaveProperty('citationsByYear');
    expect(out.matchedRecords).toBe(216_736);
    expect(out.citeablePapers).toBe(413);
    expect(out.notice).toBe(tooBroad('216,736'));
    expect(fullText(result)).toContain(`> ${tooBroad('216,736')}`);
    expect(bodyText(result)).not.toContain('Citations per year');
    expect(out.notice).not.toMatch(/year_from and year_to (narrow|to)/);
    expect(facetRequests('citations-by-year')).toHaveLength(1);
    expect(out).toEqual(expect.schemaMatching(getCitationSummaryTool.output));
  });

  /** The notice past 300,000 records, where INSPIRE was not seen to finish or cache the count. */
  const narrowOnly = (matched: string) =>
    `Citations per year are not included: this query matches ${matched} records, and past about 150,000 INSPIRE takes longer than 15 s to count them. Narrow the query text, document_types, or subjects for them (year_from and year_to leave citations per year out).`;

  it.each<[number, string, string]>([
    [300_000, '300,000', tooBroad('300,000')],
    [300_001, '300,001', narrowOnly('300,001')],
    [644_458, '644,458', narrowOnly('644,458')],
  ])(
    'at %i matched records, offers the repeat only up to 300,000, on both surfaces',
    async (matched, shown, notice) => {
      hangSeries(matching(matched));

      const result = await runSettled({ query: 'date > 2015' });

      const out = structured<Output>(result);
      expect(out.notice).toBe(notice);
      expect(fullText(result)).toContain(`> ${notice}`);
      expect(out.notice).toContain(`matches ${shown} records`);
      expect(out).not.toHaveProperty('citationsByYear');
    },
  );

  it('tells a caller past 300,000 records only to narrow, never to repeat the call', async () => {
    hangSeries(matching(1_278_435));

    const result = await runSettled({ query: 'date > 2000' });

    expect(structured<Output>(result).notice).not.toMatch(/repeat|30 s|cache/i);
    expect(fullText(result)).not.toMatch(/repeat|30 s|cache/i);
    expect(fullText(result)).toContain('Narrow the query text, document_types, or subjects');
  });

  it.each<[number, string]>([
    [149_999, FAILED],
    [150_000, FAILED],
    [150_001, tooBroad('150,001')],
  ])(
    'with the series unanswered at %i matched records, gives the notice for that side of 150,000',
    async (matched, notice) => {
      hangSeries(matching(matched));

      const out = structured<Output>(await runSettled({ query: 'date > 2023' }));

      expect(out.notice).toBe(notice);
      expect(out).not.toHaveProperty('citationsByYear');
    },
  );

  it('gives a broad query’s series that fails outright only the retry notice', async () => {
    routeSummary(matching(644_458), jsonResponse(badRequestBody('Bad facet.'), { status: 400 }));

    const out = structured<Output>(await runSettled({ query: 'date > 2015' }));

    expect(out.notice).toBe(FAILED);
  });

  it('puts the failed-series notice after the all-zeros notice when both apply', async () => {
    routeSummary(zeroCitationSummaryBody(), () => htmlResponse());

    const out = structured<Output>(await runSettled({ query: 'zzzz' }));

    expect(out.notice).toBe(`${ZERO} ${FAILED}`);
  });

  it('returns the summary without the series, and a retry notice, when INSPIRE rejects only the series request with a 400', async () => {
    routeSummary(
      citationSummaryBody(),
      jsonResponse(badRequestBody('Bad facet.'), { status: 400 }),
    );

    const result = await run({ query: 'x' });

    expect(result.isError).toBeFalsy();
    const out = structured<Output>(result);
    expect(out).not.toHaveProperty('citationsByYear');
    expect(out.hIndex).toEqual({ all: 197, published: 184 });
    expect(out.notice).toBe(FAILED);
    expect(fullText(result)).toContain(`> ${FAILED}`);
    expect(bodyText(result)).toContain('**h-index:** 197 (all citeable) · 184 (published)');
  });

  it('fails a call cancelled while the series is in flight, never a degraded success', async () => {
    const controller = new AbortController();
    const fake = facetResponder();
    const hang = hangingFetch();
    h = startHarness({
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (url.searchParams.get('facet_name') !== 'citations-by-year')
          return fake(new Request(url));
        setTimeout(() => controller.abort(), 20);
        return await hang(input, init);
      },
    });

    const result = await run({ query: 'x' }, { context: { signal: controller.signal } });

    expect(controller.signal.aborted).toBe(true);
    expect(errorEnvelope(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});

describe('upstream text stays out of inline markdown slots', () => {
  const NEL = String.fromCharCode(0x85);
  const LS = String.fromCharCode(0x2028);
  const attack = '\r\n# Injected heading\n**Matched records:** 999999';

  const render = async (name: string) => {
    h = startHarness();
    routeAuthor(authorPage([authorMetadata({ name: { value: name } })]));
    routeSummary();
    return run({ author: 'Jane.Doe.1' });
  };

  it('keeps the markdown structure of a benign profile when the author name carries line breaks', async () => {
    const benign = await render('Doe, Jane');
    const hostile = await render(`Doe, Jane${attack}`);

    expect(shape(hostile)).toEqual(shape(benign));
    expect(lines(hostile).filter((line) => line.startsWith('#'))).toEqual([
      '## INSPIRE citation summary — Doe, Jane # Injected heading \\*\\*Matched records:\\*\\* 999999 (author recid 1000001)',
    ]);
    expect(lines(hostile).filter((line) => line.startsWith('**Matched records:**'))).toHaveLength(
      1,
    );
  });

  it('flattens the other line separators and keeps structuredContent verbatim', async () => {
    const result = await render(`Doe${LS}x${NEL}y`);

    expect(structured<Output>(result).target.authorName).toBe(`Doe${LS}x${NEL}y`);
    expect(bodyText(result)).not.toMatch(new RegExp(`[${LS}${NEL}]`));
    expect(lines(result)[0]).toBe('## INSPIRE citation summary — Doe x y (author recid 1000001)');
  });

  it('escapes link brackets and angle brackets in the author name', async () => {
    const result = await render('Doe [Jane](http://evil.example.org) <J>');

    expect(lines(result)[0]).toBe(
      '## INSPIRE citation summary — Doe \\[Jane\\](http://evil.example.org) &lt;J&gt; (author recid 1000001)',
    );
    expect(structured<Output>(result).target.authorName).toContain('[Jane](http://evil');
  });

  it('flattens a caller query with line breaks in the Query line', async () => {
    routeSummary();

    const result = await run({ query: 'collaboration:atlas\r\n# injected\n[x](http://evil) <b>' });

    expect(lines(result).some((line) => line.startsWith('# injected'))).toBe(false);
    expect(bodyText(result)).toContain(
      '**Query:** collaboration:atlas # injected \\[x\\](http://evil) &lt;b>',
    );
    expect(structured<Output>(result).target.query).toBe(
      'collaboration:atlas\r\n# injected\n[x](http://evil) <b>',
    );
  });
});

describe('the enrichment trailer echoes the query on one line', () => {
  const LS = String.fromCharCode(0x2028);

  it.each([
    ['LF', 't higgs\n## injected', 'Query: t higgs ## injected'],
    ['CRLF', 't higgs\r\n# injected', 'Query: t higgs # injected'],
    ['LINE SEPARATOR', `t higgs${LS}# injected`, 'Query: t higgs # injected'],
  ])(
    'flattens a %s in the query, while structuredContent keeps it',
    async (_label, query, echo) => {
      routeSummary();

      const result = await run({ query, year_from: 2012 });

      const trailer = textBlocks(result)[1] ?? '';
      expect(trailer).toContain(echo);
      expect(trailer.split(/\r\n|[\r\n\u2028]/).some((line) => line.startsWith('#'))).toBe(false);
      expect(structured<Output>(result).effectiveQuery).toBe(query);
    },
  );

  it('echoes the derived query of an author target', async () => {
    routeAuthor();
    routeSummary();

    const result = await run({ author: 'Jane.Doe.1' });

    expect(textBlocks(result)[1]).toContain('Query: authors.recid:1000001');
  });

  it('echoes a wildcard, a comparison, a tilde, and edge underscores as written on the Query line and in the trailer, so a content[]-only caller can send the echo back', async () => {
    routeSummary();
    const query = 't neutrino* and date > 2015 and a x_ ~y _z';

    const result = await run({ query });

    expect(bodyText(result)).toContain(`**Query:** ${query}`);
    expect(textBlocks(result)[1]).toContain(`Query: ${query}`);
    expect(fullText(result)).not.toContain('\\');
    expect(fullText(result)).not.toContain('&gt;');
    expect(structured<Output>(result).effectiveQuery).toBe(query);
    expect(facetParams()?.get('q')).toBe(query);
  });
});

const summaryUnreadable = [
  ['an HTML page', () => htmlResponse()],
  ['truncated JSON', () => new Response('{"aggregations":', { status: 200 })],
  ['an empty body', () => new Response('', { status: 200 })],
  ['JSON without the aggregations', () => jsonResponse({ hits: { total: { value: 1 } } })],
  ['JSON without the citation_summary aggregation', () => jsonResponse({ aggregations: {} })],
] as const;

describeFailureClasses({
  label: 'cern_inspire_get_citation_summary (query target, series in parallel)',
  contract: errors,
  invalidQuery: true,
  path: '/api/literature/facets',
  isAttempt: (request) => request.params.get('facet_name') === 'citation-summary',
  run: (options) => run({ query: 'collaboration:atlas' }, options),
  install: (harness, reply) =>
    harness.route('/literature/facets', facetResponder({ summary: reply })),
  unreadable: summaryUnreadable,
});

describeFailureClasses({
  label: 'cern_inspire_get_citation_summary (query target, year filter, summary alone)',
  contract: errors,
  invalidQuery: true,
  path: '/api/literature/facets',
  run: (options) => run({ query: 'collaboration:atlas', year_from: 2012 }, options),
  install: (harness, reply) => harness.route('/literature/facets', reply),
  unreadable: summaryUnreadable,
});

describe('upstream failures on the profile lookup of an author target', () => {
  const declared = (reason: string) => {
    const found = errors.find((e) => e.reason === reason);
    if (!found) throw new Error(`no ${reason} entry`);
    return found;
  };

  it('reports a 429 on the profile lookup as inspire_rate_limited and never asks for a summary', async () => {
    h.route('/authors', rateLimitResponse('120'));
    routeSummary();

    const result = await runSettled({ author: 'Jane.Doe.1' });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data?.reason).toBe('inspire_rate_limited');
    expect(error.data?.retryAfter).toBe(120);
    expect(error.data?.recovery?.hint).toBe(declared('inspire_rate_limited').recovery);
    expect(requestsTo('/api/literature/facets')).toHaveLength(0);
  });

  it('reports an HTML page on the profile lookup as upstream_unreadable', async () => {
    h.route('/authors', htmlResponse());
    routeSummary();

    const result = await runSettled({ author: 'Jane.Doe.1' });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('upstream_unreadable');
    expect(error.data?.recovery?.hint).toBe(declared('upstream_unreadable').recovery);
    expect(requestsTo('/api/literature/facets')).toHaveLength(0);
  });

  it('reports a 400 on the profile lookup as invalid_query, without retrying', async () => {
    h.route('/authors', jsonResponse(badRequestBody('Bad author query.'), { status: 400 }));
    routeSummary();

    const result = await runSettled({ author: 'Jane.Doe.1' });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_query');
    expect(error.data?.upstreamMessage).toBe('Bad author query.');
    expect(error.data?.recovery?.hint).toBe(declared('invalid_query').recovery);
    expect(requestsTo('/api/authors')).toHaveLength(1);
  });

  it('reports an unreadable summary after a good profile lookup as upstream_unreadable', async () => {
    routeAuthor();
    h.route('/literature/facets', facetResponder({ summary: htmlResponse() }));

    const result = await runSettled({ author: 'Jane.Doe.1' });

    const error = errorEnvelope(result);
    expect(error.data?.reason).toBe('upstream_unreadable');
    expect(requestsTo('/api/authors')).toHaveLength(1);
    expect(facetRequests('citation-summary').length).toBeGreaterThanOrEqual(3);
  });

  it('reports a 429 on the summary after a good profile lookup as inspire_rate_limited', async () => {
    routeAuthor();
    h.route('/literature/facets', facetResponder({ summary: rateLimitResponse('30') }));

    const result = await runSettled({ author: 'Jane.Doe.1' });

    const error = errorEnvelope(result);
    expect(error.data?.reason).toBe('inspire_rate_limited');
    expect(error.data?.retryAfter).toBe(30);
  });
});
