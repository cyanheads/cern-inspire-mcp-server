/**
 * @fileoverview Tests for cern_inspire_search_institutions through
 * `runToolContract` over an `InspireService` on a fake fetch: input validation
 * and blank-as-unset handling, the recid / exact-name / free-text query routing,
 * the required enrichment on zero-result, under-cap, and capped pages, paging
 * (the 10,000-result window, continuation from `links.next`, the past-the-end
 * notice), captured records (a department and its "(main)" parent, an inactive
 * institute with every relation) on both surfaces, sparse records, upstream text
 * kept out of inline markdown slots, the descriptions that route other tools here,
 * and the shared upstream failure classes on the wire. No live network.
 * @module tests/tools/search-institutions.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type RunToolContractOptions, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getCitationSummaryTool } from '@/mcp-server/tools/definitions/get-citation-summary.tool.js';
import { getPaperTool } from '@/mcp-server/tools/definitions/get-paper.tool.js';
import { allToolDefinitions } from '@/mcp-server/tools/definitions/index.js';
import { searchInstitutionsTool } from '@/mcp-server/tools/definitions/search-institutions.tool.js';
import type { RawInstitutionMetadata } from '@/services/inspire/types.js';
import { describeFailureClasses } from '../fixtures/failure-suite.js';
import {
  emptyBody,
  htmlResponse,
  INSTITUTIONS,
  institutionMetadata,
  institutionPage,
  jsonResponse,
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

type Input = z.input<typeof searchInstitutionsTool.input>;
type Output = z.infer<typeof searchInstitutionsTool.output> & {
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
  runToolContract(searchInstitutionsTool, input, options);

/** A call with arguments the schema's input type would not accept, as a misbehaving client sends. */
const runRaw = (input: Record<string, unknown>) => run(input as Input);

/** Institution `n`: its own recid and recorded name, the department's other fields. */
const institution = (n: number, overrides: Partial<RawInstitutionMetadata> = {}) =>
  institutionMetadata({ control_number: 1_000_000 + n, legacy_ICN: `Inst ${n}`, ...overrides });

/** Records numbered from `first`, so a later page carries its own recids and names. */
const rows = (first: number, count: number) =>
  Array.from({ length: count }, (_, i) => institution(first + i));

const pageOf = (count: number, options: { next?: boolean; total?: number } = {}) =>
  institutionPage(rows(1, count), options);

const routePage = (body: unknown = pageOf(1)) => h.route('/institutions', jsonResponse(body));

const lines = (result: ToolResult) => bodyText(result).split('\n');

const params = () => h.requests[0]?.params;

/** The first ten characters of each body line: the markdown structure, not the upstream words. */
const shape = (result: ToolResult) => lines(result).map((line) => line.slice(0, 10));

const errors = searchInstitutionsTool.errors ?? [];
const hint = (reason: string) => errors.find((e) => e.reason === reason)?.recovery;

const ZERO_HIT_ADVICE =
  'Try fewer name words or the city; legacy_ICN:"NAME" matches one recorded name exactly, case and punctuation included, as a paper\'s author affiliations list it in cern_inspire_get_paper.';

const recidMiss = (recid: string) =>
  `No INSPIRE institution record has recid ${recid}; search by name words or by legacy_ICN:"NAME" instead.`;

describe('registration', () => {
  it('is registered with the other tools, read-only and open-world', () => {
    expect(allToolDefinitions).toContain(searchInstitutionsTool);
    expect(searchInstitutionsTool.name).toBe('cern_inspire_search_institutions');
    expect(searchInstitutionsTool.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    });
  });
});

describe('input', () => {
  it('advertises budgets above the result ceiling', () => {
    const schema = searchInstitutionsTool.input.toJSONSchema({ io: 'input' });
    expect(schema.properties?.limit).toMatchObject({ type: 'integer', minimum: 1, default: 25 });
    expect(schema.properties?.limit).not.toHaveProperty('maximum', 25);
    expect(searchInstitutionsTool.input.safeParse({ query: 'x', limit: 1000000 }).success).toBe(
      true,
    );
  });

  it('applies the default limit 25 and page 1 and sends only q, fields, size, and page', async () => {
    routePage();

    const result = await run({ query: 'University of Washington' });

    expect(result.isError).toBeFalsy();
    expect(h.requests[0]?.path).toBe('/api/institutions');
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['fields', 'page', 'q', 'size']);
    expect(params()?.get('q')).toBe('University of Washington');
    expect(params()?.get('size')).toBe('25');
    expect(params()?.get('page')).toBe('1');
    expect(structured<Output>(result)).toMatchObject({ cap: 25, limit: 25, page: 1 });
  });

  it('returns at most 25 rows for limit 30, with the reduction notice on both surfaces', async () => {
    routePage(pageOf(25, { next: true, total: 27 }));

    const result = await run({ query: 'University of Washington', limit: 30 });

    const out = structured<Output>(result);
    expect(params()?.get('size')).toBe('25');
    expect(out.institutions).toHaveLength(25);
    expect(out).toMatchObject({ cap: 25, limit: 25, shown: 25, totalCount: 27, truncated: true });
    expect(out.notice).toBe('More results: request page 2 with limit 25. limit 30 reduced to 25.');
    expect(fullText(result)).toContain('limit 30 reduced to 25.');
    expect(bodyText(result)).toContain('**Limit:** 25');
  });

  it.each([25, 26, 1000000])(
    'accepts budget %i and discloses a reduction on an empty result',
    async (requested) => {
      routePage(emptyBody());

      const result = await run({ query: 'Nowhere', limit: requested });

      const out = structured<Output>(result);
      expect(out).toMatchObject({ cap: 25, shown: 0, truncated: false });
      expect(params()?.get('size')).toBe('25');
      if (requested > 25) {
        expect(out.notice).toContain(`limit ${requested} reduced to 25`);
        expect(fullText(result)).toContain(`limit ${requested} reduced to 25`);
      } else {
        expect(out.notice).not.toContain('reduced');
      }
    },
  );

  it('reads a blank limit and a blank page as unset', async () => {
    routePage();

    const result = await run({ query: 'Tokyo', limit: '', page: '' } as Input);

    expect(result.isError).toBeFalsy();
    expect([params()?.get('size'), params()?.get('page')]).toEqual(['25', '1']);
    expect(structured<Output>(result)).toMatchObject({ cap: 25, page: 1 });
  });

  it('trims the query before sending it, and accepts exactly 200 characters', async () => {
    routePage();

    await run({ query: '   University of Tokyo  ' });
    await run({ query: 'x'.repeat(200) });

    expect(params()?.get('q')).toBe('University of Tokyo');
    expect(h.requests[1]?.params.get('q')).toHaveLength(200);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing query', {}],
    ['an empty query', { query: '' }],
    ['a whitespace-only query', { query: '   \t ' }],
    ['a query over 200 characters', { query: 'x'.repeat(201) }],
    ['a boolean query', { query: true }],
    ['limit 0', { query: 'Tokyo', limit: 0 }],
    ['a negative limit', { query: 'Tokyo', limit: -1 }],
    ['a fractional limit', { query: 'Tokyo', limit: 2.5 }],
    ['a limit given as text', { query: 'Tokyo', limit: '5' }],
    ['page 0', { query: 'Tokyo', page: 0 }],
    ['a fractional page', { query: 'Tokyo', page: 1.5 }],
    ['a page given as text', { query: 'Tokyo', page: '2' }],
  ])('rejects %s as InvalidParams without calling INSPIRE', async (_label, input) => {
    const result = await runRaw(input);

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('cern_inspire_search_institutions');
    expect(h.requests).toHaveLength(0);
  });
});

describe('query routing', () => {
  it.each([
    ['name words', 'University of Washington', 'University of Washington'],
    ['an exact recorded name', 'legacy_ICN:"Tokyo U."', 'legacy_ICN:"Tokyo U."'],
    ['a lower-case exact name, left as written', 'legacy_ICN:"tokyo u."', 'legacy_ICN:"tokyo u."'],
    ['an institution recid', '903338', 'control_number:903338'],
    ['a nine-digit recid', '987654321', 'control_number:987654321'],
    ['a recid with surrounding blanks', '  903338 ', 'control_number:903338'],
    ['ten digits, which are no recid', '1234567890', '1234567890'],
    ['a name that starts with digits', '3M Company', '3M Company'],
  ])('sends %s as q=%s', async (_label, query, q) => {
    routePage();

    await run({ query });

    expect(params()?.get('q')).toBe(q);
  });

  it('accepts a recid sent as a JSON number, as some clients send it', async () => {
    routePage();

    const result = await runRaw({ query: 903338 });

    expect(result.isError).toBeFalsy();
    expect(params()?.get('q')).toBe('control_number:903338');
  });

  it('returns exactly the record an exact recorded name selects', async () => {
    routePage(institutionPage([INSTITUTIONS.tokyo]));

    const result = await run({ query: 'legacy_ICN:"Tokyo U."' });

    const out = structured<Output>(result);
    expect(params()?.get('q')).toBe('legacy_ICN:"Tokyo U."');
    expect(out.institutions.map((i) => i.recid)).toEqual(['903273']);
    expect(out.institutions[0]).toMatchObject({
      legacyIcn: 'Tokyo U.',
      literatureQuery: 'affid:903273',
    });
    expect(out.notice).toBeUndefined();
  });

  it('answers a recid with that record, and an unknown recid with no rows and the recid notice', async () => {
    routePage(institutionPage([INSTITUTIONS.uwPhysics]));
    const found = structured<Output>(await run({ query: '903338' }));
    h = startHarness();
    routePage(emptyBody());
    const missing = structured<Output>(await run({ query: '987654321' }));

    expect(found.institutions.map((i) => i.recid)).toEqual(['903338']);
    expect(found.notice).toBeUndefined();
    expect(missing.institutions).toEqual([]);
    expect(missing.notice).toBe(recidMiss('987654321'));
    expect(params()?.get('q')).toBe('control_number:987654321');
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
      expect(hint(reason)).toContain('cern_inspire_search_institutions');
      expect(hint(reason)).toContain('legacy_ICN:"NAME"');
    }
    expect(hint('upstream_unreadable')).toBe(
      'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_search_institutions with the same page and limit.',
    );
  });

  it('spells the recovery placeholders in capitals, which survive a markdown-to-HTML render', () => {
    for (const { reason } of errors) expect(hint(reason)).not.toMatch(/<[A-Za-z]/);
  });
});

describe('descriptions', () => {
  const field = (
    name: keyof typeof searchInstitutionsTool.output.shape.institutions.element.shape,
  ) => searchInstitutionsTool.output.shape.institutions.element.shape[name].description ?? '';

  it('says rows keep INSPIRE order, that departments sit under a "(main)" parent, and that affid clauses join with or', () => {
    const { description } = searchInstitutionsTool;

    expect(description).toContain("INSPIRE's order, not by size");
    expect(description).toContain('"(main)" record');
    expect(description).toContain('affid:N matches one record; join several with or');
    expect(description).toContain('legacy_ICN:"Tokyo U."');
  });

  it('says legacy_ICN matches one name exactly, and that or-joined legacy_ICN clauses match nothing', () => {
    const query = searchInstitutionsTool.input.shape.query.description ?? '';

    expect(query).toContain('legacy_ICN:"NAME" (case-sensitive');
    expect(query).toContain('legacy_ICN clauses joined with or match nothing');
    expect(query).toContain('digits only');
  });

  it('names the affid query, both tools that take it, and the or join in literatureQuery', () => {
    const description = field('literatureQuery');

    expect(description).toContain('affid:N');
    expect(description).toContain('cern_inspire_search_literature');
    expect(description).toContain('cern_inspire_get_citation_summary');
    expect(description).toContain('affid:903338 or affid:945165');
  });

  it('ties legacyIcn to paper affiliations, aff NAME, and the exact-name query', () => {
    const description = field('legacyIcn');

    expect(description).toContain('paper affiliations');
    expect(description).toContain('aff NAME');
    expect(description).toContain('legacy_ICN:"NAME"');
  });

  it('describes numberOfPapers as a stored count that can differ from the literatureQuery match', () => {
    expect(field('numberOfPapers')).toBe(
      "INSPIRE's stored paper count; it can differ from the number of records literatureQuery matches.",
    );
  });

  it('routes a paper affiliation and a citation-summary institution query to this tool', () => {
    const affiliations =
      getPaperTool.output.shape.authors.element.shape.affiliations.description ?? '';
    const query = getCitationSummaryTool.input.shape.query.description ?? '';

    expect(affiliations).toContain('cern_inspire_search_institutions');
    expect(affiliations).toContain('legacy_ICN:"NAME"');
    expect(query).toContain('"affid:902725"');
    expect(query).toContain('cern_inspire_search_institutions');
    expect(query).toContain('with or');
  });
});

describe('required enrichment', () => {
  it('writes every required field on a zero-result page', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'Zzzz' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      institutions: [],
      page: 1,
      limit: 25,
      hasMore: false,
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 25,
    });
    expect(out.nextPage).toBeUndefined();
    expect(fullText(result)).toContain('**0 total**');
    expect(bodyText(result)).toBe(
      [
        '## INSPIRE institutions, page 1',
        '**Page:** 1 · **Limit:** 25 · **Institutions on this page:** 0 · **More pages:** no',
      ].join('\n'),
    );
  });

  it('writes every required field on an under-cap page and sets no notice', async () => {
    routePage(pageOf(3));

    const result = await run({ query: 'Seattle', limit: 10 });

    const out = structured<Output>(result);
    expect(out.institutions).toHaveLength(3);
    expect(out).toMatchObject({ totalCount: 3, truncated: false, shown: 3, cap: 10 });
    expect(out.notice).toBeUndefined();
    expect(fullText(result)).toContain('**3 total**');
  });

  it('keeps a page of exactly limit records under the cap when nothing else matched', async () => {
    routePage(pageOf(25));

    const out = structured<Output>(await run({ query: 'Seattle' }));

    expect(out).toMatchObject({ shown: 25, cap: 25, truncated: false, totalCount: 25 });
    expect(out.notice).toBeUndefined();
  });
});

describe('paging', () => {
  const pageParam = (n = 0) => h.requests[n]?.params.get('page');

  it('marks a page with a next link truncated and points at the next page', async () => {
    routePage(pageOf(25, { next: true, total: 27 }));

    const result = await run({ query: 'University of Washington' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      page: 1,
      limit: 25,
      hasMore: true,
      truncated: true,
      shown: 25,
      totalCount: 27,
      nextPage: 2,
      notice: 'More results: request page 2 with limit 25.',
    });
    expect(fullText(result)).toContain('**Next page:** 2');
    expect(fullText(result)).toContain('More results: request page 2 with limit 25.');
    expect(bodyText(result)).toContain('**More pages:** yes');
  });

  it("leaves INSPIRE's last page untruncated and numbers its rows on from the first page", async () => {
    routePage(institutionPage(rows(26, 2), { total: 27 }));

    const result = await run({ query: 'University of Washington', page: 2 });

    const out = structured<Output>(result);
    expect(pageParam()).toBe('2');
    expect(out).toMatchObject({
      page: 2,
      hasMore: false,
      truncated: false,
      shown: 2,
      totalCount: 27,
    });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBeUndefined();
    expect(fullText(result)).not.toContain('Next page');
    expect(lines(result).filter((line) => line.startsWith('### '))).toEqual([
      '### 26. Inst 26',
      '### 27. Inst 27',
    ]);
  });

  it('counts the next page from the requested page and the effective limit', async () => {
    routePage(institutionPage(rows(26, 25), { next: true, total: 333 }));

    const out = structured<Output>(await run({ query: 'University', page: 2, limit: 1000 }));

    expect(out.nextPage).toBe(3);
    expect(out.notice).toBe(
      'More results: request page 3 with limit 25. limit 1000 reduced to 25.',
    );
  });

  it('names the limit in the next-page notice, so sending exactly what it says keeps limit 10 rather than the default 25', async () => {
    routePage(pageOf(10, { next: true, total: 75 }));

    const result = await run({ query: 'University of Tokyo', limit: 10 });
    const recipe = /request page (\d+) with limit (\d+)\./.exec(
      structured<Output>(result).notice ?? '',
    );
    await run({
      query: 'University of Tokyo',
      page: Number(recipe?.[1]),
      limit: Number(recipe?.[2]),
    });

    expect(recipe?.slice(1)).toEqual(['2', '10']);
    expect(fullText(result)).toContain(recipe?.[0]);
    expect(h.requests.map((r) => [r.params.get('page'), r.params.get('size')])).toEqual([
      ['1', '10'],
      ['2', '10'],
    ]);
    expect(searchInstitutionsTool.enrichment?.nextPage?.description).toContain('same limit');
  });

  it('reports a page past the end alone: the query did match', async () => {
    routePage(institutionPage([], { total: 27 }));

    const result = await run({ query: 'University of Washington', page: 3 });

    const out = structured<Output>(result);
    expect(out).toMatchObject({ institutions: [], shown: 0, totalCount: 27, hasMore: false });
    expect(out.notice).toBe('Page 3 is past the last page (2); request a lower page.');
    expect(fullText(result)).toContain(out.notice as string);
    expect(fullText(result)).not.toContain('No INSPIRE institution matched');
  });

  it('gives the zero-hit notice, not the past-the-end one, when nothing matched on a later page', async () => {
    routePage(emptyBody());

    const out = structured<Output>(await run({ query: 'Zzzz', page: 3 }));

    expect(out.notice).toBe(`No INSPIRE institution matched "Zzzz". ${ZERO_HIT_ADVICE}`);
  });

  it('fails page × limit over 10,000 as beyond_result_window, before any request', async () => {
    const result = await run({ query: 'University', page: 401 });

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
    [10_000, 1, false],
    [10_001, 1, true],
  ])('page %i × limit %i: past the window is %s', async (page, limit, rejected) => {
    routePage(emptyBody());

    const result = await run({ query: 'University', page, limit });

    expect(result.isError === true).toBe(rejected);
    expect(h.requests).toHaveLength(rejected ? 0 : 1);
  });

  it('checks the window against the effective limit, not the requested one', async () => {
    routePage(pageOf(1, { total: 20_000 }));

    const allowed = await run({ query: 'University', page: 400, limit: 26 });
    const refused = await run({ query: 'University', page: 401, limit: 1_000_000 });

    expect(allowed.isError).toBeFalsy();
    expect(errorEnvelope(refused).data).toMatchObject({
      reason: 'beyond_result_window',
      page: 401,
      limit: 25,
    });
    expect(h.requests).toHaveLength(1);
  });

  it('withholds a next page that would cross the window and says to narrow', async () => {
    routePage(institutionPage(rows(9976, 25), { next: true, total: 20_000 }));

    const result = await run({ query: 'University', page: 400 });

    const out = structured<Output>(result);
    expect(out).toMatchObject({ truncated: true, hasMore: true, shown: 25 });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBe(
      'INSPIRE serves only the first 10,000 results of a query; narrow it with more name words, the city, or the exact legacy_ICN:"NAME" form to reach the rest.',
    );
    expect(fullText(result)).not.toContain('Next page');
  });

  it('offers the last reachable next page at the 10,000-result window edge', async () => {
    routePage(institutionPage(rows(9951, 25), { next: true, total: 20_000 }));

    const out = structured<Output>(await run({ query: 'University', page: 399 }));

    expect(out.nextPage).toBe(400);
  });
});

describe('zero-hit notice', () => {
  it('names a lower-case exact name and the exact legacy_ICN:"NAME" form on both surfaces', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'legacy_ICN:"tokyo u."' });

    const out = structured<Output>(result);
    expect(out.institutions).toEqual([]);
    expect(out.notice).toBe(
      `No INSPIRE institution matched "legacy_ICN:"tokyo u."". ${ZERO_HIT_ADVICE}`,
    );
    expect(fullText(result)).toContain('legacy_ICN:"NAME" matches one recorded name exactly');
    expect(fullText(result)).not.toMatch(/<[A-Za-z]/);
  });

  it('echoes the query through callerEcho(): newlines flatten and brackets are escaped', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'Tokyo\r\n# injected\n[x](http://evil) <b>' });

    const text = structured<Output>(result).notice ?? '';
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('Tokyo # injected \\[x\\](http://evil) &lt;b>');
    expect(fullText(result)).not.toMatch(/^# injected/m);
  });

  it('echoes a wildcard query as written, so it can be sent again', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'Tokyo*' });

    expect(fullText(result)).toContain('No INSPIRE institution matched "Tokyo*". ');
  });

  it.each<[string, unknown, string]>([
    ['a recid', '987654321', '987654321'],
    ['a one-digit recid', '7', '7'],
    ['a recid with surrounding blanks', '  987654321 ', '987654321'],
    ['a recid sent as a JSON number', 987654321, '987654321'],
  ])(
    'answers a miss on %s with the recid notice on both surfaces, not name advice',
    async (_label, query, recid) => {
      routePage(emptyBody());

      const result = await runRaw({ query });

      const out = structured<Output>(result);
      expect(params()?.get('q')).toBe(`control_number:${recid}`);
      expect(out).toMatchObject({ institutions: [], shown: 0, totalCount: 0, truncated: false });
      expect(out.notice).toBe(recidMiss(recid));
      expect(fullText(result)).toContain(recidMiss(recid));
      expect(fullText(result)).not.toContain('Try fewer name words');
      expect(fullText(result)).not.toMatch(/<[A-Za-z]/);
    },
  );

  it('gives the recid notice, not the past-the-end one, when a recid misses on a later page', async () => {
    routePage(emptyBody());

    const out = structured<Output>(await run({ query: '987654321', page: 2 }));

    expect(out.notice).toBe(recidMiss('987654321'));
  });

  it('keeps the recid notice after a limit reduction', async () => {
    routePage(emptyBody());

    const out = structured<Output>(await run({ query: '987654321', limit: 30 }));

    expect(out.notice).toBe(`limit 30 reduced to 25. ${recidMiss('987654321')}`);
  });

  it('keeps the name advice for ten digits and for a name that starts with digits, which go as free text', async () => {
    routePage(emptyBody());

    const tenDigits = structured<Output>(await run({ query: '1234567890' }));
    const name = structured<Output>(await run({ query: '3M Company' }));

    expect(h.requests.map((r) => r.params.get('q'))).toEqual(['1234567890', '3M Company']);
    expect(tenDigits.notice).toBe(
      `No INSPIRE institution matched "1234567890". ${ZERO_HIT_ADVICE}`,
    );
    expect(name.notice).toBe(`No INSPIRE institution matched "3M Company". ${ZERO_HIT_ADVICE}`);
  });
});

describe('records and format() parity', () => {
  /** A University of Washington page: the main record second and physics nineteenth, as INSPIRE ranks them. */
  const uwPage = () => {
    const records = rows(1, 25);
    records[1] = INSTITUTIONS.uwMain;
    records[18] = INSTITUTIONS.uwPhysics;
    return institutionPage(records, { next: true, total: 27 });
  };

  it('lists the main record and its physics department at the default limit, each with its affid query', async () => {
    routePage(uwPage());

    const result = await run({ query: 'University of Washington' });

    const out = structured<Output>(result);
    expect(params()?.get('size')).toBe('25');
    expect(out.institutions[1]).toMatchObject({
      recid: '945165',
      legacyIcn: 'U. Washington, Seattle (main)',
      literatureQuery: 'affid:945165',
    });
    expect(out.institutions[18]).toEqual({
      recid: '903338',
      legacyIcn: 'Washington U., Seattle',
      hierarchy: [{ name: 'Department of physics' }, { name: 'University of Washington' }],
      institutionTypes: ['University'],
      cities: ['Seattle'],
      countryCodes: ['US'],
      numberOfPapers: 10812,
      relatedRecords: [{ recid: '945165', relation: 'parent' }],
      literatureQuery: 'affid:903338',
    });
    expect(lines(result)).toContain('### 2. U. Washington, Seattle (main)');
    expect(lines(result)).toContain('### 19. Washington U., Seattle');
  });

  it('returns each record in the schema shape and renders every value into content[]', async () => {
    routePage(
      institutionPage([
        INSTITUTIONS.uwMain,
        INSTITUTIONS.uwPhysics,
        INSTITUTIONS.cenpa,
        INSTITUTIONS.tokyo,
        INSTITUTIONS.zeuthen,
      ]),
    );

    const result = await run({ query: 'x' });

    const out = structured<Output>(result);
    expect(out).toEqual(expect.schemaMatching(searchInstitutionsTool.output));
    const text = bodyText(result);
    for (const leaf of leaves(out.institutions)) expect(text).toContain(String(leaf));
  });

  it('renders a department record into labelled lines', async () => {
    routePage(institutionPage([INSTITUTIONS.uwPhysics]));

    expect(bodyText(await run({ query: 'x' }))).toBe(
      [
        '## INSPIRE institutions, page 1',
        '**Page:** 1 · **Limit:** 25 · **Institutions on this page:** 1 · **More pages:** no',
        '',
        '### 1. Washington U., Seattle',
        '**recid:** 903338 · **Papers (INSPIRE count):** 10812',
        '**Hierarchy (most specific first):** Department of physics; University of Washington',
        '**Types:** University',
        '**Cities:** Seattle · **Country codes:** US',
        '**Related institution recids:** parent 945165',
        '**Literature query:** affid:903338',
      ].join('\n'),
    );
  });

  it('renders an inactive institute with every relation in record order', async () => {
    routePage(institutionPage([INSTITUTIONS.zeuthen]));

    const result = await run({ query: 'Zeuthen' });

    expect(structured<Output>(result).institutions[0]?.inactive).toBe(true);
    expect(bodyText(result)).toContain(
      [
        '### 1. IfH, Zeuthen',
        '**recid:** 2180671 · **Papers (INSPIRE count):** 14 · **Inactive:** yes',
        '**Types:** Research Center',
        '**Cities:** Zeuthen · **Country codes:** DD',
        '**Related institution recids:** parent 3094652; parent 3094653; predecessor 3095957; successor 902666',
        '**Literature query:** affid:2180671',
      ].join('\n'),
    );
  });

  it('renders acronyms beside names and alone, three levels deep', async () => {
    routePage(
      institutionPage([
        institutionMetadata({
          institution_hierarchy: [
            { acronym: 'NTG' },
            { name: 'Department of physics', acronym: 'PHYS' },
            { name: 'University of Washington' },
          ],
        }),
      ]),
    );

    expect(bodyText(await run({ query: 'x' }))).toContain(
      '**Hierarchy (most specific first):** NTG; Department of physics (PHYS); University of Washington',
    );
  });

  it('says so for a related record without a relation type, and prints inactive false and zero papers', async () => {
    routePage(
      institutionPage([
        institutionMetadata({
          inactive: false,
          number_of_papers: 0,
          related_records: [{ record: { $ref: 'https://inspirehep.net/institutions/911469' } }],
        }),
      ]),
    );

    const text = bodyText(await run({ query: 'x' }));

    expect(text).toContain('**recid:** 903338 · **Papers (INSPIRE count):** 0 · **Inactive:** no');
    expect(text).toContain('**Related institution recids:** 911469 (no relation type)');
  });

  it('gathers several addresses into one location line', async () => {
    routePage(
      institutionPage([
        institutionMetadata({
          addresses: [
            { cities: ['Batavia', 'Chicago'], country_code: 'US' },
            { cities: ['Geneva'], country_code: 'CH' },
          ],
        }),
      ]),
    );

    const result = await run({ query: 'x' });

    expect(structured<Output>(result).institutions[0]).toMatchObject({
      cities: ['Batavia', 'Chicago', 'Geneva'],
      countryCodes: ['US', 'CH'],
    });
    expect(bodyText(result)).toContain(
      '**Cities:** Batavia, Chicago, Geneva · **Country codes:** US, CH',
    );
  });

  it('renders a sparse record without inventing sections or values', async () => {
    routePage(institutionPage([{ control_number: 5 }]));

    const result = await run({ query: '5' });

    const [only] = structured<Output>(result).institutions;
    expect(only).toEqual({
      recid: '5',
      hierarchy: [],
      institutionTypes: [],
      cities: [],
      countryCodes: [],
      relatedRecords: [],
      literatureQuery: 'affid:5',
    });
    expect(result.structuredContent).toEqual(expect.schemaMatching(searchInstitutionsTool.output));
    expect(bodyText(result)).toBe(
      [
        '## INSPIRE institutions, page 1',
        '**Page:** 1 · **Limit:** 25 · **Institutions on this page:** 1 · **More pages:** no',
        '',
        '### 1. (no recorded name)',
        '**recid:** 5',
        '**Literature query:** affid:5',
      ].join('\n'),
    );
  });

  it('keeps INSPIRE order on both surfaces, not paper-count order', async () => {
    routePage(institutionPage([INSTITUTIONS.zeuthen, INSTITUTIONS.tokyo, INSTITUTIONS.uwMain]));

    const result = await run({ query: 'x' });

    expect(structured<Output>(result).institutions.map((i) => i.recid)).toEqual([
      '2180671',
      '903273',
      '945165',
    ]);
    expect(lines(result).filter((line) => line.startsWith('### '))).toEqual([
      '### 1. IfH, Zeuthen',
      '### 2. Tokyo U.',
      '### 3. U. Washington, Seattle (main)',
    ]);
  });

  it('renders no content blocks other than text', async () => {
    routePage();

    const result = await run({ query: 'x' });

    expect(result.content.every((block) => block.type === 'text')).toBe(true);
  });
});

describe('upstream text stays out of inline markdown slots', () => {
  const NEL = String.fromCharCode(0x85);
  const LS = String.fromCharCode(0x2028);
  const attack = '\r\n# Injected heading\n**recid:** forged';

  const record = (decorate: (text: string) => string): RawInstitutionMetadata =>
    institutionMetadata({
      legacy_ICN: decorate('Washington U., Seattle'),
      institution_hierarchy: [
        { name: decorate('Department of physics'), acronym: decorate('PHYS') },
        { name: decorate('University of Washington') },
      ],
      institution_type: [decorate('University')],
      addresses: [{ cities: [decorate('Seattle')], country_code: decorate('US') }],
      related_records: [
        {
          record: { $ref: 'https://inspirehep.net/api/institutions/945165' },
          relation: decorate('parent'),
        },
      ],
    });

  const render = async (decorate: (text: string) => string) => {
    h = startHarness();
    routePage(institutionPage([record(decorate)]));
    return run({ query: 'x' });
  };

  it('keeps the markdown structure of a benign record when every inline field carries line breaks', async () => {
    const benign = await render((text) => text);
    const hostile = await render((text) => `${text}${attack}`);

    expect(shape(hostile)).toEqual(shape(benign));
    expect(lines(hostile).filter((line) => line.startsWith('#'))).toEqual([
      '## INSPIRE institutions, page 1',
      '### 1. Washington U., Seattle # Injected heading \\*\\*recid:\\*\\* forged',
    ]);
  });

  it('flattens the other line separators and keeps structuredContent verbatim', async () => {
    const result = await render((text) => `${text}${LS}x${NEL}y`);

    const [only] = structured<Output>(result).institutions;
    expect(only?.legacyIcn).toBe(`Washington U., Seattle${LS}x${NEL}y`);
    expect(bodyText(result)).not.toMatch(new RegExp(`[${LS}${NEL}]`));
    expect(bodyText(result)).toContain('### 1. Washington U., Seattle x y');
  });

  it('escapes link brackets and angle brackets in names, hierarchy, and cities', async () => {
    routePage(
      institutionPage([
        institutionMetadata({
          legacy_ICN: '[Evil](http://evil.example.org)',
          institution_hierarchy: [{ name: '<b>Physics</b>', acronym: '*P*' }],
          addresses: [{ cities: ['_Seattle_'] }],
        }),
      ]),
    );

    const result = await run({ query: 'x' });

    const text = bodyText(result);
    expect(text).toContain('### 1. \\[Evil\\](http://evil.example.org)');
    expect(text).toContain('&lt;b&gt;Physics&lt;/b&gt; (\\*P\\*)');
    expect(text).toContain('**Cities:** \\_Seattle\\_');
    expect(structured<Output>(result).institutions[0]?.legacyIcn).toBe(
      '[Evil](http://evil.example.org)',
    );
  });
});

describeFailureClasses({
  label: 'cern_inspire_search_institutions',
  contract: errors,
  invalidQuery: true,
  path: '/api/institutions',
  run: (options) => run({ query: 'Tokyo' }, options),
  install: (harness, reply) => harness.route('/institutions', reply),
  unreadable: [
    ['an HTML page', () => htmlResponse()],
    ['truncated JSON', () => new Response('{"hits":{"total":', { status: 200 })],
    ['an empty body', () => new Response('', { status: 200 })],
    ['JSON without the search envelope', () => jsonResponse({ hits: {} })],
    ['an envelope whose hits are not a list', () => jsonResponse({ hits: { total: 1, hits: {} } })],
  ],
});
