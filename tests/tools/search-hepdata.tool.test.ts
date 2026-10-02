/**
 * @fileoverview Tests for cern_inspire_search_hepdata through `runToolContract`
 * over an `InspireService` on a fake fetch: input validation and blank-as-unset
 * handling, request mapping, the 10,000-result window contract, the required
 * enrichment on a zero-result page, an under-cap page, and capped pages, the
 * zero-hit and past-the-end notices, the HEPData fields derived from INSPIRE's
 * `data` collection (`recordDoi`, `hepdataRecid`, `latestVersion`, `tableCount`,
 * `hepdataUrl`), `format()` parity with `structuredContent`, upstream text kept
 * out of inline markdown slots, and the shared upstream failure classes on the
 * wire. No live network.
 * @module tests/tools/search-hepdata.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type RunToolContractOptions,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchHepdataTool } from '@/mcp-server/tools/definitions/search-hepdata.tool.js';
import { describeFailureClasses } from '../fixtures/failure-suite.js';
import { MARKUP_AS_TEXT, PUBLISHER_MARKUP } from '../fixtures/inspire-markup.js';
import {
  dataMetadata,
  dataPage,
  emptyBody,
  htmlResponse,
  jsonResponse,
  omit,
  TWO_RECORD_PAPERS,
  TWO_VERSION_DOIS,
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

type Input = z.input<typeof searchHepdataTool.input>;
type Output = z.infer<typeof searchHepdataTool.output> & {
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
  runToolContract(searchHepdataTool, input, options);

/** A call with arguments the schema's input type would not accept, as a misbehaving client sends. */
const runRaw = (input: Record<string, unknown>) => run(input as Input);

const record = (n: number, overrides: Parameters<typeof dataMetadata>[0] = {}) =>
  dataMetadata({
    control_number: 1860000 + n,
    titles: [{ title: `Measurement ${n}` }],
    literature: [{ control_number: 1680000 + n }],
    ...overrides,
  });

const pageOf = (count: number, options: { next?: boolean; total?: number } = {}) =>
  dataPage(
    Array.from({ length: count }, (_, i) => record(i + 1)),
    options,
  );

const routePage = (body: unknown = pageOf(1)) => h.route('/data', jsonResponse(body));

const lines = (result: ToolResult) => bodyText(result).split('\n');

const params = () => h.requests[0]?.params;

/** The first ten characters of each body line: the markdown structure, not the upstream words. */
const shape = (result: ToolResult) => lines(result).map((line) => line.slice(0, 10));

const errors = searchHepdataTool.errors ?? [];
const hint = (reason: string) => errors.find((e) => e.reason === reason)?.recovery;

describe('input', () => {
  it('applies the defaults and sends only q, size, page, and fields', async () => {
    routePage();

    const result = await run({ query: 'top pair 13 TeV' });

    expect(result.isError).toBeFalsy();
    expect(h.requests[0]?.path).toBe('/api/data');
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['fields', 'page', 'q', 'size']);
    expect(params()?.get('page')).toBe('1');
    expect(params()?.get('size')).toBe('10');
    expect(structured<Output>(result)).toMatchObject({ page: 1, size: 10, cap: 10 });
  });

  it('reads a blank string on every optional input as unset', async () => {
    routePage();

    const result = await run({ query: 'top pair', sort: '', page: '', size: '' } as Input);

    expect(result.isError).toBeFalsy();
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['fields', 'page', 'q', 'size']);
    expect(params()?.get('page')).toBe('1');
    expect(params()?.get('size')).toBe('10');
    expect(structured<Output>(result)).toMatchObject({ page: 1, size: 10, cap: 10 });
  });

  it('trims the query before sending it', async () => {
    routePage();

    await run({ query: '   collaborations.value:LHCb  ' });

    expect(params()?.get('q')).toBe('collaborations.value:LHCb');
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
    ['a boolean query', { query: true }],
    ['an unknown sort', { query: 'x', sort: 'mostcited' }],
    ['a differently cased sort', { query: 'x', sort: 'MostRecent' }],
    ['size 0', { query: 'x', size: 0 }],
    ['size 51', { query: 'x', size: 51 }],
    ['a fractional size', { query: 'x', size: 2.5 }],
    ['a size given as text', { query: 'x', size: '10' }],
    ['page 0', { query: 'x', page: 0 }],
    ['a negative page', { query: 'x', page: -1 }],
    ['a fractional page', { query: 'x', page: 1.5 }],
    ['a page given as text', { query: 'x', page: '2' }],
  ])('rejects %s as InvalidParams without calling INSPIRE', async (_label, input) => {
    const result = await runRaw(input);

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('cern_inspire_search_hepdata');
    expect(h.requests).toHaveLength(0);
  });

  it.each([
    ['size 1', { size: 1 }, 'size', '1'],
    ['size 50', { size: 50 }, 'size', '50'],
    ['page 200 with size 50', { page: 200, size: 50 }, 'page', '200'],
  ])('accepts %s', async (_label, extra, name, expected) => {
    routePage();

    const result = await run({ query: 'x', ...extra });

    expect(result.isError).toBeFalsy();
    expect(params()?.get(name)).toBe(expected);
  });
});

describe('request mapping', () => {
  it('omits sort for relevance and sends mostrecent as given', async () => {
    routePage();
    await run({ query: 'x', sort: 'relevance' });
    await run({ query: 'x', sort: 'mostrecent' });

    expect(h.requests.map((r) => r.params.get('sort'))).toEqual([null, 'mostrecent']);
  });

  it("sends the query as written: INSPIRE syntax is the caller's own", async () => {
    routePage();

    await run({ query: 'keywords.value:"Inclusive" and literature.control_number:1680459' });

    expect(params()?.get('q')).toBe(
      'keywords.value:"Inclusive" and literature.control_number:1680459',
    );
  });

  it('asks only for the fields the record schema needs, never the table values', async () => {
    routePage();

    await run({ query: 'x' });

    expect(params()?.get('fields')?.split(',')).toEqual([
      'control_number',
      'titles.title',
      'literature.control_number',
      'collaborations.value',
      'accelerator_experiments.legacy_name',
      'keywords.value',
      'abstracts.value',
      'dois.value',
      'dois.material',
      'creation_date',
      'citation_count',
    ]);
    expect(h.requests.every((r) => r.url.origin === 'https://inspirehep.net')).toBe(true);
  });
});

describe('declared error contracts', () => {
  it('declares exactly the five reasons the design lists, with tool-specific recovery text', () => {
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
      expect(hint(reason)).toContain('cern_inspire_search_hepdata');
    }
    expect(hint('upstream_unreadable')).toContain('cern_inspire_search_hepdata');
  });

  it('routes an unreadable body to a later retry of the same page and size, never a smaller size that shifts the page', () => {
    expect(hint('upstream_unreadable')).toBe(
      'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_search_hepdata with the same page and size.',
    );
  });

  it('fails page × size over 10,000 as beyond_result_window, before any request', async () => {
    const result = await run({ query: 'x', page: 201, size: 50 });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('beyond_result_window');
    expect(error.data).toMatchObject({ page: 201, size: 50 });
    expect(error.message).toContain('page 201 × size 50');
    expect(error.data?.recovery?.hint).toBe(hint('beyond_result_window'));
    expect(fullText(result)).toContain('reason beyond_result_window');
    expect(fullText(result)).toContain(`Recovery: ${hint('beyond_result_window')}`);
    expect(h.requests).toHaveLength(0);
  });

  it('spells the recovery placeholders in capitals, which survive a markdown-to-HTML render', () => {
    for (const { reason } of errors) expect(hint(reason)).not.toMatch(/<[A-Za-z]/);
    expect(hint('beyond_result_window')).toContain('a collaborations.value:NAME clause');
  });

  it.each([
    [200, 50, false],
    [201, 50, true],
    [1000, 10, false],
    [1001, 10, true],
    [10_000, 1, false],
    [10_001, 1, true],
  ])('page %i × size %i: past the window is %s', async (page, size, rejected) => {
    routePage(emptyBody());

    const result = await run({ query: 'x', page, size });

    expect(result.isError === true).toBe(rejected);
    expect(h.requests).toHaveLength(rejected ? 0 : 1);
  });

  it('attaches the contract reason through a direct handler call as well', async () => {
    const ctx = createMockContext({ errors: searchHepdataTool.errors });
    const input = searchHepdataTool.input.parse({ query: 'x', page: 201, size: 50 });

    await expect(searchHepdataTool.handler(input, ctx)).rejects.toMatchObject({
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
      records: [],
      page: 1,
      size: 10,
      hasMore: false,
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 10,
    });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBeTypeOf('string');
    expect(fullText(result)).toContain('**0 total**');
    expect(bodyText(result)).toContain('**More pages:** no');
  });

  it('echoes the requested page size as the cap on a zero-result page', async () => {
    routePage(emptyBody());

    const out = structured<Output>(await run({ query: 'zzzz', size: 25 }));

    expect(out).toMatchObject({ size: 25, cap: 25, shown: 0, totalCount: 0, truncated: false });
  });

  it('writes every required field on an under-cap page and sets no notice or next page', async () => {
    routePage(pageOf(3));

    const result = await run({ query: 'top pair', size: 10 });

    const out = structured<Output>(result);
    expect(out.records).toHaveLength(3);
    expect(out).toMatchObject({
      hasMore: false,
      totalCount: 3,
      truncated: false,
      shown: 3,
      cap: 10,
    });
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toBeUndefined();
    expect(fullText(result)).toContain('**3 total**');
    expect(fullText(result)).not.toContain('Next page');
  });

  it('keeps a page of exactly size records under the cap when INSPIRE has no next link', async () => {
    routePage(pageOf(10));

    const out = structured<Output>(await run({ query: 'top pair', size: 10 }));

    expect(out).toMatchObject({ shown: 10, cap: 10, truncated: false, totalCount: 10 });
    expect(out.notice).toBeUndefined();
  });

  it('reports the match total, not the page length, as totalCount', async () => {
    routePage(pageOf(2, { total: 8_400 }));

    const out = structured<Output>(await run({ query: 'top pair', size: 5 }));

    expect(out).toMatchObject({ totalCount: 8_400, shown: 2, cap: 5, truncated: false });
  });

  it('marks a page with a next link truncated and points at the next page', async () => {
    routePage(pageOf(10, { next: true, total: 250 }));

    const result = await run({ query: 'top pair' });

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
    expect(bodyText(result)).toContain('**More pages:** yes');
  });

  it('counts the next page from the requested page', async () => {
    routePage(pageOf(5, { next: true, total: 900 }));

    const out = structured<Output>(await run({ query: 'top pair', page: 7, size: 5 }));

    expect(out.nextPage).toBe(8);
    expect(out.notice).toBe('More results: request page 8 for the next 5.');
    expect(params()?.get('page')).toBe('7');
  });

  it('offers the last reachable next page at the 10,000-result window edge', async () => {
    routePage(pageOf(50, { next: true, total: 50_000 }));

    const out = structured<Output>(await run({ query: 'top pair', page: 199, size: 50 }));

    expect(out.nextPage).toBe(200);
    expect(out.notice).toBe('More results: request page 200 for the next 50.');
  });

  it('withholds the next page when it would cross the window and says to narrow the query', async () => {
    routePage(pageOf(50, { next: true, total: 50_000 }));

    const out = structured<Output>(await run({ query: 'top pair', page: 200, size: 50 }));

    expect(out.truncated).toBe(true);
    expect(out.nextPage).toBeUndefined();
    expect(out.notice).toContain('INSPIRE serves only the first 10,000 results of a query');
    expect(out.notice).not.toContain('request page');
  });
});

describe('zero-hit notice', () => {
  const notice = async (query: string) => {
    routePage(emptyBody());
    return structured<Output>(await run({ query })).notice ?? '';
  };

  it('names the query, the HEPData keyword phrases, the collaboration clause, and literature search', async () => {
    const text = await notice('zzzz nothing');

    expect(text.startsWith('No HEPData record matched "zzzz nothing". ')).toBe(true);
    expect(text).toContain('"Inclusive"');
    expect(text).toContain('P P --> TOP TOPBAR X');
    expect(text).toContain('collaborations.value:NAME clause');
    expect(text).toContain('cern_inspire_search_literature');
  });

  it('spells its placeholder in capitals on both surfaces, never as an HTML-shaped <name>', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'zzzz nothing' });

    const text = structured<Output>(result).notice ?? '';
    expect(text).not.toMatch(/<[A-Za-z]|&[a-z]+;/);
    expect(fullText(result)).toContain('try fewer words or a collaborations.value:NAME clause');
    expect(fullText(result)).not.toMatch(/<[A-Za-z]/);
  });

  it('echoes a wildcard query as written on both surfaces, so it can be sent again', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'top pair*' });

    expect(structured<Output>(result).notice).toMatch(/^No HEPData record matched "top pair\*"\. /);
    expect(fullText(result)).toContain('No HEPData record matched "top pair*". ');
  });

  it('still escapes a link- or HTML-shaped query in the echo', async () => {
    routePage(emptyBody());

    const result = await run({ query: '[x](javascript:alert(1)) <b>' });

    expect(structured<Output>(result).notice).toContain(
      'No HEPData record matched "\\[x\\](javascript:alert(1)) &lt;b>".',
    );
    expect(fullText(result)).not.toContain('[x](');
    expect(fullText(result)).not.toContain('<b>');
  });

  it('echoes a reaction query with its --> as written on both surfaces, with no HTML entity', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'P P --> ZZQQXXWV ZZQQXXWVBAR X' });

    const text = structured<Output>(result).notice ?? '';
    expect(text.startsWith('No HEPData record matched "P P --> ZZQQXXWV ZZQQXXWVBAR X". ')).toBe(
      true,
    );
    expect(text).not.toMatch(/&[a-z]+;/);
    expect(fullText(result)).toContain(
      'No HEPData record matched "P P --> ZZQQXXWV ZZQQXXWVBAR X". ',
    );
    expect(fullText(result)).not.toContain('&gt;');
  });

  it('reports a page past the end alone: the query did match', async () => {
    routePage(dataPage([], { total: 25 }));

    const result = await run({ query: 'top pair', page: 5, size: 10 });

    const out = structured<Output>(result);
    expect(out.notice).toBe('Page 5 is past the last page (3); request a lower page.');
    expect(out).toMatchObject({
      totalCount: 25,
      shown: 0,
      cap: 10,
      truncated: false,
      hasMore: false,
      records: [],
    });
    expect(out.nextPage).toBeUndefined();
  });

  it('rounds the last page up when the total is not a multiple of size', async () => {
    routePage(dataPage([], { total: 21 }));

    const out = structured<Output>(await run({ query: 'top pair', page: 9, size: 10 }));

    expect(out.notice).toBe('Page 9 is past the last page (3); request a lower page.');
  });

  it('echoes the query through inline(): newlines flatten and brackets are escaped', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'top\r\n# injected\n[x](http://evil) <b>' });

    const text = structured<Output>(result).notice ?? '';
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('top # injected \\[x\\](http://evil) &lt;b>');
    expect(fullText(result)).not.toMatch(/^# injected/m);
  });
});

describe('HEPData fields derived from INSPIRE', () => {
  type Doi = { material?: string; value?: string };

  const only = async (
    dois: Doi[] | undefined,
    overrides: Parameters<typeof dataMetadata>[0] = {},
  ) => {
    h = startHarness();
    routePage(
      dataPage([
        dois === undefined
          ? omit(dataMetadata(overrides), 'dois')
          : dataMetadata({ ...overrides, dois }),
      ]),
    );
    const result = await run({ query: 'x' });
    return { result, record: structured<Output>(result).records[0] };
  };

  it('reads the record DOI, record number, latest version, and its table count from a two-version record', async () => {
    const { result, record } = await only(TWO_VERSION_DOIS);

    expect(record).toMatchObject({
      recordDoi: '10.17182/hepdata.89456',
      hepdataRecid: '89456',
      latestVersion: 2,
      tableCount: 3,
      hepdataUrl: 'https://www.hepdata.net/record/89456',
    });
    expect(bodyText(result)).toContain(
      '**Record DOI:** 10.17182/hepdata.89456 · **HEPData record number:** 89456 · **Latest version:** 2 · **Tables:** 3',
    );
    expect(bodyText(result)).toContain('**Record page:** https://www.hepdata.net/record/89456');
    expect(bodyText(result)).not.toContain('HEPData recid');
  });

  it('describes hepdataRecid as a HEPData record number, not the INSPIRE recid get_paper takes', () => {
    const description =
      searchHepdataTool.output.shape.records.element.shape.hepdataRecid.description ?? '';

    expect(description).toContain('HEPData record number');
    expect(description).toContain('not an INSPIRE recid');
    expect(description).toContain('paperRecids');
    expect(description).toContain('cern_inspire_get_paper');
  });

  it('counts the tables under the latest version only', async () => {
    const { record } = await only([
      { value: '10.17182/hepdata.1', material: 'data' },
      { value: '10.17182/hepdata.1.v1', material: 'version' },
      { value: '10.17182/hepdata.1.v1/t1', material: 'part' },
      { value: '10.17182/hepdata.1.v1/t2', material: 'part' },
      { value: '10.17182/hepdata.1.v1/t3', material: 'part' },
      { value: '10.17182/hepdata.1.v2', material: 'version' },
      { value: '10.17182/hepdata.1.v2/t1', material: 'part' },
    ]);

    expect(record).toMatchObject({ latestVersion: 2, tableCount: 1 });
  });

  it('orders versions numerically, so v10 is later than v9, and v1 parts are not v10 parts', async () => {
    const { record } = await only([
      { value: '10.17182/hepdata.7', material: 'data' },
      { value: '10.17182/hepdata.7.v9', material: 'version' },
      { value: '10.17182/hepdata.7.v10', material: 'version' },
      { value: '10.17182/hepdata.7.v1', material: 'version' },
      { value: '10.17182/hepdata.7.v9/t1', material: 'part' },
      { value: '10.17182/hepdata.7.v9/t2', material: 'part' },
      { value: '10.17182/hepdata.7.v10/t1', material: 'part' },
      { value: '10.17182/hepdata.7.v1/t1', material: 'part' },
    ]);

    expect(record).toMatchObject({ latestVersion: 10, tableCount: 1 });
  });

  it('is independent of the order INSPIRE lists the DOIs in', async () => {
    const { record } = await only([...TWO_VERSION_DOIS].reverse());

    expect(record).toMatchObject({
      recordDoi: '10.17182/hepdata.89456',
      latestVersion: 2,
      tableCount: 3,
    });
  });

  it('reports a single-version record with one table', async () => {
    const { record } = await only([
      { value: '10.17182/hepdata.5', material: 'data' },
      { value: '10.17182/hepdata.5.v1', material: 'version' },
      { value: '10.17182/hepdata.5.v1/t1', material: 'part' },
    ]);

    expect(record).toMatchObject({ latestVersion: 1, tableCount: 1 });
  });

  it('prints zero tables for a version with no part DOIs rather than dropping the line', async () => {
    const { result, record } = await only([
      { value: '10.17182/hepdata.5', material: 'data' },
      { value: '10.17182/hepdata.5.v1', material: 'version' },
    ]);

    expect(record).toMatchObject({ latestVersion: 1, tableCount: 0 });
    expect(bodyText(result)).toContain('**Latest version:** 1 · **Tables:** 0');
  });

  it('leaves version and table count out when only the record DOI is present', async () => {
    const { result, record } = await only([{ value: '10.17182/hepdata.5', material: 'data' }]);

    expect(record).toMatchObject({ recordDoi: '10.17182/hepdata.5', hepdataRecid: '5' });
    expect(record).not.toHaveProperty('latestVersion');
    expect(record).not.toHaveProperty('tableCount');
    expect(bodyText(result)).not.toContain('**Latest version:**');
    expect(bodyText(result)).not.toContain('**Tables:**');
  });

  it('leaves the HEPData record number out, and links the first paper’s ins page, when the record DOI is not a hepdata.<n> DOI', async () => {
    const { result, record } = await only([{ value: '10.5072/other.1', material: 'data' }]);

    expect(record?.recordDoi).toBe('10.5072/other.1');
    expect(record).not.toHaveProperty('hepdataRecid');
    expect(record?.hepdataUrl).toBe('https://www.hepdata.net/record/ins1680459');
    expect(bodyText(result)).toContain('**Record DOI:** 10.5072/other.1');
    expect(bodyText(result)).not.toContain('**HEPData record number:**');
  });

  it('prints a record DOI as written, its *, _, and ~ unescaped, so it copies back', async () => {
    const { result, record } = await only([{ value: '10.5281/_x*~1', material: 'data' }]);

    expect(record?.recordDoi).toBe('10.5281/_x*~1');
    expect(bodyText(result)).toContain('**Record DOI:** 10.5281/_x*~1');
  });

  it('keeps a record that carries no DOIs without inventing DOI facts', async () => {
    const { result, record } = await only(undefined);

    for (const key of ['recordDoi', 'hepdataRecid', 'latestVersion', 'tableCount']) {
      expect(record).not.toHaveProperty(key);
    }
    expect(record?.hepdataUrl).toBe('https://www.hepdata.net/record/ins1680459');
    expect(bodyText(result)).not.toContain('**Record DOI:**');
    expect(bodyText(result)).toContain('**Record page:**');
  });

  it('falls back to the first linked paper’s ins page when the record has no DOI', async () => {
    const { result, record } = await only(undefined, {
      literature: [{ control_number: 1124337 }, { control_number: 451647 }],
    });

    expect(record?.paperRecids).toEqual(['1124337', '451647']);
    expect(record?.hepdataUrl).toBe('https://www.hepdata.net/record/ins1124337');
    expect(bodyText(result)).toContain('**Paper recids:** 1124337, 451647');
  });

  it('links the record by its own number even when it links no paper', async () => {
    const { result, record } = await only(TWO_VERSION_DOIS, { literature: [] });

    expect(record?.paperRecids).toEqual([]);
    expect(record?.hepdataUrl).toBe('https://www.hepdata.net/record/89456');
    expect(bodyText(result)).toContain('**Paper recids:** Not available');
    expect(bodyText(result)).toContain('**Record page:** https://www.hepdata.net/record/89456');
  });

  it('leaves the hepdata.net page out, and says so, when the record links no paper and its DOI names no record', async () => {
    h = startHarness();
    routePage(dataPage([omit(dataMetadata({ dois: [] }), 'literature')]));

    const result = await run({ query: 'x' });

    const [only] = structured<Output>(result).records;
    expect(only?.paperRecids).toEqual([]);
    expect(only).not.toHaveProperty('hepdataUrl');
    expect(bodyText(result)).toContain('**Paper recids:** Not available');
    expect(bodyText(result)).not.toContain('**Record page:**');
  });

  it('links each of 1797621’s two records to its own record page, not to the shared ins page', async () => {
    h = startHarness();
    routePage(
      dataPage(
        TWO_RECORD_PAPERS['1797621'].map((r) => ({
          ...r,
          literature: [{ control_number: 1797621 }],
        })),
      ),
    );

    const result = await run({ query: 'literature.control_number:1797621' });

    const { records } = structured<Output>(result);
    expect(records.map((r) => [r.recordDoi, r.tableCount, r.hepdataUrl])).toEqual([
      ['10.17182/hepdata.156903', 1, 'https://www.hepdata.net/record/156903'],
      ['10.17182/hepdata.98625', 9, 'https://www.hepdata.net/record/98625'],
    ]);
    expect(bodyText(result)).toContain('**Record page:** https://www.hepdata.net/record/156903');
    expect(bodyText(result)).toContain('**Record page:** https://www.hepdata.net/record/98625');
    expect(fullText(result)).not.toContain('/record/ins');
  });
});

describe('records and format() parity', () => {
  it('returns each record in the schema shape and renders every value into content[]', async () => {
    routePage(
      dataPage([
        record(1),
        record(2, {
          collaborations: [{ value: 'ATLAS' }, { value: 'CMS' }],
          accelerator_experiments: [
            { legacy_name: 'CERN-LHC-ATLAS' },
            { legacy_name: 'CERN-LHC-CMS' },
          ],
          literature: [{ control_number: 1124337 }, { control_number: 451647 }],
          citation_count: 0,
        }),
      ]),
    );

    const result = await run({ query: 'higgs' });

    const out = structured<Output>(result);
    expect(out).toEqual(expect.schemaMatching(searchHepdataTool.output));
    const text = bodyText(result);
    for (const leaf of leaves(out.records)) expect(text).toContain(String(leaf));
    expect(text).toContain('**More pages:** no');
    expect(text).toContain('**Records on this page:** 2');
  });

  it('renders the facts of one record into labelled lines', async () => {
    routePage(dataPage([dataMetadata()]));

    const text = bodyText(await run({ query: 'higgs' }));

    expect(text).toContain('## HEPData records, page 1');
    expect(text).toContain(
      '**Page:** 1 · **Size:** 10 · **Records on this page:** 1 · **More pages:** no',
    );
    expect(text).toContain('### 1. Differential cross sections for Higgs boson production');
    expect(text).toContain(
      '**INSPIRE data recid:** 1860001 · **Created:** 2020-01-02T03:04:05.000000+00:00 · **Citations:** 3',
    );
    expect(text).toContain('**Paper recids:** 1680459');
    expect(text).toContain('**Collaborations:** ATLAS · **Experiments:** CERN-LHC-ATLAS');
    expect(text).toContain('**Keywords:** cmenergies: 13000.0-13000.0; observables: SIG');
    expect(text).toContain(
      '**Abstract:**\n> Measured cross sections as a function of the transverse momentum.',
    );
  });

  it('numbers records from the page offset', async () => {
    routePage(pageOf(2, { next: true, total: 40 }));

    const text = bodyText(await run({ query: 'higgs', page: 3, size: 10 }));

    expect(text).toContain('## HEPData records, page 3');
    expect(text).toContain('### 21. Measurement 1');
    expect(text).toContain('### 22. Measurement 2');
    expect(text).toContain('**More pages:** yes');
  });

  it('prints keywords as written on both surfaces, so a keyword copies into keywords.value:"…" unchanged', async () => {
    const keywords = [
      'reactions: E+ E- --> D* D*BAR',
      'observables: M_{T}',
      'K*(892)',
      'P P --> TOP TOPBAR X',
    ];
    routePage(dataPage([dataMetadata({ keywords: keywords.map((value) => ({ value })) })]));

    const result = await run({ query: 'ttbar' });

    expect(structured<Output>(result).records[0]?.keywords).toEqual(keywords);
    expect(bodyText(result)).toContain(`**Keywords:** ${keywords.join('; ')}`);
  });

  it('labels a truncated abstract snippet and leaves the cut at a word boundary', async () => {
    const abstract = `${'quark '.repeat(80)}end`;
    routePage(dataPage([dataMetadata({ abstracts: [{ value: abstract }] })]));

    const result = await run({ query: 'x' });

    const [only] = structured<Output>(result).records;
    expect(only?.abstractTruncated).toBe(true);
    expect(only?.abstractSnippet?.length).toBeLessThanOrEqual(300);
    expect(only?.abstractSnippet).toMatch(/quark$/);
    expect(bodyText(result)).toContain('**Abstract** (truncated):');
  });

  it('renders a sparse record with Not available instead of invented values', async () => {
    routePage(dataPage([{ control_number: 42 }]));

    const result = await run({ query: 'x' });

    const [only] = structured<Output>(result).records;
    expect(only).toEqual({
      inspireDataRecid: '42',
      title: '',
      paperRecids: [],
      collaborations: [],
      experiments: [],
      keywords: [],
    });
    expect(bodyText(result)).toBe(
      [
        '## HEPData records, page 1',
        '**Page:** 1 · **Size:** 10 · **Records on this page:** 1 · **More pages:** no',
        '',
        '### 1. (untitled)',
        '**INSPIRE data recid:** 42',
        '**Paper recids:** Not available',
      ].join('\n'),
    );
  });

  it('prints a citation count of zero rather than dropping it', async () => {
    routePage(dataPage([dataMetadata({ citation_count: 0 })]));

    const text = bodyText(await run({ query: 'x' }));

    expect(text).toContain('**Citations:** 0');
  });

  it('renders no content blocks other than text', async () => {
    routePage(pageOf(1));

    const result = await run({ query: 'x' });

    expect(result.content.every((block) => block.type === 'text')).toBe(true);
  });
});

describe('publisher markup in titles and abstracts', () => {
  it('converts a markup title and decodes an entity-escaped abstract once, on both surfaces', async () => {
    routePage(
      dataPage([
        record(1, {
          titles: [{ title: PUBLISHER_MARKUP.deGruyter2830751Title }],
          abstracts: [{ value: PUBLISHER_MARKUP.hepdata3205357Abstract }],
        }),
      ]),
    );

    const result = await run({ query: 'x' });

    const [only] = structured<Output>(result).records;
    const abstract = MARKUP_AS_TEXT.hepdata3205357Abstract;
    const snippet = only?.abstractSnippet ?? '';
    expect(only?.title).toBe(MARKUP_AS_TEXT.deGruyter2830751Title);
    expect(only?.abstractTruncated).toBe(true);
    expect(abstract.startsWith(snippet)).toBe(true);
    expect(snippet).toMatch(/selected within ABS\(ETARAP\) < 0\.5\nand 0\.2$/);
    const text = bodyText(result);
    expect(text).toContain(
      '### 1. Non-binary quantum codes from constacyclic codes over 𝔽_q\\[u_1, u_2,…,u_k\\]/⟨u_i^3 = u_i, u_iu_j = u_ju_i⟩',
    );
    expect(text).toContain(
      '**Abstract** (truncated):\n> Au+Au collisions at RHIC. Event-by-event transverse momentum fluctuations\n> and the dynamical correlator C_pT,',
    );
    expect(text).toContain(
      '> configurations. Charged particles are selected within ABS(ETARAP) &lt; 0.5\n> and 0.2',
    );
    expect(text).not.toContain('&amp;');
  });

  it('leaves out an abstract that is only markup and renders a markup-only title as untitled', async () => {
    routePage(
      dataPage([record(1, { titles: [{ title: '<i></i>' }], abstracts: [{ value: '<p> </p>' }] })]),
    );

    const result = await run({ query: 'x' });

    const [only] = structured<Output>(result).records;
    expect(only?.title).toBe('');
    expect(only?.abstractSnippet).toBeUndefined();
    const text = bodyText(result);
    expect(text).toContain('### 1. (untitled)');
    expect(text).not.toContain('**Abstract');
  });

  it('takes the first abstract with text after conversion when an earlier one is only markup', async () => {
    routePage(
      dataPage([
        record(1, {
          abstracts: [
            { value: '<p> </p><p><inline-graphic/></p>' },
            { value: 'Charged particles within ABS(ETARAP) &lt; 0.5.' },
            { value: 'A third abstract.' },
          ],
        }),
      ]),
    );

    const result = await run({ query: 'x' });

    const [only] = structured<Output>(result).records;
    expect(only?.abstractSnippet).toBe('Charged particles within ABS(ETARAP) < 0.5.');
    expect(only?.abstractTruncated).toBe(false);
    expect(bodyText(result)).toContain(
      '**Abstract:**\n> Charged particles within ABS(ETARAP) &lt; 0.5.',
    );
  });
});

describe('upstream text stays out of inline markdown slots', () => {
  const NEL = String.fromCharCode(0x85);
  const LS = String.fromCharCode(0x2028);
  const attack = '\r\n# Injected heading\n**Citations:** 999999';

  const hostileRecord = (decorate: (text: string) => string) =>
    dataMetadata({
      titles: [{ title: decorate('Differential cross sections') }],
      collaborations: [{ value: decorate('ATLAS') }],
      accelerator_experiments: [{ legacy_name: decorate('CERN-LHC-ATLAS') }],
      keywords: [{ value: decorate('cmenergies: 13000.0-13000.0') }],
      dois: [
        { value: decorate('10.17182/hepdata.89456'), material: 'data' },
        { value: '10.17182/hepdata.89456.v1', material: 'version' },
      ],
      creation_date: decorate('2020-01-02'),
    });

  const render = async (decorate: (text: string) => string) => {
    h = startHarness();
    routePage(dataPage([hostileRecord(decorate)]));
    return run({ query: 'x' });
  };

  it('keeps the markdown structure of a benign record when every inline field carries line breaks', async () => {
    const benign = await render((text) => text);
    const hostile = await render((text) => `${text}${attack}`);

    expect(shape(hostile)).toEqual(shape(benign));
    expect(lines(hostile).some((line) => line.startsWith('# Injected'))).toBe(false);
    expect(lines(hostile).filter((line) => line.startsWith('#'))).toEqual([
      '## HEPData records, page 1',
      '### 1. Differential cross sections # Injected heading \\*\\*Citations:\\*\\* 999999',
    ]);
  });

  it('flattens the other line separators and keeps structuredContent verbatim', async () => {
    const result = await render((text) => `${text}${LS}x${NEL}y`);

    const [only] = structured<Output>(result).records;
    expect(only?.title).toBe(`Differential cross sections${LS}x${NEL}y`);
    expect(bodyText(result)).not.toMatch(new RegExp(`[${LS}${NEL}]`));
    expect(bodyText(result)).toContain('### 1. Differential cross sections x y');
  });

  it('escapes link brackets and angle brackets in titles and collaborations, and in keywords the brackets and a < that opens markup', async () => {
    routePage(
      dataPage([
        dataMetadata({
          titles: [{ title: 'See [the paper](http://evil.example.org) <script>x</script>' }],
          collaborations: [{ value: '[ATLAS]' }],
          keywords: [{ value: 'a <b> [c]' }],
        }),
      ]),
    );

    const result = await run({ query: 'x' });

    const text = bodyText(result);
    expect(text).toContain(
      '### 1. See \\[the paper\\](http://evil.example.org) &lt;script&gt;x&lt;/script&gt;',
    );
    expect(text).toContain('**Collaborations:** \\[ATLAS\\]');
    expect(text).toContain('**Keywords:** a &lt;b> \\[c\\]');
    expect(text).not.toContain('<script>');
    const [only] = structured<Output>(result).records;
    expect(only?.collaborations).toEqual(['[ATLAS]']);
    // <script> is outside the markup vocabulary, so it reaches format() as text and the escape above is real.
    expect(only?.title).toBe('See [the paper](http://evil.example.org) <script>x</script>');
  });

  it('keeps a pipe in a title in the heading, where it needs no table escape', async () => {
    routePage(
      dataPage([dataMetadata({ titles: [{ title: 'Measurement of |V_{cb}| in B decays' }] })]),
    );

    const text = bodyText(await run({ query: 'x' }));

    expect(text).toContain('### 1. Measurement of |V\\_{cb}| in B decays');
  });

  it('keeps every line of a multi-line abstract inside the blockquote', async () => {
    routePage(
      dataPage([
        dataMetadata({
          abstracts: [{ value: 'First.\n\n# Not a heading\r\n- not a bullet\n[x](y)' }],
        }),
      ]),
    );

    const result = await run({ query: 'x' });

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

describeFailureClasses({
  label: 'cern_inspire_search_hepdata',
  contract: errors,
  invalidQuery: true,
  path: '/api/data',
  run: (options) => run({ query: 'top pair 13 TeV' }, options),
  install: (harness, reply) => harness.route('/data', reply),
  unreadable: [
    ['an HTML page', () => htmlResponse()],
    ['truncated JSON', () => new Response('{"hits":{"total":', { status: 200 })],
    ['an empty body', () => new Response('', { status: 200 })],
    ['JSON without the search envelope', () => jsonResponse({ hits: {} })],
  ],
});
