/**
 * @fileoverview Tests for cern_inspire_search_authors through `runToolContract`
 * over an `InspireService` on a fake fetch: input validation and blank-as-unset
 * handling, every identifier form the query accepts and the route it takes,
 * the required enrichment on a zero-result page, an under-cap page, and capped
 * pages, the per-route zero-hit hints, the deleted-profile notice, `format()`
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

const pageOf = (count: number, options: { total?: number } = {}) =>
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
  it('applies the default limit and sends only q, fields, and size', async () => {
    routePage();

    const result = await run({ query: 'Doe, Jane' });

    expect(result.isError).toBeFalsy();
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['fields', 'q', 'size']);
    expect(h.requests[0]?.path).toBe('/api/authors');
    expect(params()?.get('size')).toBe('5');
    expect(structured<Output>(result).cap).toBe(5);
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
    ['limit 26', { query: 'Doe', limit: 26 }],
    ['a negative limit', { query: 'Doe', limit: -1 }],
    ['a fractional limit', { query: 'Doe', limit: 2.5 }],
    ['a limit given as text', { query: 'Doe', limit: '5' }],
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

    expect(fullText(result)).toContain('**Matched as:** bai');
  });
});

describe('declared error contracts', () => {
  it('declares exactly the four shared reasons, with tool-specific recovery text', () => {
    expect(errors.map((e) => e.reason)).toEqual([
      'invalid_query',
      'inspire_rate_limited',
      'pacer_shed',
      'upstream_unreadable',
    ]);
    expect(errors.find((e) => e.reason === 'invalid_query')).toMatchObject({
      code: JsonRpcErrorCode.ValidationError,
      severity: 'notice',
    });
    expect(hint('invalid_query')).toContain('cern_inspire_search_authors');
    expect(hint('upstream_unreadable')).toContain('cern_inspire_search_authors');
  });
});

describe('required enrichment', () => {
  it('writes every required field on a zero-result page', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'Zzzz, Nobody' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      authors: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 5,
      matchedAs: 'name',
    });
    expect(out.notice).toBeTypeOf('string');
    expect(fullText(result)).toContain('**0 total**');
    expect(fullText(result)).toContain('**Matched as:** name');
    expect(bodyText(result)).toBe('## INSPIRE author profiles (0)');
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

  it('marks a page truncated when more profiles matched than were returned', async () => {
    routePage(pageOf(5, { total: 51_734 }));

    const result = await run({ query: 'Doe' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({ truncated: true, shown: 5, cap: 5, totalCount: 51_734 });
    expect(out.notice).toBe(
      'More profiles matched; raise limit (max 25), add name parts, or search by BAI or ORCID to pin one person.',
    );
    expect(fullText(result)).toContain(out.notice as string);
  });

  it('uses the at-maximum wording when the limit is already 25', async () => {
    routePage(pageOf(25, { total: 51_734 }));

    const out = structured<Output>(await run({ query: 'Doe', limit: 25 }));

    expect(out).toMatchObject({ truncated: true, shown: 25, cap: 25 });
    expect(out.notice).toBe(
      'More profiles matched than the 25 returned; add name parts, or search by BAI or ORCID to pin one person.',
    );
  });

  it('reports totalCount from the match total, not the page length', async () => {
    routePage(pageOf(2, { total: 2 }));

    const out = structured<Output>(await run({ query: 'Doe, Jane' }));

    expect(out).toMatchObject({ totalCount: 2, shown: 2, truncated: false });
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

  it('echoes the query through inline(): newlines flatten and brackets are escaped', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'Doe\r\n# injected\n[x](http://evil) <b>' });

    const text = structured<Output>(result).notice ?? '';
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('Doe # injected \\[x\\](http://evil) &lt;b&gt;');
    expect(fullText(result)).not.toMatch(/^# injected/m);
  });
});

describe('surname-miss notice', () => {
  const named = (n: number, value: string) => author(n, { name: { value } });

  const surnameMiss = (query: string) =>
    `No profile on this page has a surname in "${query}"; INSPIRE widened the match by reading name parts as initials, so these may be other people. Check the spelling, or search by BAI or ORCID.`;

  it('flags a misspelled surname whose page holds only namesakes-by-initial, ahead of the more-matched line', async () => {
    routePage(
      authorPage([named(1, 'Magana, Juan'), named(2, 'Mendez, Juan'), named(3, 'Luo, Juan-juan')], {
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
      `${surnameMiss('Maldecena, Juan')} More profiles matched; raise limit (max 25), add name parts, or search by BAI or ORCID to pin one person.`,
    );
    expect(fullText(result)).toContain(
      'INSPIRE widened the match by reading name parts as initials',
    );
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

  it('does not count a surname that the query only begins', async () => {
    routePage(authorPage([named(1, 'Maldacena, Juan')]));

    const out = structured<Output>(await run({ query: 'Maldacen, Juan' }));

    expect(out.notice).toBe(surnameMiss('Maldacen, Juan'));
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
    expect(bodyText(result)).toContain('## INSPIRE author profiles (2)');
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

  it('puts the more-matched line ahead of the dropped-profile line when both apply', async () => {
    routePage(authorPage([author(1), deleted(2), author(3)], { total: 90 }));

    const out = structured<Output>(await run({ query: 'Doe' }));

    expect(out).toMatchObject({ truncated: true, shown: 2, totalCount: 90 });
    expect(out.notice?.startsWith('More profiles matched; raise limit')).toBe(true);
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

    expect(text).toContain('## INSPIRE author profiles (1)');
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
        '## INSPIRE author profiles (1)',
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
      '## INSPIRE author profiles (1)',
      '### 1. Doe, Jane # Injected heading **Status:** forged (preferred: Jane Doe # Injected heading **Status:** forged)',
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
