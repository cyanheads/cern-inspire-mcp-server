/**
 * @fileoverview Tests for cern_inspire_search_experiments through
 * `runToolContract` over an `InspireService` on a fake fetch: input validation
 * and blank-as-unset handling, the recid-versus-free-text query routing, the
 * required enrichment on a zero-result page, an under-cap page, and capped
 * pages, the lifecycle fields (the ongoing sentinel, completion dates), `format()`
 * parity with `structuredContent`, upstream text kept out of inline markdown
 * slots, and the shared upstream failure classes on the wire. No live network.
 * @module tests/tools/search-experiments.tool.test
 */

import type { z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { type RunToolContractOptions, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { searchExperimentsTool } from '@/mcp-server/tools/definitions/search-experiments.tool.js';
import { describeFailureClasses } from '../fixtures/failure-suite.js';
import {
  emptyBody,
  experimentMetadata,
  experimentPage,
  htmlResponse,
  jsonResponse,
  omit,
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

type Input = z.input<typeof searchExperimentsTool.input>;
type Output = z.infer<typeof searchExperimentsTool.output> & {
  cap: number;
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
  runToolContract(searchExperimentsTool, input, options);

/** A call with arguments the schema's input type would not accept, as a misbehaving client sends. */
const runRaw = (input: Record<string, unknown>) => run(input as Input);

const experiment = (n: number, overrides: Parameters<typeof experimentMetadata>[0] = {}) =>
  experimentMetadata({
    control_number: 1100000 + n,
    legacy_name: `CERN-LHC-EXP${n}`,
    experiment: { value: `EXP${n}` },
    ...overrides,
  });

const pageOf = (count: number, options: { total?: number } = {}) =>
  experimentPage(
    Array.from({ length: count }, (_, i) => experiment(i + 1)),
    options,
  );

const routePage = (body: unknown = pageOf(1)) => h.route('/experiments', jsonResponse(body));

const lines = (result: ToolResult) => bodyText(result).split('\n');

const params = () => h.requests[0]?.params;

/** The first ten characters of each body line: the markdown structure, not the upstream words. */
const shape = (result: ToolResult) => lines(result).map((line) => line.slice(0, 10));

const errors = searchExperimentsTool.errors ?? [];
const hint = (reason: string) => errors.find((e) => e.reason === reason)?.recovery;

describe('input', () => {
  it('applies the default limit and sends only q, fields, and size', async () => {
    routePage();

    const result = await run({ query: 'ATLAS' });

    expect(result.isError).toBeFalsy();
    expect(h.requests[0]?.path).toBe('/api/experiments');
    expect([...(h.requests[0]?.names ?? [])].sort()).toEqual(['fields', 'q', 'size']);
    expect(params()?.get('q')).toBe('ATLAS');
    expect(params()?.get('size')).toBe('5');
    expect(structured<Output>(result).cap).toBe(5);
  });

  it('reads a blank limit as unset', async () => {
    routePage();

    const result = await run({ query: 'ATLAS', limit: '' } as Input);

    expect(result.isError).toBeFalsy();
    expect(params()?.get('size')).toBe('5');
    expect(structured<Output>(result).cap).toBe(5);
  });

  it('trims the query before sending it', async () => {
    routePage();

    await run({ query: '   Belle II  ' });

    expect(params()?.get('q')).toBe('Belle II');
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
    ['limit 0', { query: 'ATLAS', limit: 0 }],
    ['limit 26', { query: 'ATLAS', limit: 26 }],
    ['a negative limit', { query: 'ATLAS', limit: -1 }],
    ['a fractional limit', { query: 'ATLAS', limit: 2.5 }],
    ['a limit given as text', { query: 'ATLAS', limit: '5' }],
  ])('rejects %s as InvalidParams without calling INSPIRE', async (_label, input) => {
    const result = await runRaw(input);

    const error = errorEnvelope(result);
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.data?.reason).toBe('invalid_arguments');
    expect(error.message).toContain('cern_inspire_search_experiments');
    expect(h.requests).toHaveLength(0);
  });

  it.each([
    ['limit 1', 1],
    ['limit 25', 25],
  ])('accepts %s', async (_label, limit) => {
    routePage();

    const result = await run({ query: 'ATLAS', limit });

    expect(result.isError).toBeFalsy();
    expect(params()?.get('size')).toBe(String(limit));
    expect(structured<Output>(result).cap).toBe(limit);
  });
});

describe('query routing', () => {
  it.each([
    ['a name', 'ATLAS', 'ATLAS'],
    ['a legacy name, sent as written', 'CERN-LHC-CMS', 'CERN-LHC-CMS'],
    ['a lower-case legacy name, left as written', 'cern-lhc-cms', 'cern-lhc-cms'],
    ['an accelerator', 'Tevatron', 'Tevatron'],
    ['a multi-word name', 'Belle II', 'Belle II'],
    ['an experiment recid', '1108541', 'control_number:1108541'],
    ['a recid with surrounding blanks', '  1108541 ', 'control_number:1108541'],
    ['a one-digit recid', '7', 'control_number:7'],
    ['a nine-digit recid', '123456789', 'control_number:123456789'],
    ['ten digits, which are no recid', '1234567890', '1234567890'],
    ['digits with a letter', '1108541a', '1108541a'],
    ['a name that starts with digits', '2HDM', '2HDM'],
  ])('sends %s as q=%s', async (_label, query, q) => {
    routePage();

    await run({ query });

    expect(params()?.get('q')).toBe(q);
  });

  it('accepts a recid sent as a JSON number, as some clients send it', async () => {
    routePage();

    const result = await runRaw({ query: 1108541 });

    expect(result.isError).toBeFalsy();
    expect(params()?.get('q')).toBe('control_number:1108541');
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
    expect(hint('invalid_query')).toContain('cern_inspire_search_experiments');
    expect(hint('upstream_unreadable')).toContain('cern_inspire_search_experiments');
  });
});

describe('required enrichment', () => {
  it('writes every required field on a zero-result page', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'Zzzz' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({
      experiments: [],
      totalCount: 0,
      truncated: false,
      shown: 0,
      cap: 5,
    });
    expect(out.notice).toBeTypeOf('string');
    expect(fullText(result)).toContain('**0 total**');
    expect(bodyText(result)).toBe('## INSPIRE experiments (0)');
  });

  it('writes every required field on an under-cap page and sets no notice', async () => {
    routePage(pageOf(3));

    const result = await run({ query: 'LHC', limit: 10 });

    const out = structured<Output>(result);
    expect(out.experiments).toHaveLength(3);
    expect(out).toMatchObject({ totalCount: 3, truncated: false, shown: 3, cap: 10 });
    expect(out.notice).toBeUndefined();
    expect(fullText(result)).toContain('**3 total**');
  });

  it('keeps a page of exactly limit records under the cap when nothing else matched', async () => {
    routePage(pageOf(5));

    const out = structured<Output>(await run({ query: 'LHC', limit: 5 }));

    expect(out).toMatchObject({ shown: 5, cap: 5, truncated: false, totalCount: 5 });
    expect(out.notice).toBeUndefined();
  });

  it('marks a page truncated when more records matched than were returned', async () => {
    routePage(pageOf(5, { total: 40 }));

    const result = await run({ query: 'LHC' });

    const out = structured<Output>(result);
    expect(out).toMatchObject({ truncated: true, shown: 5, cap: 5, totalCount: 40 });
    expect(out.notice).toBe(
      'More experiments matched; raise limit (max 25) or use a more specific name or legacy name.',
    );
    expect(fullText(result)).toContain(out.notice as string);
  });

  it('uses the at-maximum wording when the limit is already 25', async () => {
    routePage(pageOf(25, { total: 400 }));

    const out = structured<Output>(await run({ query: 'LHC', limit: 25 }));

    expect(out).toMatchObject({ truncated: true, shown: 25, cap: 25, totalCount: 400 });
    expect(out.notice).toBe(
      'More experiments matched than the 25 returned; use a more specific name or legacy name.',
    );
  });

  it('reports the match total, not the page length, as totalCount', async () => {
    routePage(pageOf(2, { total: 2 }));

    const out = structured<Output>(await run({ query: 'LHC' }));

    expect(out).toMatchObject({ totalCount: 2, shown: 2, truncated: false });
  });
});

describe('zero-hit notice', () => {
  it('names the query, then points at the common name, the accelerator, and literature search', async () => {
    routePage(emptyBody());

    const text = structured<Output>(await run({ query: 'Zzzz' })).notice ?? '';

    expect(text.startsWith('No INSPIRE experiment matched "Zzzz". ')).toBe(true);
    expect(text).toContain('collaboration');
    expect(text).toContain('accelerator');
    expect(text).toContain('cern_inspire_search_literature');
  });

  it('names a recid lookup by its digits', async () => {
    routePage(emptyBody());

    const out = structured<Output>(await run({ query: '999999999' }));

    expect(out.notice?.startsWith('No INSPIRE experiment matched "999999999". ')).toBe(true);
  });

  it('echoes the query through inline(): newlines flatten and brackets are escaped', async () => {
    routePage(emptyBody());

    const result = await run({ query: 'ATLAS\r\n# injected\n[x](http://evil) <b>' });

    const text = structured<Output>(result).notice ?? '';
    expect(text).not.toMatch(/[\r\n]/);
    expect(text).toContain('ATLAS # injected \\[x\\](http://evil) &lt;b&gt;');
    expect(fullText(result)).not.toMatch(/^# injected/m);
  });
});

describe('lifecycle fields', () => {
  const only = async (
    overrides: Parameters<typeof experimentMetadata>[0],
    drop: ('date_started' | 'date_completed')[] = [],
  ) => {
    h = startHarness();
    routePage(experimentPage([omit(experimentMetadata(overrides), ...drop)]));
    const result = await run({ query: 'ATLAS' });
    return { result, record: structured<Output>(result).experiments[0] };
  };

  it('turns the 9999 sentinel into ongoing: true and no completion date', async () => {
    const { result, record } = await only({ date_started: '2009', date_completed: '9999' });

    expect(record?.ongoing).toBe(true);
    expect(record).not.toHaveProperty('dateCompleted');
    expect(record?.dateStarted).toBe('2009');
    expect(bodyText(result)).toContain('**Dates:** started 2009 · **Ongoing:** yes');
    expect(bodyText(result)).not.toContain('9999');
  });

  it('keeps a real completion date and marks the experiment finished', async () => {
    const { result, record } = await only({
      date_proposed: '1984',
      date_approved: '1987',
      date_started: '1992',
      date_completed: '2011-09-30',
    });

    expect(record).toMatchObject({
      dateProposed: '1984',
      dateApproved: '1987',
      dateStarted: '1992',
      dateCompleted: '2011-09-30',
      ongoing: false,
    });
    expect(bodyText(result)).toContain(
      '**Dates:** proposed 1984 · approved 1987 · started 1992 · completed 2011-09-30 · **Ongoing:** no',
    );
  });

  it('says Not available for a record with no dates and leaves ongoing unknown', async () => {
    const { result, record } = await only({}, ['date_started', 'date_completed']);

    expect(record).not.toHaveProperty('ongoing');
    expect(bodyText(result)).toContain('**Dates:** Not available · **Ongoing:** not recorded');
  });

  it.each<
    [
      string,
      Parameters<typeof experimentMetadata>[0],
      ('date_started' | 'date_completed')[],
      string,
    ]
  >([
    [
      'only a proposal date',
      { date_proposed: '2015' },
      ['date_started', 'date_completed'],
      'proposed 2015',
    ],
    ['only a start date', { date_started: '2020-01-01' }, ['date_completed'], 'started 2020-01-01'],
  ])(
    'leaves ongoing unknown for a record with %s and no completion date, never inferring it',
    async (_label, dates, drop, rendered) => {
      const { result, record } = await only(dates, drop);

      expect(record).not.toHaveProperty('ongoing');
      expect(record).not.toHaveProperty('dateCompleted');
      expect(result.structuredContent).toEqual(expect.schemaMatching(searchExperimentsTool.output));
      expect(bodyText(result)).toContain(`**Dates:** ${rendered} · **Ongoing:** not recorded`);
    },
  );

  it("echoes INSPIRE's stored paper count with the label that says it is INSPIRE's", async () => {
    const { result, record } = await only({ number_of_papers: 18497 });

    expect(record?.numberOfPapers).toBe(18497);
    expect(bodyText(result)).toContain('**Papers (INSPIRE count):** 18497');
  });

  it('prints a paper count of zero rather than dropping it', async () => {
    const { result, record } = await only({ number_of_papers: 0 });

    expect(record?.numberOfPapers).toBe(0);
    expect(bodyText(result)).toContain('**Papers (INSPIRE count):** 0');
  });

  it('builds the literature query from the legacy name', async () => {
    const { result, record } = await only({ legacy_name: 'CERN-LHC-ATLAS' });

    expect(record?.literatureQuery).toBe('accelerator_experiments.legacy_name:"CERN-LHC-ATLAS"');
    expect(bodyText(result)).toContain(
      '**Literature query:** accelerator_experiments.legacy_name:"CERN-LHC-ATLAS"',
    );
  });
});

describe('records and format() parity', () => {
  const rich = () =>
    experimentMetadata({
      long_name: 'A Toroidal LHC ApparatuS',
      inspire_classification: ['Collider Experiments|Hadrons|p p'],
      project_type: ['experiment', 'collaboration'],
      date_proposed: '1992',
      date_approved: '1996',
      institutions: [
        { value: 'CERN', record: { $ref: 'https://inspirehep.net/api/institutions/902725' } },
        { value: 'Example Institute' },
      ],
      urls: [{ value: 'https://example.org/atlas', description: 'Home page' }],
      name_variants: ['ATLAS Experiment', 'A Toroidal LHC Apparatus'],
      core: true,
    });

  it('returns each record in the schema shape and renders every value into content[]', async () => {
    routePage(experimentPage([rich(), experiment(2)]));

    const result = await run({ query: 'ATLAS' });

    const out = structured<Output>(result);
    expect(out).toEqual(expect.schemaMatching(searchExperimentsTool.output));
    const text = bodyText(result);
    for (const leaf of leaves(out.experiments)) expect(text).toContain(String(leaf));
  });

  it('renders the facts of one record into labelled lines', async () => {
    routePage(experimentPage([rich()]));

    const text = bodyText(await run({ query: 'ATLAS' }));

    expect(text).toContain('## INSPIRE experiments (1)');
    expect(text).toContain('### 1. CERN-LHC-ATLAS — ATLAS');
    expect(text).toContain(
      '**recid:** 1108541 · **Short name:** ATLAS · **Accelerator:** LHC · **Papers (INSPIRE count):** 18497 · **Core:** yes',
    );
    expect(text).toContain('**Long name:** A Toroidal LHC ApparatuS');
    expect(text).toContain('**Collaboration:** ATLAS (subgroups: ATLAS Higgs Working Group)');
    expect(text).toContain('**Institutions:** CERN (institution recid 902725); Example Institute');
    expect(text).toContain('**Classification:** Collider Experiments|Hadrons|p p');
    expect(text).toContain('**Project types:** experiment, collaboration');
    expect(text).toContain('**Name variants:** ATLAS Experiment, A Toroidal LHC Apparatus');
    expect(text).toContain('**URLs:**\n- https://example.org/atlas — Home page');
    expect(text).toContain('**Description:**\n> A general-purpose detector at the LHC.');
  });

  it('numbers records in relevance order', async () => {
    routePage(pageOf(3));

    const result = await run({ query: 'LHC' });

    expect(structured<Output>(result).experiments.map((e) => e.legacyName)).toEqual([
      'CERN-LHC-EXP1',
      'CERN-LHC-EXP2',
      'CERN-LHC-EXP3',
    ]);
    expect(lines(result).filter((line) => line.startsWith('### '))).toEqual([
      '### 1. CERN-LHC-EXP1 — EXP1',
      '### 2. CERN-LHC-EXP2 — EXP2',
      '### 3. CERN-LHC-EXP3 — EXP3',
    ]);
  });

  it('prints a core flag of false as no, and a collaboration without subgroups plainly', async () => {
    routePage(
      experimentPage([
        experimentMetadata({ core: false, collaboration: { value: 'ATLAS', subgroup_names: [] } }),
      ]),
    );

    const text = bodyText(await run({ query: 'ATLAS' }));

    expect(text).toContain('**Core:** no');
    expect(text).toContain('**Collaboration:** ATLAS\n');
    expect(text).not.toContain('subgroups');
  });

  it('renders a sparse record without inventing sections or values', async () => {
    routePage(
      experimentPage([{ control_number: 5, legacy_name: 'FNAL-E-0001', date_completed: '1975' }]),
    );

    const result = await run({ query: 'FNAL-E-0001' });

    const [only] = structured<Output>(result).experiments;
    expect(only).toEqual({
      recid: '5',
      legacyName: 'FNAL-E-0001',
      institutions: [],
      classification: [],
      projectTypes: [],
      dateCompleted: '1975',
      ongoing: false,
      urls: [],
      nameVariants: [],
      literatureQuery: 'accelerator_experiments.legacy_name:"FNAL-E-0001"',
    });
    expect(bodyText(result)).toBe(
      [
        '## INSPIRE experiments (1)',
        '',
        '### 1. FNAL-E-0001',
        '**recid:** 5',
        '**Dates:** completed 1975 · **Ongoing:** no',
        '**Literature query:** accelerator_experiments.legacy_name:"FNAL-E-0001"',
      ].join('\n'),
    );
  });

  it('labels a record without a legacy name', async () => {
    routePage(experimentPage([{ control_number: 6, experiment: { value: 'Nameless' } }]));

    const result = await run({ query: '6' });

    expect(structured<Output>(result).experiments[0]?.legacyName).toBe('');
    expect(bodyText(result)).toContain('### 1. (no legacy name) — Nameless');
  });

  it('renders no content blocks other than text', async () => {
    routePage(pageOf(1));

    const result = await run({ query: 'ATLAS' });

    expect(result.content.every((block) => block.type === 'text')).toBe(true);
  });
});

describe('upstream text stays out of inline markdown slots', () => {
  const NEL = String.fromCharCode(0x85);
  const LS = String.fromCharCode(0x2028);
  const attack = '\r\n# Injected heading\n**Core:** forged';

  const record = (decorate: (text: string) => string) =>
    experimentMetadata({
      legacy_name: decorate('CERN-LHC-ATLAS'),
      experiment: { value: decorate('ATLAS'), short_name: decorate('ATL') },
      long_name: decorate('A Toroidal LHC ApparatuS'),
      accelerator: { value: decorate('LHC') },
      collaboration: {
        value: decorate('ATLAS'),
        subgroup_names: [decorate('Higgs Working Group')],
      },
      institutions: [{ value: decorate('CERN') }],
      inspire_classification: [decorate('Collider Experiments|Hadrons|p p')],
      project_type: [decorate('experiment')],
      date_proposed: decorate('1992'),
      date_approved: decorate('1996'),
      date_started: decorate('2009'),
      date_completed: decorate('2040'),
      urls: [{ value: 'https://example.org/atlas', description: decorate('Home page') }],
      name_variants: [decorate('ATLAS Experiment')],
    });

  const render = async (decorate: (text: string) => string) => {
    h = startHarness();
    routePage(experimentPage([record(decorate)]));
    return run({ query: 'ATLAS' });
  };

  it('keeps the markdown structure of a benign record when every inline field carries line breaks', async () => {
    const benign = await render((text) => text);
    const hostile = await render((text) => `${text}${attack}`);

    expect(shape(hostile)).toEqual(shape(benign));
    expect(lines(hostile).some((line) => line.startsWith('# Injected'))).toBe(false);
    expect(lines(hostile).filter((line) => line.startsWith('#'))).toEqual([
      '## INSPIRE experiments (1)',
      '### 1. CERN-LHC-ATLAS # Injected heading **Core:** forged — ATLAS # Injected heading **Core:** forged',
    ]);
  });

  it('flattens the other line separators and keeps structuredContent verbatim', async () => {
    const result = await render((text) => `${text}${LS}x${NEL}y`);

    const [only] = structured<Output>(result).experiments;
    expect(only?.legacyName).toBe(`CERN-LHC-ATLAS${LS}x${NEL}y`);
    expect(bodyText(result)).not.toMatch(new RegExp(`[${LS}${NEL}]`));
    expect(bodyText(result)).toContain('### 1. CERN-LHC-ATLAS x y — ATLAS x y');
  });

  it('escapes link brackets and angle brackets in names and institutions', async () => {
    routePage(
      experimentPage([
        experimentMetadata({
          legacy_name: 'CERN-[X]',
          experiment: { value: '<ATLAS>' },
          institutions: [{ value: '[Evil](http://evil.example.org)' }],
        }),
      ]),
    );

    const result = await run({ query: 'ATLAS' });

    const text = bodyText(result);
    expect(text).toContain('### 1. CERN-\\[X\\] — &lt;ATLAS&gt;');
    expect(text).toContain('**Institutions:** \\[Evil\\](http://evil.example.org)');
    expect(structured<Output>(result).experiments[0]?.name).toBe('<ATLAS>');
  });

  it('keeps every line of a multi-line description inside the blockquote', async () => {
    routePage(
      experimentPage([
        experimentMetadata({
          description: 'First.\n\n# Not a heading\r\n- not a bullet\n[x](y)',
        }),
      ]),
    );

    const result = await run({ query: 'ATLAS' });

    const body = lines(result);
    const start = body.indexOf('**Description:**');
    expect(start).toBeGreaterThan(-1);
    const quoted = body.slice(start + 1);
    expect(quoted.length).toBeGreaterThanOrEqual(5);
    expect(quoted.every((line) => line.startsWith('>'))).toBe(true);
    expect(quoted.join('\n')).toContain('> # Not a heading');
    expect(quoted.join('\n')).toContain('> \\[x\\](y)');
  });

  it('percent-encodes a hostile URL, NEL included, and keeps it on one line', async () => {
    routePage(
      experimentPage([
        experimentMetadata({
          urls: [{ value: `https://example.org/a${NEL}b c[d]<e>|f`, description: 'Home' }],
        }),
      ]),
    );

    const result = await run({ query: 'ATLAS' });

    expect(bodyText(result)).toContain(
      '- https://example.org/a%C2%85b%20c%5Bd%5D%3Ce%3E%7Cf — Home',
    );
    expect(structured<Output>(result).experiments[0]?.urls[0]?.url).toBe(
      `https://example.org/a${NEL}b c[d]<e>|f`,
    );
  });
});

describeFailureClasses({
  label: 'cern_inspire_search_experiments',
  contract: errors,
  invalidQuery: true,
  path: '/api/experiments',
  run: (options) => run({ query: 'ATLAS' }, options),
  install: (harness, reply) => harness.route('/experiments', reply),
  unreadable: [
    ['an HTML page', () => htmlResponse()],
    ['truncated JSON', () => new Response('{"hits":{"total":', { status: 200 })],
    ['an empty body', () => new Response('', { status: 200 })],
    ['JSON without the search envelope', () => jsonResponse({ hits: {} })],
    ['an envelope whose hits are not a list', () => jsonResponse({ hits: { total: 1, hits: {} } })],
  ],
});
