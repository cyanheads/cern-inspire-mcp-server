/**
 * @fileoverview Conservative empty-field detection and CPU growth bounds.
 * @module tests/shared/query-fields.test
 */
import { describe, expect, it } from 'vitest';
import { hasEmptyQueryField } from '@/mcp-server/tools/inputs.js';
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
  ] as const)('bounds %s scanning over a 64x span using thread CPU', (shape) => {
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
  });
});
