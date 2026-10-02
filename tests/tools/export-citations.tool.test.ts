/**
 * @fileoverview Tests for cern_inspire_export_citations through `runToolContract`
 * over an `InspireService` on a fake fetch: input validation and blank-as-unset
 * handling, request mapping (`size + 1` on page 1 for truncation detection),
 * BibTeX and LaTeX entry splitting and texkeys, the required enrichment on a
 * zero-result page, an under-cap page, and a truncated page, paging (later pages
 * walked to the last and past it in each format against a short-page fake, the
 * 10,000-result window, an OR query's past-the-end leftover, and a failed total
 * request), the notices the design specifies, `format()` parity with
 * `structuredContent`, citation text kept verbatim in a fence that upstream
 * backticks cannot close, and the shared upstream failure classes on the wire.
 * No live network.
 * @module tests/tools/export-citations.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  createMockContext,
  type RunToolContractOptions,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportCitationsTool } from '@/mcp-server/tools/definitions/export-citations.tool.js';
import { describeFailureClasses } from '../fixtures/failure-suite.js';
import {
  BIBTEX_ENTRIES,
  badRequestBody,
  exportBody,
  HIGGS_REFERENCE_TEXKEYS,
  hit,
  htmlResponse,
  jsonResponse,
  LATEX_EU_ENTRIES,
  OR_LEFTOVER_BIBTEX,
  pagedLiterature,
  searchBody,
  textResponse,
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
  structured,
  type ToolResult,
} from '../fixtures/tool-result.js';

vi.mock('@/services/inspire/inspire-service.js', async (importOriginal) =>
  (await import('../fixtures/active-service.js')).withActiveService(await importOriginal()),
);

type Input = z.input<typeof exportCitationsTool.input>;
type Output = z.infer<typeof exportCitationsTool.output> & {
  cap: number;
  nextPage?: number;
  notice?: string;
  shown: number;
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
  runToolContract(exportCitationsTool, input, options);

const runRaw = (input: Record<string, unknown>) => run(input as Input);

const BIBTEX_TYPE = 'application/x-bibtex';
const LATEX_EU_TYPE = 'application/vnd+inspire.latex.eu+x-latex';

const routeBibtex = (entries: readonly string[] = BIBTEX_ENTRIES) =>
  h.route('/literature', textResponse(exportBody(entries), BIBTEX_TYPE));

const params = () => h.requests[0]?.params;

describe('input', () => {
  it('applies the defaults: bibtex, relevance, page 1 of ten entries, one request as size 11', async () => {
    routeBibtex();

    const result = await run({ query: 'recid:451647' });

    expect(result.isError).toBeFalsy();
    expect(h.requests).toHaveLength(1);
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['format', 'q', 'size']);
    expect(params()?.get('format')).toBe('bibtex');
    expect(params()?.get('size')).toBe('11');
    expect(structured<Output>(result)).toMatchObject({ format: 'bibtex', page: 1, cap: 10 });
  });

  it('reads a blank string on format, sort, page, and size as unset', async () => {
    routeBibtex();

    const result = await run({
      query: 'recid:451647',
      format: '',
      sort: '',
      page: '',
      size: '',
    } as unknown as Input);

    expect(result.isError).toBeFalsy();
    expect(h.requests).toHaveLength(1);
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['format', 'q', 'size']);
    expect(params()?.get('format')).toBe('bibtex');
    expect(params()?.get('size')).toBe('11');
    expect(structured<Output>(result)).toMatchObject({ format: 'bibtex', page: 1 });
  });

  it('trims the query, and accepts exactly 1000 characters', async () => {
    routeBibtex();

    await run({ query: '  recid:451647 or arxiv:1207.7214  ' });
    await run({ query: 'x'.repeat(1000) });

    expect(h.requests[0]?.params.get('q')).toBe('recid:451647 or arxiv:1207.7214');
    expect(h.requests[1]?.params.get('q')).toHaveLength(1000);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a missing query', {}],
    ['an empty query', { query: '' }],
    ['a whitespace-only query', { query: '  \n ' }],
    ['a query over 1000 characters', { query: 'x'.repeat(1001) }],
    ['the cv format INSPIRE offers but this tool does not', { query: 'x', format: 'cv' }],
    ['a differently cased format', { query: 'x', format: 'BibTeX' }],
    ['the unsuffixed latex format', { query: 'x', format: 'latex' }],
    ['an unknown sort', { query: 'x', sort: 'newest' }],
    ['size 0', { query: 'x', size: 0 }],
    ['size 51', { query: 'x', size: 51 }],
    ['a fractional size', { query: 'x', size: 1.5 }],
    ['a negative size', { query: 'x', size: -5 }],
    ['page 0', { query: 'x', page: 0 }],
    ['a negative page', { query: 'x', page: -1 }],
    ['a fractional page', { query: 'x', page: 2.5 }],
  ])('rejects %s as InvalidParams without calling INSPIRE', async (_label, input) => {
    const result = await runRaw(input);

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('cern_inspire_export_citations');
    expect(h.requests).toHaveLength(0);
  });

  it.each([
    [1, '2'],
    [50, '51'],
  ])('accepts size %i and requests %s entries', async (size, requested) => {
    routeBibtex();

    const result = await run({ query: 'x', size });

    expect(result.isError).toBeFalsy();
    expect(params()?.get('size')).toBe(requested);
  });

  it.each(['bibtex', 'latex-eu', 'latex-us'] as const)('sends format=%s', async (format) => {
    routeBibtex();

    await run({ query: 'x', format });

    expect(params()?.get('format')).toBe(format);
  });

  it('omits sort for relevance and sends mostrecent and mostcited as given', async () => {
    routeBibtex();
    await run({ query: 'x', sort: 'relevance' });
    await run({ query: 'x', sort: 'mostrecent' });
    await run({ query: 'x', sort: 'mostcited' });

    expect(h.requests.map((r) => r.params.get('sort'))).toEqual([null, 'mostrecent', 'mostcited']);
  });

  it('sends page 1 as only q, format, size, and the optional sort, never fields or page', async () => {
    routeBibtex();

    await run({ query: 'x', sort: 'mostcited', page: 1 });

    expect(h.requests).toHaveLength(1);
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['format', 'q', 'size', 'sort']);
  });
});

describe('entries', () => {
  it('lists a texkey as written, its *, _, and ~ unescaped, so it copies into \\cite', async () => {
    routeBibtex(['@article{_Doe:2020x*~,\n    title = "T"\n}']);

    const result = await run({ query: 'x' });

    expect(structured<Output>(result).entries.map((e) => e.texkey)).toEqual(['_Doe:2020x*~']);
    expect(bodyText(result)).toContain('**Texkeys:** _Doe:2020x*~');
  });

  it('splits a BibTeX body into entries keyed by texkey, verbatim', async () => {
    routeBibtex();

    const result = await run({ query: 'recid:451647 or recid:1124337' });

    const out = structured<Output>(result);
    expect(out.entries.map((e) => e.texkey)).toEqual([
      'ATLAS:2012yve',
      'Maldacena:1997re',
      'Doe:2020xyz',
    ]);
    expect(out.entries.map((e) => e.text)).toEqual([...BIBTEX_ENTRIES]);
    expect(out.entries[0]?.text).toContain('author = "Doe, Jane and others"');
  });

  it('splits a LaTeX body on the %\\cite{ lines and keys entries by the cite key', async () => {
    h.route('/literature', textResponse(exportBody(LATEX_EU_ENTRIES), LATEX_EU_TYPE));

    const result = await run({ query: 'x', format: 'latex-eu' });

    const out = structured<Output>(result);
    expect(out.format).toBe('latex-eu');
    expect(out.entries.map((e) => e.texkey)).toEqual(['ATLAS:2012yve', 'Maldacena:1997re']);
    expect(out.entries.map((e) => e.text)).toEqual([...LATEX_EU_ENTRIES]);
  });

  it('drops text before the first entry and trims each entry', async () => {
    h.route(
      '/literature',
      textResponse(`\n\n  \n${BIBTEX_ENTRIES[0]}\n\n\n${BIBTEX_ENTRIES[1]}\n\n`, BIBTEX_TYPE),
    );

    const out = structured<Output>(await run({ query: 'x' }));

    expect(out.entries.map((e) => e.text)).toEqual([BIBTEX_ENTRIES[0], BIBTEX_ENTRIES[1]]);
  });

  it('reads CRLF line endings without leaving a carriage return in an entry', async () => {
    h.route(
      '/literature',
      textResponse(exportBody(BIBTEX_ENTRIES).replace(/\n/g, '\r\n'), BIBTEX_TYPE),
    );

    const out = structured<Output>(await run({ query: 'x' }));

    expect(out.entries).toHaveLength(3);
    expect(out.entries.some((e) => e.text.includes('\r'))).toBe(false);
    expect(out.entries.map((e) => e.texkey)).toEqual([
      'ATLAS:2012yve',
      'Maldacena:1997re',
      'Doe:2020xyz',
    ]);
  });

  it('leaves the texkey empty for an entry whose key it cannot read', async () => {
    h.route('/literature', textResponse('@misc{,\n    title = "Untitled"\n}\n', BIBTEX_TYPE));

    const result = await run({ query: 'x' });

    expect(structured<Output>(result).entries).toEqual([
      { texkey: '', text: '@misc{,\n    title = "Untitled"\n}' },
    ]);
    expect(bodyText(result)).toContain('**Texkeys:** (no texkey)');
  });
});

describe('required enrichment', () => {
  it('writes every required field on a zero-result page and sets the no-match notice', async () => {
    h.route('/literature', textResponse('', BIBTEX_TYPE));

    const result = await run({ query: 'recid:99999999', size: 5 });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      format: 'bibtex',
      entries: [],
      truncated: false,
      shown: 0,
      cap: 5,
      notice:
        'No INSPIRE literature matched "recid:99999999"; find the papers with cern_inspire_search_literature, then export by recid ("recid:N or recid:M").',
    });
    expect(fullText(result)).toContain('**truncated:** false');
    expect(fullText(result)).toContain('**cap:** 5');
    expect(bodyText(result)).toBe('## INSPIRE citations, page 1 (bibtex, 0 entries)');
  });

  it('treats a whitespace-only body as zero matches', async () => {
    h.route('/literature', textResponse('\n\n  \n', BIBTEX_TYPE));

    const out = structured<Output>(await run({ query: 'x' }));

    expect(out).toMatchObject({ entries: [], shown: 0, truncated: false });
    expect(out.notice).toContain('No INSPIRE literature matched "x"');
  });

  it('echoes the query through callerEcho() in the no-match notice', async () => {
    h.route('/literature', textResponse('', BIBTEX_TYPE));

    const result = await run({ query: 'recid:1\r\n# injected\n[x](http://evil) <b>' });

    const notice = structured<Output>(result).notice ?? '';
    expect(notice).not.toMatch(/[\r\n]/);
    expect(notice).toContain('recid:1 # injected \\[x\\](http://evil) &lt;b>');
    expect(fullText(result)).not.toMatch(/^# injected/m);
  });

  it('echoes a wildcard query as written on both surfaces, so it can be sent again', async () => {
    h.route('/literature', textResponse('', BIBTEX_TYPE));

    const result = await run({ query: 't higgs*' });

    expect(structured<Output>(result).notice).toMatch(
      /^No INSPIRE literature matched "t higgs\*";/,
    );
    expect(fullText(result)).toContain('No INSPIRE literature matched "t higgs*";');
  });

  it('still escapes a link-shaped query in the content[] echo', async () => {
    h.route('/literature', textResponse('', BIBTEX_TYPE));

    const result = await run({ query: 't [x](javascript:alert(1))' });

    expect(fullText(result)).toContain('"t \\[x\\](javascript:alert(1))"');
    expect(fullText(result)).not.toContain('[x](');
  });

  it('writes every required field on an under-cap page and sets no notice', async () => {
    routeBibtex();

    const result = await run({ query: 'x', size: 10 });

    const out = structured<Output>(result);
    expect(out).toMatchObject({ truncated: false, shown: 3, cap: 10 });
    expect(out.notice).toBeUndefined();
    expect(out.entries).toHaveLength(3);
    expect(fullText(result)).toContain('**shown:** 3');
  });

  it('treats a page of exactly size entries as complete, since the extra entry never came back', async () => {
    routeBibtex();

    const out = structured<Output>(await run({ query: 'x', size: 3 }));

    expect(params()?.get('size')).toBe('4');
    expect(out).toMatchObject({ truncated: false, shown: 3, cap: 3 });
    expect(out.notice).toBeUndefined();
  });

  it('truncates page 1 at size when INSPIRE returns the extra entry, and points to page 2', async () => {
    routeBibtex();

    const result = await run({ query: 'x', size: 2 });

    const out = structured<Output>(result);
    expect(out.entries.map((e) => e.texkey)).toEqual(['ATLAS:2012yve', 'Maldacena:1997re']);
    expect(out).toMatchObject({
      truncated: true,
      shown: 2,
      cap: 2,
      nextPage: 2,
      notice:
        'More papers matched; request page 2 for the next 2, or raise size (up to 50) to export more per call.',
    });
    expect(fullText(result)).toContain('**truncated:** true');
    expect(fullText(result)).toContain('**Next page:** 2');
    expect(fullText(result)).toContain('> More papers matched; request page 2 for the next 2');
    expect(bodyText(result)).toContain('(bibtex, 2 entries)');
    expect(bodyText(result)).not.toContain('Doe:2020xyz');
  });

  it('drops the raise-size hint at size 50, the most one page holds', async () => {
    h.route('/literature', pagedLiterature(HIGGS_REFERENCE_TEXKEYS));

    const out = structured<Output>(await run({ query: 'citedby:recid:1124337', size: 50 }));

    expect(out.notice).toBe('More papers matched; request page 2 for the next 50.');
  });

  it('truncates a LaTeX export the same way', async () => {
    h.route('/literature', textResponse(exportBody(LATEX_EU_ENTRIES), LATEX_EU_TYPE));

    const out = structured<Output>(await run({ query: 'x', format: 'latex-eu', size: 1 }));

    expect(out.entries).toHaveLength(1);
    expect(out).toMatchObject({ truncated: true, shown: 1, cap: 1 });
  });
});

describe('paging', () => {
  const CITED_BY_HIGGS = 'citedby:recid:1124337';
  const UNCHECKED =
    "INSPIRE's match count could not be read, so this page is unchecked against it: past the last page, INSPIRE can return an entry from an earlier page again (it does for OR queries).";

  /** Routes exports to the short-page fake over the Higgs references, and the total search to `totalReply`. */
  const routeTotalReply = (totalReply: () => Response) => {
    const fake = pagedLiterature(HIGGS_REFERENCE_TEXKEYS);
    h.route('/literature', (request) =>
      new URL(request.url).searchParams.has('format') ? fake(request) : totalReply(),
    );
  };
  const refused = () => jsonResponse(badRequestBody('Invalid query.'), { status: 400 });

  it.each(['bibtex', 'latex-eu', 'latex-us'] as const)(
    'walks the 138 %s references of the Higgs observation at size 50 as 50, 50, 38, then none past the end',
    async (format) => {
      h.route('/literature', pagedLiterature(HIGGS_REFERENCE_TEXKEYS));

      const results: ToolResult[] = [];
      for (const page of [1, 2, 3, 4]) {
        results.push(await run({ query: CITED_BY_HIGGS, format, page, size: 50 }));
      }

      const outs = results.map((r) => structured<Output>(r));
      expect(outs.map((o) => [o.page, o.shown, o.entries.length])).toEqual([
        [1, 50, 50],
        [2, 50, 50],
        [3, 38, 38],
        [4, 0, 0],
      ]);
      expect(outs.map((o) => o.truncated)).toEqual([true, true, false, false]);
      expect(outs.map((o) => o.nextPage)).toEqual([2, 3, undefined, undefined]);
      expect(outs.map((o) => o.notice)).toEqual([
        'More papers matched; request page 2 for the next 50.',
        'More papers matched; request page 3 for the next 50.',
        undefined,
        'Page 4 is past the last page (3); request a lower page.',
      ]);
      const texkeys = outs.flatMap((o) => o.entries.map((e) => e.texkey));
      expect(texkeys).toEqual(HIGGS_REFERENCE_TEXKEYS);
      expect(new Set(texkeys).size).toBe(138);
      expect(h.requests).toHaveLength(7);

      expect(results.map((r) => bodyText(r).split('\n')[0])).toEqual([
        `## INSPIRE citations, page 1 (${format}, 50 entries)`,
        `## INSPIRE citations, page 2 (${format}, 50 entries)`,
        `## INSPIRE citations, page 3 (${format}, 38 entries)`,
        `## INSPIRE citations, page 4 (${format}, 0 entries)`,
      ]);
      expect(bodyText(results[1] as ToolResult)).toContain(
        `**Texkeys:** ${HIGGS_REFERENCE_TEXKEYS.slice(50, 100).join(', ')}`,
      );
      for (const entry of outs[2]?.entries ?? []) {
        expect(bodyText(results[2] as ToolResult)).toContain(entry.text);
      }
      const texts = results.map(fullText);
      expect(texts[0]).toContain('**Next page:** 2');
      expect(texts[1]).toContain('**Next page:** 3');
      expect(texts[2]).not.toContain('Next page');
      expect(texts[3]).toContain('> Page 4 is past the last page (3); request a lower page.');
    },
  );

  it('answers the past-the-end page of an OR query with no entries and names the last page', async () => {
    h.route('/literature', pagedLiterature(['ATLAS:2012yve', 'CMS:2012qbp'], { leftover: true }));

    const second = structured<Output>(
      await run({ query: 'arxiv:1207.7214 or arxiv:1207.7235', page: 2, size: 1 }),
    );
    const result = await run({ query: 'arxiv:1207.7214 or arxiv:1207.7235', page: 3, size: 1 });

    expect(second.entries.map((e) => e.texkey)).toEqual(['CMS:2012qbp']);
    const out = structured<Output>(result);
    expect(out).toMatchObject({
      page: 3,
      entries: [],
      shown: 0,
      truncated: false,
      notice: 'Page 3 is past the last page (2); request a lower page.',
    });
    expect(out.nextPage).toBeUndefined();
    expect(bodyText(result)).toBe('## INSPIRE citations, page 3 (bibtex, 0 entries)');
    expect(fullText(result)).not.toContain('CMS:2012qbp');
  });

  it('drops the leftover entry INSPIRE answered for page 2 of a two-paper OR query at size 5', async () => {
    h.route('/literature', (request) =>
      new URL(request.url).searchParams.has('format')
        ? textResponse(OR_LEFTOVER_BIBTEX, BIBTEX_TYPE)
        : jsonResponse(searchBody([hit({ control_number: 1124337 }, '1124337')], { total: 2 })),
    );

    const out = structured<Output>(
      await run({ query: 'arxiv:1207.7214 or arxiv:1207.7235', page: 2, size: 5 }),
    );

    expect(out).toMatchObject({
      entries: [],
      notice: 'Page 2 is past the last page (1); request a lower page.',
    });
  });

  it('fails page × size over 10,000 as beyond_result_window, before any request', async () => {
    const result = await run({ query: CITED_BY_HIGGS, page: 201, size: 50 });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('beyond_result_window');
    expect(error.data).toMatchObject({ page: 201, size: 50 });
    expect(error.message).toBe(
      'page 201 × size 50 reaches past the first 10,000 results, which is all INSPIRE serves for one query.',
    );
    expect(error.data?.recovery?.hint).toContain('page again with cern_inspire_export_citations');
    expect(fullText(result)).toContain('reason beyond_result_window');
    expect(h.requests).toHaveLength(0);
  });

  it('serves the last page of the window with no nextPage, and says to narrow the query', async () => {
    const keys = Array.from({ length: 10_000 }, (_, i) => `Doe:${i + 1}`);
    h.route('/literature', pagedLiterature(keys, { total: 20_000 }));

    const before = structured<Output>(await run({ query: 't higgs', page: 199, size: 50 }));
    const result = await run({ query: 't higgs', page: 200, size: 50 });

    expect(before.nextPage).toBe(200);
    const out = structured<Output>(result);
    expect(out.entries.map((e) => e.texkey)).toEqual(keys.slice(9_950));
    expect(out).toMatchObject({
      truncated: true,
      shown: 50,
      notice:
        'INSPIRE serves only the first 10,000 results of a query; narrow it with tighter terms, such as a date range or a collaboration, to export the rest.',
    });
    expect(out.nextPage).toBeUndefined();
    expect(fullText(result)).not.toContain('Next page');
  });

  it.each<[string, number, number, string, boolean]>([
    [
      'inside the count, with more pages after it',
      138,
      2,
      'More papers matched; request page 3 for the next 50. Page 2 came back empty although INSPIRE counts 138 matches (3 pages at this size); retry this call in a few seconds.',
      true,
    ],
    [
      'the last page inside the count',
      138,
      3,
      'Page 3 came back empty although INSPIRE counts 138 matches (3 pages at this size); retry this call in a few seconds.',
      false,
    ],
    [
      'one match inside the count',
      101,
      3,
      'Page 3 came back empty although INSPIRE counts 101 matches (3 pages at this size); retry this call in a few seconds.',
      false,
    ],
    [
      'starting exactly at the count',
      100,
      3,
      'Page 3 is past the last page (2); request a lower page.',
      false,
    ],
  ])(
    'tells an empty later page %s apart from one past the last page',
    async (_label, total, page, notice, truncated) => {
      h.route('/literature', (request) =>
        new URL(request.url).searchParams.has('format')
          ? textResponse('', BIBTEX_TYPE)
          : jsonResponse(searchBody([hit({ control_number: 1124337 }, '1124337')], { total })),
      );

      const result = await run({ query: CITED_BY_HIGGS, page, size: 50 });

      const out = structured<Output>(result);
      expect(out).toMatchObject({ page, entries: [], shown: 0, truncated, notice });
      expect(fullText(result)).toContain(`> ${notice}`);
      expect(bodyText(result)).toBe(`## INSPIRE citations, page ${page} (bibtex, 0 entries)`);
    },
  );

  it('keeps the no-match notice on a later page of a query that matches nothing', async () => {
    h.route('/literature', pagedLiterature([]));

    const out = structured<Output>(await run({ query: 'recid:99999999', page: 2 }));

    expect(out).toMatchObject({
      page: 2,
      entries: [],
      shown: 0,
      truncated: false,
      notice:
        'No INSPIRE literature matched "recid:99999999"; find the papers with cern_inspire_search_literature, then export by recid ("recid:N or recid:M").',
    });
  });

  it('returns a full page and its nextPage when the total request fails, saying the page is unchecked', async () => {
    routeTotalReply(refused);

    const result = await run({ query: CITED_BY_HIGGS, page: 2, size: 50 });

    const out = structured<Output>(result);
    expect(out.entries.map((e) => e.texkey)).toEqual(HIGGS_REFERENCE_TEXKEYS.slice(50, 100));
    expect(out).toMatchObject({
      truncated: true,
      nextPage: 3,
      notice: `This page came back full; request page 3 for any further entries. ${UNCHECKED}`,
    });
    expect(fullText(result)).toContain(`> This page came back full; request page 3`);
    expect(fullText(result)).toContain('**Next page:** 3');
  });

  it('reads a short page under a failed total as the last, still saying it is unchecked', async () => {
    const outcome = await settleWithFakeTimers(async () => {
      routeTotalReply(() => htmlResponse());
      return await run({ query: CITED_BY_HIGGS, page: 3, size: 50 });
    });
    if (!outcome.ok) throw outcome.error;

    const out = structured<Output>(outcome.value);
    expect(out.entries).toHaveLength(38);
    expect(out).toMatchObject({ truncated: false, notice: UNCHECKED });
    expect(out.nextPage).toBeUndefined();
  });

  it('says an empty page under a failed total is past the end or a no-match', async () => {
    routeTotalReply(refused);

    const out = structured<Output>(await run({ query: CITED_BY_HIGGS, page: 4, size: 50 }));

    expect(out).toMatchObject({
      entries: [],
      truncated: false,
      notice:
        "Page 4 came back empty and INSPIRE's match count could not be read, so either it is past the last page or nothing matched; request page 1 to tell which.",
    });
  });

  it('fails with invalid_query when INSPIRE refuses the page, though the total answered', async () => {
    const fake = pagedLiterature(HIGGS_REFERENCE_TEXKEYS);
    h.route('/literature', (request) =>
      new URL(request.url).searchParams.has('format')
        ? jsonResponse(badRequestBody('Invalid pagination parameters.'), { status: 400 })
        : fake(request),
    );

    const error = errorEnvelope(await run({ query: CITED_BY_HIGGS, page: 2, size: 50 }));

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data?.reason).toBe('invalid_query');
  });

  it('fails a call cancelled while the total is in flight as RequestCancelled, not as an unchecked page', async () => {
    const controller = new AbortController();
    const fake = pagedLiterature(HIGGS_REFERENCE_TEXKEYS);
    const hang = hangingFetch();
    h = startHarness({
      fetch: async (input, init) => {
        const request = new Request(input instanceof Request ? input.url : String(input));
        if (new URL(request.url).searchParams.has('format')) return fake(request);
        setTimeout(() => controller.abort(), 20);
        return await hang(input, init);
      },
    });

    const result = await run(
      { query: CITED_BY_HIGGS, page: 2, size: 50 },
      { context: { signal: controller.signal } },
    );

    expect(errorEnvelope(result).code).toBe(JsonRpcErrorCode.RequestCancelled);
  });
});

describe('format() parity', () => {
  it('lists every texkey and fences every entry verbatim as bibtex', async () => {
    routeBibtex();

    const result = await run({ query: 'x' });

    const out = structured<Output>(result);
    const text = bodyText(result);
    expect(text.startsWith('## INSPIRE citations, page 1 (bibtex, 3 entries)\n**Texkeys:** ')).toBe(
      true,
    );
    expect(text).toContain('**Texkeys:** ATLAS:2012yve, Maldacena:1997re, Doe:2020xyz');
    expect(text).toContain(`\`\`\`bibtex\n${out.entries.map((e) => e.text).join('\n\n')}\n\`\`\``);
    for (const entry of out.entries) expect(text).toContain(entry.text);
  });

  it('fences LaTeX entries as latex for both latex formats', async () => {
    h.route('/literature', textResponse(exportBody(LATEX_EU_ENTRIES), LATEX_EU_TYPE));
    const eu = bodyText(await run({ query: 'x', format: 'latex-eu' }));
    const us = bodyText(await run({ query: 'x', format: 'latex-us' }));

    expect(eu).toContain('```latex\n%\\cite{ATLAS:2012yve}');
    expect(us).toContain('```latex\n');
    expect(us).toContain('(latex-us, 2 entries)');
  });

  it('keeps INSPIRE\'s "and others" author abbreviation untouched', async () => {
    routeBibtex();

    const text = bodyText(await run({ query: 'x' }));

    expect(text).toContain('author = "Doe, Jane and others"');
  });

  it('opens a longer fence when an entry contains a backtick run, so the entry cannot escape it', async () => {
    const entry = '@misc{Doe:2024abc,\n    note = "```\n# Injected heading\n```"\n}';
    h.route('/literature', textResponse(exportBody([entry]), BIBTEX_TYPE));

    const result = await run({ query: 'x' });

    const text = bodyText(result);
    expect(structured<Output>(result).entries[0]?.text).toBe(entry);
    expect(text).toContain('````bibtex\n@misc{Doe:2024abc,');
    expect(text.trimEnd().endsWith('\n````')).toBe(true);
  });

  it('strips control and bidi characters from the fenced text and keeps them out of line starts', async () => {
    const bell = String.fromCharCode(7);
    const rlo = String.fromCharCode(0x202e);
    const entry = `@misc{Doe:2024abc,\n    title = "a${bell}b${rlo}c"\n}`;
    h.route('/literature', textResponse(exportBody([entry]), BIBTEX_TYPE));

    const text = bodyText(await run({ query: 'x' }));

    expect(text).toContain('title = "abc"');
    expect(text).not.toContain(bell);
    expect(text).not.toContain(rlo);
  });

  it('escapes brackets and a tag-opening < in the texkey line, not in the fenced entries', async () => {
    const entry = '@article{Doe:[x]<b>,\n    title = "[kept] <as is>"\n}';
    h.route('/literature', textResponse(exportBody([entry]), BIBTEX_TYPE));

    const result = await run({ query: 'x' });

    const text = bodyText(result);
    expect(structured<Output>(result).entries[0]?.texkey).toBe('Doe:[x]<b>');
    expect(text).toContain('**Texkeys:** Doe:\\[x\\]&lt;b>');
    expect(text).toContain('title = "[kept] <as is>"');
  });

  it('heads a one-entry page "1 entry" and a longer one "N entries"', async () => {
    routeBibtex(BIBTEX_ENTRIES.slice(0, 1));

    const one = await run({ query: 'recid:451647', size: 1 });

    expect(structured<Output>(one).entries).toHaveLength(1);
    expect(bodyText(one).split('\n')[0]).toBe('## INSPIRE citations, page 1 (bibtex, 1 entry)');
    stopHarness();
    h = startHarness();
    routeBibtex(BIBTEX_ENTRIES.slice(0, 2));
    expect(bodyText(await run({ query: 'x' })).split('\n')[0]).toBe(
      '## INSPIRE citations, page 1 (bibtex, 2 entries)',
    );
  });

  it('echoes the effective format, not the requested spelling', async () => {
    routeBibtex();

    expect(structured<Output>(await run({ query: 'x', format: 'latex-us' })).format).toBe(
      'latex-us',
    );
  });
});

describe('declared error contracts', () => {
  it('declares exactly the five reasons the design lists, with the tool name in the caller-input recoveries', () => {
    const errors = exportCitationsTool.errors ?? [];

    expect(errors.map((e) => e.reason)).toEqual([
      'beyond_result_window',
      'invalid_query',
      'inspire_rate_limited',
      'pacer_shed',
      'upstream_unreadable',
    ]);
    expect(errors[0]?.recovery).toBe(
      'Narrow the query with tighter terms, such as a date range ("and date > 2015") or a collaboration, until it matches under 10,000 papers, then page again with cern_inspire_export_citations.',
    );
    expect(errors[1]?.recovery).toBe(
      'Check the query against cern_inspire_list_reference topic search_syntax, then retry cern_inspire_export_citations with the corrected query.',
    );
    for (const entry of errors.slice(0, 2)) {
      expect(entry).toMatchObject({ severity: 'notice', code: JsonRpcErrorCode.ValidationError });
    }
  });

  it('routes an unreadable body to a later retry of the same page and size, never a smaller size that shifts the page', () => {
    const unreadable = exportCitationsTool.errors?.find((e) => e.reason === 'upstream_unreadable');

    expect(unreadable?.recovery).toBe(
      'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_export_citations with the same page and size.',
    );
  });

  it('reports a JSON body on an export route as upstream_unreadable and does not read it as entries', async () => {
    h.route('/literature', jsonResponse({ hits: { total: 0, hits: [] } }));

    const result = await run({ query: 'x' });

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data?.reason).toBe('upstream_unreadable');
  });

  it('attaches the contract through a direct handler call too', async () => {
    h.route(
      '/literature',
      jsonResponse(badRequestBody('Invalid pagination parameters.'), { status: 400 }),
    );
    const ctx = createMockContext({ errors: exportCitationsTool.errors });
    const input = exportCitationsTool.input.parse({ query: 'x' });

    await expect(exportCitationsTool.handler(input, ctx)).rejects.toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      data: { reason: 'invalid_query' },
    });
  });
});

describeFailureClasses({
  label: 'cern_inspire_export_citations',
  contract: exportCitationsTool.errors ?? [],
  invalidQuery: true,
  run: (options) => run({ query: 'recid:451647' }, options),
  install: (harness, reply) => harness.route('/literature', reply),
  unreadable: [
    ['a JSON object', () => jsonResponse({ hits: { total: 0, hits: [] } })],
    ['a JSON array', () => jsonResponse([])],
    ['an HTML page', () => htmlResponse()],
    ['a JSON body with leading whitespace', () => new Response('\n  {"a":1}', { status: 200 })],
  ],
});
