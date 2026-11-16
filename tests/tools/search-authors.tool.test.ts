/**
 * @fileoverview Tests for cern_inspire_search_authors through `runToolContract`
 * over an `InspireService` on a fake fetch: input validation and blank-as-unset
 * handling, every identifier form the query accepts and the route it takes,
 * the required enrichment on a zero-result page, an under-cap page, and capped
 * pages, paging (the 10,000-result window, continuation from `links.next`,
 * past-the-end and deleted-only pages), the per-route zero-hit hints, the
 * deleted-profile notice, `format()`
 * parity with `structuredContent`, upstream text kept out of inline markdown
 * slots, and the shared upstream failure classes on the wire. No live network.
 * @module tests/tools/search-authors.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type RunToolContractOptions, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchAuthorsTool } from '@/mcp-server/tools/definitions/search-authors.tool.js';
import { describeFailureClasses } from '../fixtures/failure-suite.js';
import {
  authorMetadata,
  authorPage,
  emptyBody,
  htmlResponse,
  jsonResponse,
  searchBody,
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

type Input = z.input<typeof searchAuthorsTool.input>;
type Output = z.infer<typeof searchAuthorsTool.output> & {
  cap: number;
  matchedAs: string;
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
  runToolContract(searchAuthorsTool, input, options);

/** A call with arguments the schema's input type would not accept, as a misbehaving client sends. */
const runRaw = (input: Record<string, unknown>) => run(input as Input);

const author = (n: number, overrides: Parameters<typeof authorMetadata>[0] = {}) =>
  authorMetadata({
    control_number: 1000000 + n,
    name: { value: `Doe, Jane ${n}` },
    ...overrides,
  });

const pageOf = (count: number, options: { next?: boolean; total?: number } = {}) =>
  authorPage(
    Array.from({ length: count }, (_, i) => author(i + 1)),
    options,
  );

const routePage = (body: unknown = pageOf(1)) => h.route('/authors', jsonResponse(body));

const lines = (result: ToolResult) => bodyText(result).split('\n');

const params = () => h.requests[0]?.params;

/** The first ten characters of each body line: the markdown structure, not the upstream words. */
const shape = (result: ToolResult) => lines(result).map((line) => line.slice(0, 10));

const errors = searchAuthorsTool.errors ?? [];
const hint = (reason: string) => errors.find((e) => e.reason === reason)?.recovery;

describe('input', () => {
  it('advertises budgets above the result ceiling', () => {
    const schema = searchAuthorsTool.input.toJSONSchema({ io: 'input' });
    const budget = schema.properties?.limit;
    expect(budget).toMatchObject({ type: 'integer', minimum: 1 });
    expect(budget).not.toHaveProperty('maximum', 25);
    expect(searchAuthorsTool.input.safeParse({ query: 'x', limit: 1000000 }).success).toBe(true);
  });

  it.each([
    [1, 1, false],
    [25, 25, false],
    [25, 26, true],
  ] as const)(
    'keeps the reduction notice with %i shown and %i matched',
    async (shown, total, truncated) => {
      routePage(pageOf(shown, { total, next: truncated }));
      const result = await run({ query: 'Doe', limit: 26 });
      const out = structured<Output>(result);
      expect(out).toMatchObject({ cap: 25, limit: 25, shown, totalCount: total, truncated });
      expect(out.notice).toContain('limit 26 reduced to 25.');
      expect(fullText(result)).toContain('limit 26 reduced to 25.');
      expect(fullText(result)).toContain(`**shown:** ${shown}`);
      expect(bodyText(result)).toContain('**Limit:** 25');
      expect(params()?.get('size')).toBe('25');
      if (truncated) {
        expect(out.notice).toContain('request page 2 with limit 25.');
        expect(out.notice).toContain('search by BAI or ORCID');
        expect(out.notice).not.toContain('add name parts');
      }
      expect(out.notice).not.toContain('raise limit');
    },
  );

  it.each([25, 26, 1000000])(
    'accepts budget %i and discloses reductions on an empty result',
    async (requested) => {
      routePage(emptyBody());
      const result = await run({ query: 'Nobody', limit: requested });
      const out = structured<Output>(result);
      expect(out).toMatchObject({ cap: 25, shown: 0, truncated: false });
      expect(params()?.get('size')).toBe('25');
      if (requested > 25) {
        expect(out.notice).toContain(`limit ${requested} reduced to 25`);
        expect(fullText(result)).toContain(`limit ${requested} reduced to 25`);
      }
      expect(out.notice).toContain('Nobody');
    },
  );

  it('preserves a seven-result budget on an empty response', async () => {
    routePage(emptyBody());
    const result = await run({ query: 'Nobody', limit: 7 });
    expect(structured<Output>(result)).toMatchObject({ cap: 7, shown: 0, truncated: false });
    expect(params()?.get('size')).toBe('7');
    expect(fullText(result)).toContain('Nobody');
  });

  it('applies the default limit and page and sends only q, fields, size, and page', async () => {
    routePage();

    const result = await run({ query: 'Doe, Jane' });

    expect(result.isError).toBeFalsy();
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['fields', 'page', 'q', 'size']);
    expect(h.requests[0]?.path).toBe('/api/authors');
    expect(params()?.get('size')).toBe('5');
    expect(params()?.get('page')).toBe('1');
    expect(structured<Output>(result)).toMatchObject({ cap: 5, limit: 5, page: 1 });
  });

  it('reads a blank limit as unset', async () => {
    routePage();

    const result = await run({ query: 'Doe, Jane', limit: '' } as Input);

    expect(result.isError).toBeFalsy();
    expect(params()?.get('size')).toBe('5');
    expect(structured<Output>(result).cap).toBe(5);
  });

  it('never requests email addresses', async () => {
    routePage();

    await run({ query: 'Doe, Jane' });

    expect(params()?.get('fields')).not.toContain('email');
  });

  it('trims the query before routing it', async () => {
    routePage();

    const result = await run({ query: '   Jane.Doe.1  ' });

    expect(params()?.get('q')).toBe('ids.value:Jane.Doe.1');
    expect(structured<Output>(result).matchedAs).toBe('bai');
  });

  it('accepts a query of exactly 200 characters', async () => {
    routePage();

    const result = await run({ query: 'x'.repeat(200) });

    expect(result.isError).toBeFalsy();
    expect(params()?.get('q')).toHaveLength(200);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing query', {}],
    ['an empty query', { query: '' }],
    ['a whitespace-only query', { query: '   \t ' }],
    ['a query over 200 characters', { query: 'x'.repeat(201) }],
    ['a boolean query', { query: true }],
    ['an object query', { query: { name: 'Doe' } }],
    ['a fractional number query', { query: 1000001.5 }],
    ['limit 0', { query: 'Doe', limit: 0 }],
    ['a negative limit', { query: 'Doe', limit: -1 }],
    ['a fractional limit', { query: 'Doe', limit: 2.5 }],
    ['a limit given as text', { query: 'Doe', limit: '5' }],
    ['page 0', { query: 'Doe', page: 0 }],
    ['a negative page', { query: 'Doe', page: -1 }],
    ['a fractional page', { query: 'Doe', page: 1.5 }],
    ['a page given as text', { query: 'Doe', page: '2' }],
  ])('rejects %s as InvalidParams without calling INSPIRE', async (_label, input) => {
    const result = await runRaw(input);

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('cern_inspire_search_authors');
    expect(h.requests).toHaveLength(0);
  });

  it.each([
    ['limit 1', 1],
    ['limit 25', 25],
  ])('accepts %s', async (_label, limit) => {
    routePage();

    const result = await run({ query: 'Doe', limit });

    expect(result.isError).toBeFalsy();
    expect(params()?.get('size')).toBe(String(limit));
    expect(structured<Output>(result).cap).toBe(limit);
  });
});

describe('identifier forms', () => {
  it.each<[string, string, string, string]>([
    ['a name', 'Doe, Jane', 'name', 'Doe, Jane'],
    ['a name without a comma', 'Jane Doe', 'name', 'Jane Doe'],
    ['a bare surname', 'Doe', 'name', 'Doe'],
    ['a BAI', 'Jane.Doe.1', 'bai', 'ids.value:Jane.Doe.1'],
    ['a lower-case BAI, left as written', 'jane.doe.1', 'bai', 'ids.value:jane.doe.1'],
    [
      'a BAI with an apostrophe and hyphen',
      "Jane.O'Doe-Roe.12",
      'bai',
      "ids.value:Jane.O'Doe-Roe.12",
    ],
    ['a single-segment BAI', 'Doe.1', 'bai', 'ids.value:Doe.1'],
    ['an ORCID', '0000-0000-0000-0001', 'orcid', 'ids.value:0000-0000-0000-0001'],
    ['an ORCID with a checksum X', '0000-0000-0000-000X', 'orcid', 'ids.value:0000-0000-0000-000X'],
    [
      'a lower-case checksum x, upper-cased',
      '0000-0000-0000-000x',
      'orcid',
      'ids.value:0000-0000-0000-000X',
    ],
    [
      'an orcid.org URL, reduced to the iD',
      'https://orcid.org/0000-0000-0000-0001',
      'orcid',
      'ids.value:0000-0000-0000-0001',
    ],
    [
      'an orcid.org URL with www and a trailing slash',
      'http://www.orcid.org/0000-0000-0000-0001/',
      'orcid',
      'ids.value:0000-0000-0000-0001',
    ],
    ['an INSPIRE ID', 'INSPIRE-00000001', 'inspire_id', 'ids.value:INSPIRE-00000001'],
    [
      'a lower-case INSPIRE ID, upper-cased',
      'inspire-00000001',
      'inspire_id',
      'ids.value:INSPIRE-00000001',
    ],
    ['an author recid', '1000001', 'recid', 'control_number:1000001'],
    ['a nine-digit recid', '123456789', 'recid', 'control_number:123456789'],
    ['ten digits, which are no recid', '1234567890', 'name', '1234567890'],
    ['an INSPIRE ID with too few digits', 'INSPIRE-0001', 'name', 'INSPIRE-0001'],
    ['an ORCID with a missing group', '0000-0000-0001', 'name', '0000-0000-0001'],
  ])('routes %s', async (_label, query, matchedAs, q) => {
    routePage();

    const result = await run({ query });

    expect(result.isError).toBeFalsy();
    expect(params()?.get('q')).toBe(q);
    expect(structured<Output>(result).matchedAs).toBe(matchedAs);
  });

  it('accepts an author recid sent as a JSON number, as some clients send it', async () => {
    routePage();

    const result = await runRaw({ query: 1000001 });

    expect(result.isError).toBeFalsy();
    expect(params()?.get('q')).toBe('control_number:1000001');
    expect(structured<Output>(result).matchedAs).toBe('recid');
  });

  it('shows the route in the enrichment trailer', async () => {
    routePage();

    const result = await run({ query: 'Jane.Doe.1' });

    expect(fullText(result)).toContain('**Matched as:** `bai`');
  });
});

describe('declared error contracts', () => {
  it('declares the window reason and the four shared reasons, with tool-specific recovery text', () => {
    expect(errors.map((e) => e.reason)).toEqual([
      'beyond_result_window',
      'invalid_query',
      'inspire_rate_limited',
      'pacer_shed',
      'upstream_unreadable',
    ]);
    for (const reason of ['beyond_result_window', 'invalid_query']) {
      expect(errors.find((e) => e.reason === reason)).toMatchObject({
        code: JsonRpcErrorCode.ValidationError,
        severity: 'notice',
      });
      expect(hint(reason)).toContain('cern_inspire_search_authors');
    }
    expect(hint('upstream_unreadable')).toContain('cern_inspire_search_authors');
  });

  it('routes a page past the window to an identifier, never to extra name parts, which INSPIRE reads as initials and so widen the match', () => {
    expect(hint('beyond_result_window')).toBe(
      "Pin the person with a BAI, ORCID, or INSPIRE ID (cern_inspire_get_paper lists them for a paper's authors), then retry cern_inspire_search_authors; extra name parts widen a name search, since INSPIRE reads them as initials.",
    );
  });

  it('routes an unreadable body to a later retry of the same page and limit, never a smaller limit that shifts the page', () => {
    expect(hint('upstream_unreadable')).toBe(
      'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_search_authors with the same page and limit.',
    );
  });

  it('spells the recovery placeholders in capitals, which survive a markdown-to-HTML render', () => {
    for (const { reason } of errors) expect(hint(reason)).not.toMatch(/<[A-Za-z]/);
  });
});

describe('next-step descriptions', () => {
  it('names the affid:N query a position institution recid feeds', () => {
    const position = searchAuthorsTool.output.shape.authors.element.shape.currentPositions.element;
    const description = position.shape.institutionRecid.description ?? '';

    expect(description).toContain('affid:N');
    expect(description).toContain('cern_inspire_search_literature');
    expect(description).toContain('cern_inspire_get_citation_summary');
  });
});

describe('required enrichment', () => {
  it('writes every required field on a zero-result page', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'Zzzz, Nobody' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      authors: [],
      page: 1,
      limit: 5,
      hasMore: false,
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 5,
      matchedAs: 'name',
    });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBeTypeOf('string');
    expect(fullText(result)).toContain('**0 total**');
    expect(fullText(result)).toContain('**Matched as:** `name`');
    expect(bodyText(result)).toBe(
      [
        '## INSPIRE author profiles, page 1',
        '**Page:** 1 · **Limit:** 5 · **Profiles on this page:** 0 · **More pages:** no',
      ].join('\n'),
    );
  });

  it('writes every required field on an under-cap page and sets no notice', async () => {
    routePage(pageOf(3));

    const result = await run({ query: 'Doe, Jane', limit: 10 });

    const out = structured<Output>(result);
    expect(out.authors).toHaveLength(3);
    expect(out).toMatchObject({
      totalCount: 3,
      truncated: false,
      shown: 3,
      cap: 10,
      matchedAs: 'name',
    });
    expect(out.notice).toBeUndefined();
    expect(fullText(result)).toContain('**3 total**');
  });

  it('keeps a page of exactly limit profiles under the cap when nothing else matched', async () => {
    routePage(pageOf(5));

    const out = structured<Output>(await run({ query: 'Doe, Jane', limit: 5 }));

    expect(out).toMatchObject({ shown: 5, cap: 5, truncated: false, totalCount: 5 });
    expect(out.notice).toBeUndefined();
  });

  it.each([5, 25])(
    'offers the next page rather than a larger limit when limit %i leaves more profiles',
    async (limit) => {
      routePage(pageOf(limit, { next: true, total: 51_734 }));

      const result = await run({ query: 'Doe', limit });

      const out = structured<Output>(result);
      expect(out).toMatchObject({ truncated: true, shown: limit, cap: limit, totalCount: 51_734 });
      expect(out.notice).toBe(
        `More results: request page 2 with limit ${limit}. To pin one person, search by BAI or ORCID.`,
      );
      expect(fullText(result)).toContain(out.notice as string);
    },
  );

  it('reports totalCount from the match total, not the page length', async () => {
    routePage(pageOf(2, { total: 2 }));

    const out = structured<Output>(await run({ query: 'Doe, Jane' }));

    expect(out).toMatchObject({ totalCount: 2, shown: 2, truncated: false });
  });
});

describe('paging', () => {
  /** Profiles numbered from `first`, so a later page carries its own recids and names. */
  const rows = (first: number, count: number) =>
    Array.from({ length: count }, (_, i) => author(first + i));

  const pageParam = (n = 0) => h.requests[n]?.params.get('page');

  it("returns the first page's rows when no page is given", async () => {
    routePage(pageOf(3, { total: 3 }));

    const out = structured<Output>(await run({ query: 'Doe' }));

    expect(out.authors.map((a) => a.recid)).toEqual(['1000001', '1000002', '1000003']);
    expect(out).toMatchObject({ shown: 3, cap: 5, totalCount: 3, truncated: false });
    expect(params()?.get('size')).toBe('5');
  });

  it('sends page 1 for an omitted or blank page, returns the same rows, and echoes it on both surfaces', async () => {
    routePage(pageOf(3, { total: 3 }));

    const omitted = await run({ query: 'Doe' });
    const blank = await run({ query: 'Doe', page: '' } as Input);

    expect([pageParam(0), pageParam(1)]).toEqual(['1', '1']);
    expect(structured<Output>(blank).authors).toEqual(structured<Output>(omitted).authors);
    for (const result of [omitted, blank]) {
      expect(structured<Output>(result)).toMatchObject({ page: 1, limit: 5, hasMore: false });
      expect(bodyText(result)).toContain('## INSPIRE author profiles, page 1');
    }
  });

  it('sends the requested page with the limit as its size, on every identifier route', async () => {
    routePage(pageOf(1));

    await run({ query: 'Doe, Jane', page: 3, limit: 7 });
    await run({ query: 'Jane.Doe.1', page: 2 });

    expect([pageParam(0), h.requests[0]?.params.get('size')]).toEqual(['3', '7']);
    expect([pageParam(1), h.requests[1]?.params.get('q')]).toEqual(['2', 'ids.value:Jane.Doe.1']);
  });

  it("leaves INSPIRE's last page untruncated: hasMore follows links.next, not the match total", async () => {
    routePage(authorPage(rows(11, 2), { total: 12 }));

    const result = await run({ query: 'Doe', page: 3 });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      page: 3,
      limit: 5,
      hasMore: false,
      truncated: false,
      shown: 2,
      totalCount: 12,
    });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBeUndefined();
    expect(fullText(result)).not.toContain('Next page');
  });

  it('leaves a last page untruncated when it dropped a deleted profile', async () => {
    routePage(authorPage([author(4), author(5, { deleted: true }), author(6)], { total: 6 }));

    const out = structured<Output>(await run({ query: 'Doe', page: 2, limit: 3 }));

    expect(out).toMatchObject({ shown: 2, totalCount: 6, truncated: false, hasMore: false });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBe(
      '1 matching profile is marked deleted in INSPIRE and was dropped from this result.',
    );
  });

  it('marks a page with a next link truncated, points at the next page, and keeps the narrowing advice', async () => {
    routePage(pageOf(5, { next: true, total: 80_843 }));

    const result = await run({ query: 'Doe' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      page: 1,
      limit: 5,
      hasMore: true,
      truncated: true,
      shown: 5,
      cap: 5,
      totalCount: 80_843,
      nextPage: 2,
      notice:
        'More results: request page 2 with limit 5. To pin one person, search by BAI or ORCID.',
    });
    expect(fullText(result)).toContain('**Next page:** 2');
    expect(fullText(result)).toContain(out.notice as string);
    expect(bodyText(result)).toContain('**More pages:** yes');
  });

  it('counts the next page from the requested page and the limit given', async () => {
    routePage(authorPage(rows(31, 5), { next: true, total: 900 }));

    const out = structured<Output>(await run({ query: 'Doe', page: 7, limit: 5 }));

    expect(out.nextPage).toBe(8);
    expect(out.notice?.startsWith('More results: request page 8 with limit 5.')).toBe(true);
    expect(pageParam()).toBe('7');
  });

  it('names the limit in the next-page notice, so sending exactly what it says keeps limit 25 rather than the default 5', async () => {
    routePage(pageOf(25, { next: true, total: 80_843 }));

    const result = await run({ query: 'Doe', limit: 25 });
    const recipe = /request page (\d+) with limit (\d+)\./.exec(
      structured<Output>(result).notice ?? '',
    );
    await run({ query: 'Doe', page: Number(recipe?.[1]), limit: Number(recipe?.[2]) });

    expect(recipe?.slice(1)).toEqual(['2', '25']);
    expect(fullText(result)).toContain(recipe?.[0]);
    expect(h.requests.map((r) => [r.params.get('page'), r.params.get('size')])).toEqual([
      ['1', '25'],
      ['2', '25'],
    ]);
    expect(searchAuthorsTool.enrichment?.nextPage?.description).toContain('same limit');
  });

  it('takes hasMore from links.next on a page whose every raw hit is a deleted profile', async () => {
    routePage(
      authorPage([author(3, { deleted: true }), author(4, { deleted: true })], {
        next: true,
        total: 90,
      }),
    );

    const result = await run({ query: 'Doe', page: 2, limit: 2 });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      authors: [],
      shown: 0,
      totalCount: 90,
      hasMore: true,
      truncated: true,
      nextPage: 3,
    });
    expect(out.notice).toBe(
      'More results: request page 3 with limit 2. To pin one person, search by BAI or ORCID. 2 matching profiles are marked deleted in INSPIRE and were dropped from this result.',
    );
    expect(fullText(result)).toContain('**Next page:** 3');
    expect(fullText(result)).not.toContain('past the last page');
    expect(fullText(result)).not.toContain('No INSPIRE author profile matched');
  });

  it('reports a page past the end alone: the query did match', async () => {
    routePage(authorPage([], { total: 12 }));

    const result = await run({ query: 'Doe', page: 5 });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      authors: [],
      shown: 0,
      totalCount: 12,
      truncated: false,
      hasMore: false,
    });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBe('Page 5 is past the last page (3); request a lower page.');
    expect(fullText(result)).toContain(out.notice as string);
    expect(fullText(result)).not.toContain('No INSPIRE author profile matched');
  });

  it('numbers the last page from the effective limit when a reduced limit runs past the end', async () => {
    routePage(authorPage([], { total: 51 }));

    const out = structured<Output>(await run({ query: 'Doe', page: 4, limit: 26 }));

    expect(out.notice).toBe(
      'limit 26 reduced to 25. Page 4 is past the last page (3); request a lower page.',
    );
  });

  it('gives the zero-hit notice, not the past-the-end one, when nothing matched on a later page', async () => {
    routePage(emptyBody());

    const out = structured<Output>(await run({ query: 'Zzzz, Nobody', page: 3 }));

    expect(
      out.notice?.startsWith('No INSPIRE author profile matched "Zzzz, Nobody" as name.'),
    ).toBe(true);
    expect(out.notice).not.toContain('past the last page');
  });

  it('keeps a last page that held only deleted profiles from reading as past the end', async () => {
    routePage(authorPage([author(1, { deleted: true })], { total: 6 }));

    const out = structured<Output>(await run({ query: 'Doe', page: 6, limit: 1 }));

    expect(out).toMatchObject({ shown: 0, totalCount: 6, truncated: false, hasMore: false });
    expect(out.notice).toBe(
      '1 matching profile is marked deleted in INSPIRE and was dropped from this result.',
    );
  });

  it('fails page × limit over 10,000 as beyond_result_window, before any request', async () => {
    const result = await run({ query: 'Zhang, Wei', page: 401, limit: 25 });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('beyond_result_window');
    expect(error.data).toMatchObject({ page: 401, limit: 25 });
    expect(error.message).toContain('page 401 × limit 25');
    expect(error.data?.recovery?.hint).toBe(hint('beyond_result_window'));
    expect(fullText(result)).toContain('reason beyond_result_window');
    expect(fullText(result)).toContain(`Recovery: ${hint('beyond_result_window')}`);
    expect(h.requests).toHaveLength(0);
  });

  it.each([
    [400, 25, false],
    [401, 25, true],
    [2000, 5, false],
    [2001, 5, true],
    [10_000, 1, false],
    [10_001, 1, true],
  ])('page %i × limit %i: past the window is %s', async (page, limit, rejected) => {
    routePage(emptyBody());

    const result = await run({ query: 'Doe', page, limit });

    expect(result.isError === true).toBe(rejected);
    expect(h.requests).toHaveLength(rejected ? 0 : 1);
  });

  it('checks the window against the effective limit, not the requested one', async () => {
    routePage(pageOf(1, { total: 80_843 }));

    const allowed = await run({ query: 'Doe', page: 400, limit: 26 });
    const refused = await run({ query: 'Doe', page: 401, limit: 1_000_000 });

    expect(allowed.isError).toBeFalsy();
    expect(structured<Output>(allowed).notice).toContain('limit 26 reduced to 25.');
    expect(h.requests[0]?.params.get('size')).toBe('25');
    expect(errorEnvelope(refused).data).toMatchObject({
      reason: 'beyond_result_window',
      page: 401,
      limit: 25,
    });
    expect(h.requests).toHaveLength(1);
  });

  it('withholds a next page that would cross the window, under a reduced limit too, and says to narrow', async () => {
    routePage(authorPage(rows(9976, 25), { next: true, total: 80_843 }));

    const result = await run({ query: 'Doe', page: 400, limit: 1_000_000 });

    const out = structured<Output>(result);
    expect(out).toMatchObject({ truncated: true, hasMore: true, shown: 25, cap: 25, limit: 25 });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBe(
      'limit 1000000 reduced to 25. INSPIRE serves only the first 10,000 results of a query; to pin one person, search by BAI or ORCID.',
    );
    expect(out.notice).not.toContain('request page');
    expect(fullText(result)).not.toContain('Next page');
  });

  it('offers the last reachable next page at the 10,000-result window edge', async () => {
    routePage(authorPage(rows(9951, 25), { next: true, total: 80_843 }));

    const out = structured<Output>(await run({ query: 'Doe', page: 399, limit: 25 }));

    expect(out.nextPage).toBe(400);
    expect(out.notice?.startsWith('More results: request page 400 with limit 25.')).toBe(true);
  });

  it('names the page and numbers rows from (page − 1) × limit + 1 in content[]', async () => {
    routePage(authorPage(rows(11, 2), { next: true, total: 40 }));

    const result = await run({ query: 'Doe', page: 3, limit: 5 });

    const text = bodyText(result);
    expect(text).toContain('## INSPIRE author profiles, page 3');
    expect(text).toContain(
      '**Page:** 3 · **Limit:** 5 · **Profiles on this page:** 2 · **More pages:** yes',
    );
    expect(lines(result).filter((line) => line.startsWith('### '))).toEqual([
      '### 11. Doe, Jane 11',
      '### 12. Doe, Jane 12',
    ]);
    expect(structured<Output>(result)).toMatchObject({ page: 3, limit: 5, hasMore: true });
  });

  it('numbers rows from the effective limit when the requested one was reduced', async () => {
    routePage(authorPage(rows(26, 1), { total: 26 }));

    const result = await run({ query: 'Doe', page: 2, limit: 26 });

    expect(bodyText(result)).toContain('**Page:** 2 · **Limit:** 25');
    expect(bodyText(result)).toContain('### 26. Doe, Jane 26');
  });
});

describe('zero-hit notice', () => {
  const notice = async (query: string) => {
    routePage(emptyBody());
    return structured<Output>(await run({ query })).notice ?? '';
  };

  it.each([
    ['Zzzz, Nobody', 'name', 'Try "Last, First", fewer name parts'],
    ['Jane.Doe.9', 'bai', 'BAIs are exact and case-sensitive'],
    ['INSPIRE-00000009', 'inspire_id', 'INSPIRE IDs are INSPIRE- plus 8 digits'],
    ['0000-0000-0000-0009', 'orcid', 'may not have an ORCID linked'],
    ['451647', 'recid', 'a paper recid matches no profile'],
  ])(
    'names the query and route, then the route hint, for %s as %s',
    async (query, matchedAs, fragment) => {
      const text = await notice(query);

      expect(
        text.startsWith(`No INSPIRE author profile matched "${query}" as ${matchedAs}. `),
      ).toBe(true);
      expect(text).toContain(fragment);
    },
  );

  it('carries the recid hint for a literature recid, which author search cannot match', async () => {
    const text = await notice('1124337');

    expect(text).toContain('Author and literature records are numbered separately');
  });

  it('spells the name placeholder in capitals on both surfaces, never as an HTML-shaped tag', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'Zzzz, Nobody' });

    const hint =
      'Try "Last, First", fewer name parts, or search papers with cern_inspire_search_literature using "a NAME".';
    expect(structured<Output>(result).notice).toContain(hint);
    expect(structured<Output>(result).notice).not.toMatch(/<[A-Za-z]|&[a-z]+;/);
    expect(fullText(result)).toContain(hint);
    expect(fullText(result)).not.toMatch(/<[A-Za-z]/);
  });

  it('echoes the query through callerEcho(): newlines flatten and brackets are escaped', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'Doe\r\n# injected\n[x](http://evil) <b>' });

    const text = structured<Output>(result).notice ?? '';
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('Doe # injected \\[x\\](http://evil) &lt;b>');
    expect(fullText(result)).not.toMatch(/^# injected/m);
  });

  it('echoes a wildcard query as written on both surfaces, so it can be sent again', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'Higgs*' });

    expect(structured<Output>(result).notice).toMatch(
      /^No INSPIRE author profile matched "Higgs\*" as name\. /,
    );
    expect(fullText(result)).toContain('No INSPIRE author profile matched "Higgs*" as name. ');
  });

  it('still escapes a link-shaped query in the content[] echo', async () => {
    routePage(emptyBody());

    const result = await run({ query: '[x](javascript:alert(1))' });

    expect(fullText(result)).toContain('"\\[x\\](javascript:alert(1))" as name');
    expect(fullText(result)).not.toContain('[x](');
  });
});

describe('surname-miss notice', () => {
  const named = (n: number, value: string) => author(n, { name: { value } });

  const surnameMiss = (query: string) =>
    `No profile on this page has a surname in "${query}"; INSPIRE widened the match by reading name parts as initials, so these may be other people. Check the spelling, or search by BAI or ORCID.`;

  const laterPageMiss = (query: string) =>
    `No profile on this page has a surname in "${query}"; past the profiles that carry the surname, INSPIRE lists ones matched only through name parts read as initials, so these may be other people. If no earlier page listed the surname, check the spelling; to pin one person, search by BAI or ORCID.`;

  it('flags a misspelled surname whose page holds only namesakes-by-initial, ahead of the next-page line', async () => {
    routePage(
      authorPage([named(1, 'Magana, Juan'), named(2, 'Mendez, Juan'), named(3, 'Luo, Juan-juan')], {
        next: true,
        total: 251_959,
      }),
    );

    const result = await run({ query: 'Maldecena, Juan', limit: 3 });

    const out = structured<Output>(result);
    expect(out.authors.map((a) => a.name)).toEqual([
      'Magana, Juan',
      'Mendez, Juan',
      'Luo, Juan-juan',
    ]);
    expect(out).toMatchObject({ matchedAs: 'name', truncated: true, totalCount: 251_959 });
    expect(out.notice).toBe(
      `${surnameMiss('Maldecena, Juan')} More results: request page 2 with limit 3. To pin one person, search by BAI or ORCID.`,
    );
    expect(fullText(result)).toContain(
      'INSPIRE widened the match by reading name parts as initials',
    );
  });

  it('on a later page, flags the initials-only tail without calling it a misspelling', async () => {
    routePage(
      authorPage([named(1, 'Tian, Zehua'), named(2, 'Zoller, Philippe')], {
        next: true,
        total: 80_843,
      }),
    );

    const result = await run({ query: 'Zhang, Wei', page: 400, limit: 2 });

    const out = structured<Output>(result);
    expect(out.notice).toBe(
      `${laterPageMiss('Zhang, Wei')} More results: request page 401 with limit 2. To pin one person, search by BAI or ORCID.`,
    );
    expect(out.notice).not.toContain('Check the spelling');
    expect(fullText(result)).toContain(laterPageMiss('Zhang, Wei'));
  });

  it('flags a name without a comma whose parts are no returned surname', async () => {
    routePage(
      authorPage([
        named(1, 'Quílez Lasanta, Pablo'),
        named(2, 'Qiao, Qing-Peng'),
        named(3, 'Potosí, Quray'),
      ]),
    );

    const out = structured<Output>(await run({ query: 'Qzxwvbnm Plkjhgf' }));

    expect(out).toMatchObject({ truncated: false, shown: 3 });
    expect(out.notice).toBe(surnameMiss('Qzxwvbnm Plkjhgf'));
  });

  it('does not count a short particle shared with the query', async () => {
    routePage(authorPage([named(1, 'de Gennes, Pierre')]));

    const out = structured<Output>(await run({ query: 'de Souza' }));

    expect(out.notice).toBe(surnameMiss('de Souza'));
  });

  it('does not count a surname that the query only begins', async () => {
    routePage(authorPage([named(1, 'Maldacena, Juan')]));

    const out = structured<Output>(await run({ query: 'Maldacen, Juan' }));

    expect(out.notice).toBe(surnameMiss('Maldacen, Juan'));
  });

  it('echoes a wildcard query as written on both surfaces, so it can be sent again', async () => {
    routePage(authorPage([named(1, 'Mendez, Juan')]));

    const result = await run({ query: 'Maldecen*, Juan' });

    expect(structured<Output>(result).notice).toBe(surnameMiss('Maldecen*, Juan'));
    expect(fullText(result)).toContain('a surname in "Maldecen*, Juan";');
  });

  it('still escapes a link-shaped query in the content[] echo', async () => {
    routePage(authorPage([named(1, 'Mendez, Juan')]));

    const result = await run({ query: '[x](javascript:alert(1)), Juan' });

    expect(fullText(result)).toContain('a surname in "\\[x\\](javascript:alert(1)), Juan";');
    expect(fullText(result)).not.toContain('[x](');
  });

  it.each([
    ['"Last, First"', 'Maldacena, Juan', 'Maldacena, Juan Martin'],
    ['"First Last"', 'Juan Martin Maldacena', 'Maldacena, Juan Martin'],
    ['surname first without a comma', 'Maldacena Juan', 'Maldacena, Juan Martin'],
    ['an initial', 'J. Maldacena', 'Maldacena, Juan Martin'],
    ['a bare surname in capitals', 'MALDACENA', 'Maldacena, Juan Martin'],
    ['accents the query leaves out', 'Quilez Lasanta, Pablo', 'Quílez Lasanta, Pablo'],
    ['accents the profile leaves out', 'Pötosi', 'Potosi, Quray'],
    ['a hyphen written as a space', 'Garcia Bellido, Juan', 'García-Bellido, Juan'],
    ['a particle with an apostrophe', "Gerard 't Hooft", "'t Hooft, Gerard"],
    ['the last part of a multi-part surname', 'Hooft', "'t Hooft, Gerard"],
    ['one part of a double surname', 'Garcia, Juan', 'García-Bellido, Juan'],
    ['a two-letter surname', 'Li, Wei', 'Li, Wei'],
    ['a profile name without a comma', 'Jane Ghosh', 'Ghosh'],
  ])(
    'sets no surname notice when one profile carries the surname: %s',
    async (_label, query, name) => {
      routePage(authorPage([named(1, 'Mendez, Juan'), named(2, name)]));

      const out = structured<Output>(await run({ query }));

      expect(out.authors).toHaveLength(2);
      expect(out.notice).toBeUndefined();
    },
  );

  it('leaves identifier routes alone, whatever names come back', async () => {
    routePage(authorPage([named(1, 'Roe, Richard')]));

    const out = structured<Output>(await run({ query: 'Jane.Doe.1' }));

    expect(out.matchedAs).toBe('bai');
    expect(out.notice).toBeUndefined();
  });

  it('never matches a profile with no name', async () => {
    routePage(authorPage([{ control_number: 8 }]));

    const out = structured<Output>(await run({ query: 'Doe, Jane' }));

    expect(out.notice).toBe(surnameMiss('Doe, Jane'));
  });

  it('echoes the query through inline(): newlines flatten and brackets are escaped', async () => {
    routePage(authorPage([named(1, 'Roe, Richard')]));

    const result = await run({ query: 'Zz\r\n# injected\n[x](http://evil)' });

    const text = structured<Output>(result).notice ?? '';
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('"Zz # injected \\[x\\](http://evil)"');
    expect(fullText(result)).not.toMatch(/^# injected/m);
  });
});

describe('deleted profiles', () => {
  const deleted = (n: number) => author(n, { deleted: true });

  it('drops a deleted profile, counts it in the notice, and does not mark the page truncated', async () => {
    routePage(authorPage([author(1), deleted(2), author(3)]));

    const result = await run({ query: 'Doe, Jane' });

    const out = structured<Output>(result);
    expect(out.authors.map((a) => a.recid)).toEqual(['1000001', '1000003']);
    expect(out).toMatchObject({ shown: 2, totalCount: 3, truncated: false });
    expect(out.notice).toBe(
      '1 matching profile is marked deleted in INSPIRE and was dropped from this result.',
    );
    expect(bodyText(result)).toContain('**Profiles on this page:** 2');
  });

  it('pluralizes the notice for several dropped profiles', async () => {
    routePage(authorPage([deleted(1), deleted(2), author(3)]));

    const out = structured<Output>(await run({ query: 'Doe, Jane' }));

    expect(out.notice).toBe(
      '2 matching profiles are marked deleted in INSPIRE and were dropped from this result.',
    );
    expect(out.shown).toBe(1);
  });

  it('keeps the dropped-profile notice when every returned profile was deleted', async () => {
    routePage(authorPage([deleted(1), deleted(2)]));

    const out = structured<Output>(await run({ query: 'Doe, Jane' }));

    expect(out).toMatchObject({ authors: [], shown: 0, totalCount: 2, truncated: false });
    expect(out.notice).toContain('2 matching profiles are marked deleted');
  });

  it('puts the next-page line ahead of the dropped-profile line when both apply', async () => {
    routePage(authorPage([author(1), deleted(2), author(3)], { next: true, total: 90 }));

    const out = structured<Output>(await run({ query: 'Doe', limit: 3 }));

    expect(out).toMatchObject({ truncated: true, shown: 2, totalCount: 90, nextPage: 2 });
    expect(out.notice?.startsWith('More results: request page 2 with limit 3.')).toBe(true);
    expect(out.notice).toContain('1 matching profile is marked deleted');
  });
});

describe('profiles and format() parity', () => {
  const rich = () =>
    authorMetadata({
      stub: true,
      positions: [
        {
          institution: 'Example Institute',
          rank: 'STAFF',
          start_date: '2015',
          current: true,
          record: { $ref: 'https://inspirehep.net/api/institutions/902725' },
        },
        { institution: 'Sample University', rank: 'PHD', start_date: '2008', end_date: '2014' },
      ],
      advisors: [
        {
          name: 'Roe, Richard',
          degree_type: 'phd',
          record: { $ref: 'https://inspirehep.net/api/authors/1000002' },
        },
      ],
      arxiv_categories: ['hep-th', 'hep-ph'],
      urls: [{ value: 'https://example.org/jane', description: 'Home page' }],
      awards: [{ name: 'Example Prize', year: 2019 }],
    });

  it('returns each profile in the schema shape and renders every value into content[]', async () => {
    routePage(authorPage([rich(), author(2)]));

    const result = await run({ query: 'Doe, Jane' });

    const out = structured<Output>(result);
    expect(out).toEqual(expect.schemaMatching(searchAuthorsTool.output));
    const text = bodyText(result);
    for (const leaf of leaves(out.authors)) expect(text).toContain(String(leaf));
  });

  it('renders the facts of one profile into labelled lines', async () => {
    routePage(authorPage([rich()]));

    const text = bodyText(await run({ query: 'Jane.Doe.1' }));

    expect(text).toContain('## INSPIRE author profiles, page 1');
    expect(text).toContain(
      '**Page:** 1 · **Limit:** 5 · **Profiles on this page:** 1 · **More pages:** no',
    );
    expect(text).toContain('### 1. Doe, Jane (preferred: Jane Doe)');
    expect(text).toContain(
      '**recid:** 1000001 · **BAI:** Jane.Doe.1 · **ORCID:** 0000-0002-1825-0097 · **INSPIRE ID:** INSPIRE-00000001',
    );
    expect(text).toContain(
      '**Status:** active · **Stub:** yes (unclaimed profile built from paper metadata)',
    );
    expect(text).toContain('**Literature query:** `authors.recid:1000001`');
    expect(text).toContain(
      '**Current positions:**\n- Example Institute (STAFF · 2015– · institution recid 902725)',
    );
    expect(text).toContain('**Past positions:**\n- Sample University (PHD · 2008–2014)');
    expect(text).toContain('**arXiv categories:** hep-th, hep-ph');
    expect(text).toContain('**Advisors:**\n- Roe, Richard (degree phd · author recid 1000002)');
    expect(text).toContain('**Other IDs:** WIKIPEDIA Jane_Doe');
    expect(text).toContain('**URLs:**\n- https://example.org/jane — Home page');
    expect(text).toContain('**Awards:** Example Prize (2019)');
  });

  it('numbers profiles in relevance order and returns them in the order INSPIRE sent', async () => {
    routePage(pageOf(3));

    const result = await run({ query: 'Doe, Jane' });

    expect(structured<Output>(result).authors.map((a) => a.name)).toEqual([
      'Doe, Jane 1',
      'Doe, Jane 2',
      'Doe, Jane 3',
    ]);
    const headings = lines(result).filter((line) => line.startsWith('### '));
    expect(headings).toEqual(['### 1. Doe, Jane 1', '### 2. Doe, Jane 2', '### 3. Doe, Jane 3']);
  });

  it('labels a stub that is not a stub as no', async () => {
    routePage(authorPage([authorMetadata({ stub: false })]));

    const text = bodyText(await run({ query: 'Doe' }));

    expect(text).toContain('**Stub:** no');
  });

  it('renders a position with only an end date or only a start date', async () => {
    routePage(
      authorPage([
        authorMetadata({
          positions: [
            { institution: 'Ends Only', end_date: '2001' },
            { institution: 'Starts Only', start_date: '2020', current: true },
            { institution: 'Undated' },
          ],
        }),
      ]),
    );

    const text = bodyText(await run({ query: 'Doe' }));

    expect(text).toContain('- Ends Only (?–2001)');
    expect(text).toContain('- Starts Only (2020–)');
    expect(text).toContain('- Undated\n');
  });

  it('renders a sparse profile without inventing sections or values', async () => {
    routePage(authorPage([{ control_number: 7, name: { value: 'Roe, Richard' } }]));

    const result = await run({ query: 'Roe, Richard' });

    const [only] = structured<Output>(result).authors;
    expect(only).toEqual({
      recid: '7',
      name: 'Roe, Richard',
      otherIds: [],
      currentPositions: [],
      pastPositions: [],
      arxivCategories: [],
      advisors: [],
      urls: [],
      awards: [],
      literatureQuery: 'authors.recid:7',
    });
    expect(bodyText(result)).toBe(
      [
        '## INSPIRE author profiles, page 1',
        '**Page:** 1 · **Limit:** 5 · **Profiles on this page:** 1 · **More pages:** no',
        '',
        '### 1. Roe, Richard',
        '**recid:** 7',
        '**Literature query:** `authors.recid:7`',
      ].join('\n'),
    );
  });

  it('labels a profile without a name', async () => {
    routePage(authorPage([{ control_number: 8 }]));

    const result = await run({ query: '8' });

    expect(structured<Output>(result).authors[0]?.name).toBe('');
    expect(bodyText(result)).toContain('### 1. (unnamed)');
  });

  it('keeps an identifier row of a scheme outside BAI, ORCID, and INSPIRE ID in otherIds', async () => {
    routePage(
      authorPage([
        authorMetadata({
          ids: [
            { schema: 'INSPIRE BAI', value: 'Jane.Doe.1' },
            { schema: 'TWITTER', value: 'jane_doe' },
            { schema: 'SPIRES', value: 'HEPNAMES-1' },
          ],
        }),
      ]),
    );

    const result = await run({ query: 'Jane.Doe.1' });

    expect(structured<Output>(result).authors[0]?.otherIds).toEqual([
      { schema: 'TWITTER', value: 'jane_doe' },
      { schema: 'SPIRES', value: 'HEPNAMES-1' },
    ]);
    expect(bodyText(result)).toContain('**Other IDs:** TWITTER jane_doe; SPIRES HEPNAMES-1');
  });

  it('prints identifier values as written in content[], so a caller can copy them', async () => {
    routePage(
      authorPage([
        authorMetadata({
          ids: [
            { schema: 'INSPIRE BAI', value: 'J.Ellis_.1' },
            { schema: 'ORCID', value: '0000-0002-1825-0097' },
            { schema: 'INSPIRE ID', value: 'INSPIRE-00123456' },
            { schema: 'WIKIPEDIA', value: 'John_Ellis_(physicist,_born_1946)' },
            { schema: 'TWITTER', value: '_jdoe_' },
            { schema: 'LINKEDIN', value: '[x](javascript:alert(1))' },
          ],
        }),
      ]),
    );

    const result = await run({ query: 'J.Ellis_.1' });

    const [only] = structured<Output>(result).authors;
    expect(only?.bai).toBe('J.Ellis_.1');
    expect(only?.otherIds).toEqual([
      { schema: 'WIKIPEDIA', value: 'John_Ellis_(physicist,_born_1946)' },
      { schema: 'TWITTER', value: '_jdoe_' },
      { schema: 'LINKEDIN', value: '[x](javascript:alert(1))' },
    ]);
    const text = bodyText(result);
    expect(text).toContain(
      '**BAI:** J.Ellis_.1 · **ORCID:** 0000-0002-1825-0097 · **INSPIRE ID:** INSPIRE-00123456',
    );
    expect(text).toContain(
      '**Other IDs:** WIKIPEDIA John_Ellis_(physicist,_born_1946); TWITTER _jdoe_; LINKEDIN \\[x\\](javascript:alert(1))',
    );
  });

  it('renders no content blocks other than text', async () => {
    routePage(pageOf(1));

    const result = await run({ query: 'Doe' });

    expect(result.content.every((block) => block.type === 'text')).toBe(true);
  });
});

describe('upstream text stays out of inline markdown slots', () => {
  const NEL = String.fromCharCode(0x85);
  const LS = String.fromCharCode(0x2028);
  const attack = '\r\n# Injected heading\n**Status:** forged';

  const profile = (decorate: (text: string) => string) =>
    authorMetadata({
      name: { value: decorate('Doe, Jane'), preferred_name: decorate('Jane Doe') },
      ids: [
        { schema: decorate('INSPIRE BAI'), value: decorate('Jane.Doe.1') },
        { schema: decorate('WIKIPEDIA'), value: decorate('Jane_Doe') },
      ],
      positions: [
        {
          institution: decorate('Example Institute'),
          rank: decorate('STAFF'),
          start_date: decorate('2015'),
          current: true,
        },
        {
          institution: decorate('Sample University'),
          rank: decorate('PHD'),
          start_date: decorate('2008'),
          end_date: decorate('2014'),
        },
      ],
      advisors: [{ name: decorate('Roe, Richard'), degree_type: decorate('phd') }],
      arxiv_categories: [decorate('hep-th')],
      urls: [{ value: 'https://example.org/jane', description: decorate('Home page') }],
      awards: [{ name: decorate('Example Prize'), year: 2019 }],
      status: decorate('active'),
    });

  const render = async (decorate: (text: string) => string) => {
    h = startHarness();
    routePage(authorPage([profile(decorate)]));
    return run({ query: 'Doe, Jane' });
  };

  it('keeps the markdown structure of a benign profile when every inline field carries line breaks', async () => {
    const benign = await render((text) => text);
    const hostile = await render((text) => `${text}${attack}`);

    expect(shape(hostile)).toEqual(shape(benign));
    expect(lines(hostile).some((line) => line.startsWith('# Injected'))).toBe(false);
    expect(lines(hostile).filter((line) => line.startsWith('#'))).toEqual([
      '## INSPIRE author profiles, page 1',
      '### 1. Doe, Jane # Injected heading \\*\\*Status:\\*\\* forged (preferred: Jane Doe # Injected heading \\*\\*Status:\\*\\* forged)',
    ]);
  });

  it('flattens the other line separators and keeps structuredContent verbatim', async () => {
    const result = await render((text) => `${text}${LS}x${NEL}y`);

    const [only] = structured<Output>(result).authors;
    expect(only?.name).toBe(`Doe, Jane${LS}x${NEL}y`);
    expect(bodyText(result)).not.toMatch(new RegExp(`[${LS}${NEL}]`));
    expect(bodyText(result)).toContain('### 1. Doe, Jane x y');
  });

  it('escapes link brackets and angle brackets in names, institutions, and award names', async () => {
    routePage(
      authorPage([
        authorMetadata({
          name: { value: 'Doe [Jane] <J>' },
          positions: [{ institution: '[Evil](http://evil.example.org) <i>', current: true }],
          awards: [{ name: '[Prize](http://evil.example.org)' }],
        }),
      ]),
    );

    const result = await run({ query: 'Doe' });

    const text = bodyText(result);
    expect(text).toContain('### 1. Doe \\[Jane\\] &lt;J&gt;');
    expect(text).toContain('- \\[Evil\\](http://evil.example.org) &lt;i&gt;');
    expect(text).toContain('**Awards:** \\[Prize\\](http://evil.example.org)');
    expect(text).not.toContain('<i>');
    expect(structured<Output>(result).authors[0]?.name).toBe('Doe [Jane] <J>');
  });

  it('percent-encodes a hostile URL, NEL included, and keeps it on one line', async () => {
    routePage(
      authorPage([
        authorMetadata({
          urls: [{ value: `https://example.org/a${NEL}b c[d]<e>|f`, description: 'Home' }],
        }),
      ]),
    );

    const result = await run({ query: 'Doe' });

    expect(bodyText(result)).toContain(
      '- https://example.org/a%C2%85b%20c%5Bd%5D%3Ce%3E%7Cf — Home',
    );
    expect(structured<Output>(result).authors[0]?.urls[0]?.url).toBe(
      `https://example.org/a${NEL}b c[d]<e>|f`,
    );
  });

  it('keeps a position, advisor, or link that opens a list item from starting a block', async () => {
    routePage(
      authorPage([
        authorMetadata({
          positions: [
            { institution: '# Forged heading', current: true },
            { institution: '    indented code' },
          ],
          advisors: [{ name: '1. Roe, Richard' }],
          urls: [{ value: '```' }],
        }),
      ]),
    );

    const result = await run({ query: 'Doe' });

    const body = lines(result);
    expect(body.filter((line) => line.startsWith('#'))).toEqual([
      '## INSPIRE author profiles, page 1',
      '### 1. Doe, Jane (preferred: Jane Doe)',
    ]);
    expect(body).toContain('- \\# Forged heading');
    expect(body).toContain('- indented code');
    expect(body).toContain('- 1\\. Roe, Richard');
    expect(body).toContain('- \\```');
    expect(structured<Output>(result).authors[0]?.currentPositions[0]?.institution).toBe(
      '# Forged heading',
    );
  });
});

describeFailureClasses({
  label: 'cern_inspire_search_authors',
  contract: errors,
  invalidQuery: true,
  path: '/api/authors',
  run: (options) => run({ query: 'Doe, Jane' }, options),
  install: (harness, reply) => harness.route('/authors', reply),
  unreadable: [
    ['an HTML page', () => htmlResponse()],
    ['truncated JSON', () => new Response('{"hits":{"total":', { status: 200 })],
    ['an empty body', () => new Response('', { status: 200 })],
    ['JSON without the search envelope', () => jsonResponse({ hits: {} })],
    [
      'an envelope whose total is not a number',
      () => jsonResponse({ hits: { total: '3', hits: [] } }),
    ],
    ['an envelope built for another route', () => jsonResponse(searchBody([]).links)],
  ],
});
