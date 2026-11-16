/**
 * @fileoverview The literature query scanners: conservative empty-field
 * detection, the arXiv version-suffix rewrite and its notice, and the CPU growth
 * bounds of both.
 * @module tests/shared/query-fields.test
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  arxivVersionNotice,
  hasEmptyQueryField,
  unversionArxivIds,
} from '@/mcp-server/tools/inputs.js';
import { measureGrowth } from '../fixtures/measure-growth.js';

describe('hasEmptyQueryField', () => {
  it.each([
    'a:',
    'a:""',
    "a:''",
    'a: " "',
    'a:("")',
    'a: not ""',
    'a:(((not "\n\t ")))',
    '(a:)',
    'a: and t higgs',
    't: OR a Witten',
    'a: not',
    'a:(not)',
    'a:(((not)))',
    'a: not not',
    'AFFILIATION-ID:',
    'refersto:',
    'date-earliest:',
    't:/foo a: or bar/ and a:',
  ])('recognizes an empty clause in %s', (query) => expect(hasEmptyQueryField(query)).toBe(true));
  it.each([
    'a: Witten',
    'a Witten',
    'a:(Witten or Maldacena)',
    'a:(not Witten)',
    'a: not Witten and Maldacena',
    '(t:higgs and not a:Witten)',
    't "a:"',
    't:"and or not"',
    'a:"\\""',
    "a:'\\''",
    'refersto:a:""',
    't:"escaped \\" a: still quoted"',
    "t:'a:'",
    't:/foo a: or bar/',
    't /foo a: or bar/',
    '/foo a: or bar/',
    'refersto:t:/foo a: not/',
    'https://example.org/a:',
    'https://example.org/(a:)',
    'doi:10.1016/(a:)',
    'doi:10.1016/a:',
    'arxiv:1207.7214',
    'authors.full_name:',
    'unknown:',
    'refersto:recid:451647',
    'citedby:recid:1124337',
    'a:((((not Witten))))',
    't:"unclosed a:',
  ])('leaves legitimate or unrecognized syntax alone: %s', (query) =>
    expect(hasEmptyQueryField(query)).toBe(false),
  );

  it.each([
    'plain',
    'repeated',
    'open',
    'nested',
    'overlapping',
    'quoted',
    'unclosed',
    'finalBreak',
    'breaks',
  ] as const)(
    'bounds %s scanning over a 64x span using thread CPU',
    // Synchronous CPU timing: vitest cannot interrupt it, so its wall-clock timeout guards nothing.
    { timeout: 0 },
    (shape) => {
      const input = (size: number) => {
        const unit = {
          plain: 'x',
          repeated: 'a:Witten ',
          open: 'a:(',
          nested: '(not ',
          overlapping: 'a:a:a:',
          quoted: '"a: not" ',
          unclosed: 'a:"',
          finalBreak: ' ',
          breaks: 'a:"\n " ',
        }[shape];
        const text = unit.repeat(Math.ceil(size / unit.length));
        return shape === 'finalBreak' ? `a:"${text}\n"` : text;
      };
      for (const size of [10_000, 20_000, 40_000, 80_000, 160_000, 320_000]) {
        const growth = measureGrowth(
          hasEmptyQueryField,
          { small: input(5_000), large: input(size) },
          { maxLargeMs: 100, maxRatio: 256 },
        );
        expect(growth.withinLimits, `${shape} ${size}: ${growth.summary}`).toBe(true);
      }
    },
  );
});

describe('unversionArxivIds', () => {
  /** A query, the query sent, and each rewritten clause as written → as sent. */
  it.each<[string, string, [string, string][]]>([
    ['arxiv:1207.7214v2', 'arxiv:1207.7214', [['arxiv:1207.7214v2', 'arxiv:1207.7214']]],
    ['arxiv: 1207.7214v2', 'arxiv: 1207.7214', [['arxiv: 1207.7214v2', 'arxiv: 1207.7214']]],
    ['arxiv 1207.7214v2', 'arxiv 1207.7214', [['arxiv 1207.7214v2', 'arxiv 1207.7214']]],
    ['ARXIV 1207.7214V2', 'ARXIV 1207.7214', [['ARXIV 1207.7214V2', 'ARXIV 1207.7214']]],
    ['eprint 1207.7214v2', 'eprint 1207.7214', [['eprint 1207.7214v2', 'eprint 1207.7214']]],
    ['eprint:1207.7214v2', 'eprint:1207.7214', [['eprint:1207.7214v2', 'eprint:1207.7214']]],
    ['ARXIV:1207.7214V2', 'ARXIV:1207.7214', [['ARXIV:1207.7214V2', 'ARXIV:1207.7214']]],
    ['arXiv:1207.7214v2', 'arXiv:1207.7214', [['arXiv:1207.7214v2', 'arXiv:1207.7214']]],
    [
      'eprint arXiv:1207.7214v2',
      'eprint arXiv:1207.7214',
      [['eprint arXiv:1207.7214v2', 'eprint arXiv:1207.7214']],
    ],
    [
      'eprint:arXiv:1207.7214v2',
      'eprint:arXiv:1207.7214',
      [['eprint:arXiv:1207.7214v2', 'eprint:arXiv:1207.7214']],
    ],
    ['arxiv:"1207.7214v2"', 'arxiv:"1207.7214"', [['arxiv:"1207.7214v2"', 'arxiv:"1207.7214"']]],
    ["arxiv:'1207.7214v2'", "arxiv:'1207.7214'", [["arxiv:'1207.7214v2'", "arxiv:'1207.7214'"]]],
    [
      'eprint "1207.7214v2"',
      'eprint "1207.7214"',
      [['eprint "1207.7214v2"', 'eprint "1207.7214"']],
    ],
    [
      'arxiv_eprints.value:1207.7214v2',
      'arxiv_eprints.value:1207.7214',
      [['arxiv_eprints.value:1207.7214v2', 'arxiv_eprints.value:1207.7214']],
    ],
    ['arxiv:2412.20242v1', 'arxiv:2412.20242', [['arxiv:2412.20242v1', 'arxiv:2412.20242']]],
    [
      'arxiv:hep-th/9711200v3',
      'arxiv:hep-th/9711200',
      [['arxiv:hep-th/9711200v3', 'arxiv:hep-th/9711200']],
    ],
    [
      'find eprint 1207.7214v2',
      'find eprint 1207.7214',
      [['eprint 1207.7214v2', 'eprint 1207.7214']],
    ],
    // a bare ID at a clause start: the whole query, the first clause, after ( and or not
    ['1207.7214v2', '1207.7214', [['1207.7214v2', '1207.7214']]],
    ['hep-th/9711200V3', 'hep-th/9711200', [['hep-th/9711200V3', 'hep-th/9711200']]],
    ['(1207.7214v2)', '(1207.7214)', [['1207.7214v2', '1207.7214']]],
    ['1207.7214v2 or recid:451647', '1207.7214 or recid:451647', [['1207.7214v2', '1207.7214']]],
    ['t higgs and 1207.7214v2', 't higgs and 1207.7214', [['1207.7214v2', '1207.7214']]],
    ['recid:451647 or 1207.7214v2', 'recid:451647 or 1207.7214', [['1207.7214v2', '1207.7214']]],
    ['t higgs and not 1207.7214v2', 't higgs and not 1207.7214', [['1207.7214v2', '1207.7214']]],
    // `not` alone after a finished clause opens the next one
    ['not 1207.7214v2', 'not 1207.7214', [['1207.7214v2', '1207.7214']]],
    ['higgs not 1207.7214v2', 'higgs not 1207.7214', [['1207.7214v2', '1207.7214']]],
    ['(cn atlas) not 1207.7214v2', '(cn atlas) not 1207.7214', [['1207.7214v2', '1207.7214']]],
    // a colon clause after another clause's words is ANDed on its own
    [
      't higgs arxiv:1207.7214v2',
      't higgs arxiv:1207.7214',
      [['arxiv:1207.7214v2', 'arxiv:1207.7214']],
    ],
    // groups, or lists, value negation, and line breaks
    [
      'recid:451647 or arxiv:1207.7214v2',
      'recid:451647 or arxiv:1207.7214',
      [['arxiv:1207.7214v2', 'arxiv:1207.7214']],
    ],
    [
      '((cn atlas and eprint 1207.7214v12) or not arxiv:hep-th/9711200V3)',
      '((cn atlas and eprint 1207.7214) or not arxiv:hep-th/9711200)',
      [
        ['eprint 1207.7214v12', 'eprint 1207.7214'],
        ['arxiv:hep-th/9711200V3', 'arxiv:hep-th/9711200'],
      ],
    ],
    [
      'arxiv:(1207.7214v2 or 1207.7235v1)',
      'arxiv:(1207.7214 or 1207.7235)',
      [
        ['1207.7214v2', '1207.7214'],
        ['1207.7235v1', '1207.7235'],
      ],
    ],
    [
      'arxiv: not 1207.7214v2',
      'arxiv: not 1207.7214',
      [['arxiv: not 1207.7214v2', 'arxiv: not 1207.7214']],
    ],
    [
      't higgs\r\nand\tarxiv:1207.7214v2\n',
      't higgs\r\nand\tarxiv:1207.7214\n',
      [['arxiv:1207.7214v2', 'arxiv:1207.7214']],
    ],
    [
      'a Witten and (arxiv:1207.7214v2 or doi:10.1016/S0370-2693(98)00377-3)',
      'a Witten and (arxiv:1207.7214 or doi:10.1016/S0370-2693(98)00377-3)',
      [['arxiv:1207.7214v2', 'arxiv:1207.7214']],
    ],
  ])('sends %j as %j', (query, sent, rewrites) => {
    expect(unversionArxivIds(query)).toEqual({
      query: sent,
      rewrites: rewrites.map(([written, as]) => ({ written, sent: as })),
    });
  });

  it.each([
    // unversioned IDs, recids
    'arxiv:1207.7214',
    'eprint 1207.7214',
    '1207.7214',
    'arxiv:hep-th/9711200',
    'recid:451647',
    '451647',
    // refersto and citedby select by recid; their arXiv values stay as written
    'refersto:arxiv:1207.7214v2',
    'citedby:arxiv:1207.7214v2',
    'refersto arxiv:1207.7214v2',
    'citedby: arxiv:1207.7214v2',
    'refersto:(arxiv:1207.7214v2 or arxiv:1207.7235v1)',
    'refersto:recid:1124337',
    // quoted phrases and the values of other fields
    't "arxiv:1207.7214v2"',
    't:"x arxiv:1207.7214v2"',
    '"1207.7214v2"',
    "'1207.7214v2'",
    't 1207.7214v2',
    't:1207.7214v2',
    't higgs 1207.7214v2',
    't eprint 1207.7214v2',
    't:(1207.7214v2 or arxiv:1207.7235v1)',
    'a: not 1207.7214v2',
    'higgs 1207.7214v2',
    // regex values, URLs, DOIs
    'arxiv:/1207\\.7214v2/',
    '/arxiv:1207.7214v2/',
    't /1207.7214v2/',
    'https://arxiv.org/abs/1207.7214v2',
    'arxiv.org/abs/1207.7214v2',
    'doi:10.48550/arXiv.1207.7214v2',
    '10.48550/arXiv.1207.7214v2',
    'doi:10.1234/x(1207.7214v2)',
    '10.1234/x(1207.7214v2)',
    // not a whole versioned ID
    'arxiv:1207.7214v',
    'arxiv:1207.7214v2x',
    'arxiv:1207.72v2',
    'arxiv:12077.214v2',
    // an unclosed quote runs to the end
    'arxiv:"1207.7214v2',
    't "unclosed and arxiv:1207.7214v2',
    '',
  ])('sends %j unchanged, with no rewrite', (query) => {
    expect(unversionArxivIds(query)).toEqual({ query, rewrites: [] });
  });

  it('only ever deletes version suffixes, reports exactly when it changes the query, and is idempotent', () => {
    const token = fc.constantFrom(
      'arxiv:',
      'arxiv',
      'eprint',
      'refersto:',
      't',
      'and',
      'or',
      'not',
      '1207.7214v2',
      'hep-th/9711200V3',
      '1207.7214',
      '"',
      "'",
      '/',
      '(',
      ')',
      ':',
      ' ',
      '\n',
      'x',
    );
    fc.assert(
      fc.property(
        fc.array(token, { maxLength: 24 }).map((tokens) => tokens.join('')),
        (query) => {
          const result = unversionArxivIds(query);
          const withoutVersions = (text: string) => text.replace(/[vV]\d+/g, '');
          expect(withoutVersions(result.query)).toBe(withoutVersions(query));
          expect(result.rewrites.length > 0).toBe(result.query !== query);
          expect(unversionArxivIds(result.query)).toEqual({ query: result.query, rewrites: [] });
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it.for([
    { shape: 'arxiv: openers with no value', unit: 'arxiv: ' },
    { shape: 'glued arxiv: openers', unit: 'arxiv:' },
    { shape: 'arxiv:" openers', unit: 'arxiv:"' },
    { shape: 'arxiv:/ regex openers', unit: 'arxiv:/' },
    { shape: 'versioned clauses', unit: 'arxiv:1207.7214v2 or ' },
    { shape: 'bare and operator IDs', unit: '1207.7214V2 and eprint hep-th/9711200v3 or ' },
    { shape: 'nested groups', unit: '(not ' },
    { shape: "another field's nested value", unit: '(', prefix: 't:' },
    { shape: 'an unclosed quote', unit: 'arxiv:1207.7214v2 ', prefix: 'arxiv:"' },
    { shape: 'a long arXiv-like value', unit: 'a', prefix: 'arxiv:' },
    { shape: 'a long digit run', unit: '1' },
    { shape: 'one long line ending in a break', unit: '§1 x', suffix: '\ny' },
    { shape: 'breaks throughout', unit: '  \r\n' },
    { shape: 'arxiv: before breaks', unit: 'arxiv:\r\n' },
  ])(
    'bounds $shape over a 64x span using thread CPU',
    // Synchronous CPU timing: vitest cannot interrupt it, so its wall-clock timeout guards nothing.
    { timeout: 0 },
    ({ unit, prefix = '', suffix = '' }) => {
      const input = (size: number) =>
        `${prefix}${unit.repeat(Math.ceil(size / unit.length))}${suffix}`;
      for (const size of [10_000, 20_000, 40_000, 80_000, 160_000, 320_000]) {
        const growth = measureGrowth(
          unversionArxivIds,
          { small: input(5_000), large: input(size) },
          { maxLargeMs: 100, maxRatio: 256 },
        );
        expect(growth.withinLimits, `${size}: ${growth.summary}`).toBe(true);
      }
    },
  );
});

describe('arxivVersionNotice', () => {
  it('is absent when nothing was rewritten', () => {
    expect(arxivVersionNotice([])).toBeUndefined();
  });

  it('names every rewritten clause as written and as sent, in query order', () => {
    expect(
      arxivVersionNotice([
        { written: 'arxiv:1207.7214v2', sent: 'arxiv:1207.7214' },
        { written: 'eprint\n1207.7235V1', sent: 'eprint\n1207.7235' },
      ]),
    ).toBe(
      'INSPIRE indexes arXiv IDs without a version suffix, so the suffix was removed: "arxiv:1207.7214v2" sent as "arxiv:1207.7214"; "eprint 1207.7235V1" sent as "eprint 1207.7235".',
    );
  });

  it('echoes the clause through callerEcho, so it cannot open a link or tag', () => {
    const notice = arxivVersionNotice([{ written: '<b>[x](y)', sent: '<b>[x](y)' }]) ?? '';
    expect(notice).not.toMatch(/<b>|\[x\]\(/);
  });
});
