/**
 * @fileoverview Tests for cern_inspire_export_citations through `runToolContract`
 * over an `InspireService` on a fake fetch: input validation and blank-as-unset
 * handling, request mapping (`size + 1` for truncation detection), BibTeX and
 * LaTeX entry splitting and texkeys, the required enrichment on a zero-result
 * page, an under-cap page, and a truncated page, the notices the design
 * specifies, `format()` parity with `structuredContent`, citation text kept
 * verbatim in a fence that upstream backticks cannot close, and the shared
 * upstream failure classes on the wire. No live network.
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
  htmlResponse,
  jsonResponse,
  LATEX_EU_ENTRIES,
  textResponse,
} from '../fixtures/inspire-upstream.js';
import { type ServiceHarness, startHarness, stopHarness } from '../fixtures/service-harness.js';
import { bodyText, errorEnvelope, fullText, structured } from '../fixtures/tool-result.js';

vi.mock('@/services/inspire/inspire-service.js', async (importOriginal) =>
  (await import('../fixtures/active-service.js')).withActiveService(await importOriginal()),
);

type Input = z.input<typeof exportCitationsTool.input>;
type Output = z.infer<typeof exportCitationsTool.output> & {
  cap: number;
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
  it('applies the defaults: bibtex, relevance, ten entries, requested as size 11', async () => {
    routeBibtex();

    const result = await run({ query: 'recid:451647' });

    expect(result.isError).toBeFalsy();
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['format', 'q', 'size']);
    expect(params()?.get('format')).toBe('bibtex');
    expect(params()?.get('size')).toBe('11');
    expect(structured<Output>(result)).toMatchObject({ format: 'bibtex', cap: 10 });
  });

  it('reads a blank string on format, sort, and size as unset', async () => {
    routeBibtex();

    const result = await run({ query: 'recid:451647', format: '', sort: '', size: '' } as Input);

    expect(result.isError).toBeFalsy();
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['format', 'q', 'size']);
    expect(params()?.get('format')).toBe('bibtex');
    expect(params()?.get('size')).toBe('11');
    expect(structured<Output>(result).format).toBe('bibtex');
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

  it('sends only q, format, size, and the optional sort to INSPIRE, never fields or page', async () => {
    routeBibtex();

    await run({ query: 'x', sort: 'mostcited' });

    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['format', 'q', 'size', 'sort']);
  });
});

describe('entries', () => {
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
    expect(bodyText(result)).toBe('## INSPIRE citations (bibtex, 0 entries)');
  });

  it('treats a whitespace-only body as zero matches', async () => {
    h.route('/literature', textResponse('\n\n  \n', BIBTEX_TYPE));

    const out = structured<Output>(await run({ query: 'x' }));

    expect(out).toMatchObject({ entries: [], shown: 0, truncated: false });
    expect(out.notice).toContain('No INSPIRE literature matched "x"');
  });

  it('echoes the query through inline() in the no-match notice', async () => {
    h.route('/literature', textResponse('', BIBTEX_TYPE));

    const result = await run({ query: 'recid:1\r\n# injected\n[x](http://evil) <b>' });

    const notice = structured<Output>(result).notice ?? '';
    expect(notice).not.toMatch(/[\r\n]/);
    expect(notice).toContain('recid:1 # injected \\[x\\](http://evil) &lt;b&gt;');
    expect(fullText(result)).not.toMatch(/^# injected/m);
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

  it('truncates at size when INSPIRE returns the extra entry, and sets the cap notice', async () => {
    routeBibtex();

    const result = await run({ query: 'x', size: 2 });

    const out = structured<Output>(result);
    expect(out.entries.map((e) => e.texkey)).toEqual(['ATLAS:2012yve', 'Maldacena:1997re']);
    expect(out).toMatchObject({
      truncated: true,
      shown: 2,
      cap: 2,
      notice:
        'More papers matched than size; raise size (max 50), narrow the query, or export by recid.',
    });
    expect(fullText(result)).toContain('**truncated:** true');
    expect(fullText(result)).toContain('> More papers matched than size');
    expect(bodyText(result)).toContain('(bibtex, 2 entries)');
    expect(bodyText(result)).not.toContain('Doe:2020xyz');
  });

  it('truncates a LaTeX export the same way', async () => {
    h.route('/literature', textResponse(exportBody(LATEX_EU_ENTRIES), LATEX_EU_TYPE));

    const out = structured<Output>(await run({ query: 'x', format: 'latex-eu', size: 1 }));

    expect(out.entries).toHaveLength(1);
    expect(out).toMatchObject({ truncated: true, shown: 1, cap: 1 });
  });
});

describe('format() parity', () => {
  it('lists every texkey and fences every entry verbatim as bibtex', async () => {
    routeBibtex();

    const result = await run({ query: 'x' });

    const out = structured<Output>(result);
    const text = bodyText(result);
    expect(text.startsWith('## INSPIRE citations (bibtex, 3 entries)\n**Texkeys:** ')).toBe(true);
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

  it('escapes brackets and angle brackets in the texkey line, not in the fenced entries', async () => {
    const entry = '@article{Doe:[x]<b>,\n    title = "[kept] <as is>"\n}';
    h.route('/literature', textResponse(exportBody([entry]), BIBTEX_TYPE));

    const result = await run({ query: 'x' });

    const text = bodyText(result);
    expect(structured<Output>(result).entries[0]?.texkey).toBe('Doe:[x]<b>');
    expect(text).toContain('**Texkeys:** Doe:\\[x\\]&lt;b&gt;');
    expect(text).toContain('title = "[kept] <as is>"');
  });

  it('echoes the effective format, not the requested spelling', async () => {
    routeBibtex();

    expect(structured<Output>(await run({ query: 'x', format: 'latex-us' })).format).toBe(
      'latex-us',
    );
  });
});

describe('declared error contracts', () => {
  it('declares exactly the four reasons the design lists, with the tool name in invalid_query', () => {
    const errors = exportCitationsTool.errors ?? [];

    expect(errors.map((e) => e.reason)).toEqual([
      'invalid_query',
      'inspire_rate_limited',
      'pacer_shed',
      'upstream_unreadable',
    ]);
    expect(errors[0]?.recovery).toBe(
      'Check the query against cern_inspire_list_reference topic search_syntax, then retry cern_inspire_export_citations with the corrected query.',
    );
    expect(errors[0]).toMatchObject({ severity: 'notice', code: JsonRpcErrorCode.ValidationError });
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
