/**
 * @fileoverview Tests for the shared markdown render module: `inline()` and
 * `cell()` flatten and neutralize upstream text, `quote()` blockquotes free text,
 * `fenced()` fences verbatim citation entries, and `printUrl()` makes a URL safe
 * to print. Upstream strings are data: a newline, a bracket, a pipe, a control
 * character, or a bidi override must never change the structure around it.
 * @module tests/shared/render.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cell, fenced, inline, printUrl, quote } from '@/mcp-server/tools/render.js';

const chr = String.fromCharCode;

/** A regex matching any character in the inclusive code-point ranges, built without literal control characters. */
const anyOf = (...ranges: [number, number][]) =>
  new RegExp(`[${ranges.map(([from, to]) => `${chr(from)}-${chr(to)}`).join('')}]`);

/** The controls and bidi marks every render function strips (tab, LF, CR, and NEL are handled separately). */
const STRIPPED = anyOf(
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x84],
  [0x86, 0x9f],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
);
const LINE_BREAK = anyOf([0x0a, 0x0a], [0x0d, 0x0d], [0x85, 0x85], [0x2028, 0x2029]);

const NUL = chr(0);
const ESC = chr(0x1b);
const DEL = chr(0x7f);
const NEL = chr(0x85);
const LS = chr(0x2028);
const PS = chr(0x2029);
const RLO = chr(0x202e);
const LRM = chr(0x200e);
const ISOLATE_OPEN = chr(0x2066);
const ISOLATE_CLOSE = chr(0x2069);

/** True when every `chars` occurrence in `text` is preceded by an odd number of backslashes. */
function allEscaped(text: string, chars: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (!chars.includes(text.charAt(i))) continue;
    let slashes = 0;
    while (text.charAt(i - 1 - slashes) === '\\') slashes++;
    if (slashes % 2 === 0) return false;
  }
  return true;
}

/** Splits a markdown table row on its unescaped pipes. */
const splitRow = (row: string) => row.split(/(?<!\\)(?:\\\\)*\|/);

/** Strings that mix ordinary text with every troublesome character class. */
const nasty = fc
  .array(
    fc.oneof(
      fc.constantFrom(
        '[',
        ']',
        '<',
        '>',
        '|',
        '\\',
        '`',
        '&',
        '\n',
        '\r',
        '\r\n',
        '\t',
        NUL,
        ESC,
        DEL,
        NEL,
        LS,
        PS,
        RLO,
        LRM,
        ISOLATE_OPEN,
        ISOLATE_CLOSE,
        ' ',
        '€',
        '𝒳',
      ),
      fc.string({ unit: 'binary', maxLength: 4 }),
    ),
    { maxLength: 12 },
  )
  .map((parts) => parts.join(''));

describe('inline', () => {
  it('leaves plain text untouched', () => {
    expect(inline('Observation of a new particle')).toBe('Observation of a new particle');
    expect(inline('')).toBe('');
  });

  it.each([
    ['LF', 'a\nb'],
    ['CR', 'a\rb'],
    ['CRLF', 'a\r\nb'],
    ['NEL', `a${NEL}b`],
    ['LINE SEPARATOR', `a${LS}b`],
    ['PARAGRAPH SEPARATOR', `a${PS}b`],
  ])('turns a %s into one space', (_name, text) => {
    expect(inline(text)).toBe('a b');
  });

  it('turns each line break in a run into its own space and CRLF into one', () => {
    expect(inline('a\n\nb')).toBe('a  b');
    expect(inline('a\r\n\r\nb')).toBe('a  b');
  });

  it('turns a tab into a space', () => {
    expect(inline('a\tb')).toBe('a b');
  });

  it.each([
    ['NUL', NUL],
    ['ESC', ESC],
    ['DEL', DEL],
    ['C1 control', chr(0x9b)],
    ['vertical tab', chr(0x0b)],
    ['form feed', chr(0x0c)],
    ['LRM', LRM],
    ['RLM', chr(0x200f)],
    ['RLO', RLO],
    ['LRE', chr(0x202a)],
    ['PDF', chr(0x202c)],
    ['isolate open', ISOLATE_OPEN],
    ['isolate close', ISOLATE_CLOSE],
  ])('strips a %s', (_name, control) => {
    expect(inline(`a${control}b`)).toBe('ab');
  });

  it('keeps a bidi override from reordering the text around it', () => {
    expect(inline(`safe${RLO}txt.exe`)).toBe('safetxt.exe');
  });

  it('escapes square brackets so upstream text cannot form a link', () => {
    expect(inline('[click](https://evil.example)')).toBe('\\[click\\](https://evil.example)');
    expect(inline('![img](x)')).toBe('!\\[img\\](x)');
  });

  it('entity-encodes angle brackets so upstream text cannot form HTML', () => {
    expect(inline('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(inline('<https://evil.example>')).toBe('&lt;https://evil.example&gt;');
  });

  it('does not escape pipes, ampersands, or LaTeX outside table cells', () => {
    expect(inline('|V_{cb}| & $\\sigma$')).toBe('|V_{cb}| & $\\sigma$');
  });

  it('doubles a backslash run before a bracket so it cannot cancel the escape', () => {
    expect(inline('a\\[b')).toBe('a\\\\\\[b');
    expect(inline('a\\\\]b')).toBe('a\\\\\\\\\\]b');
  });

  it('keeps a backslash that does not precede a bracket as is', () => {
    expect(inline('\\alpha_s')).toBe('\\alpha_s');
  });

  it('handles characters outside the BMP', () => {
    expect(inline('𝒳[𝒴]')).toBe('𝒳\\[𝒴\\]');
  });

  it('never emits a line break, a stripped character, an unescaped bracket, or a raw angle bracket', () => {
    fc.assert(
      fc.property(nasty, (text) => {
        const out = inline(text);
        expect(out).not.toMatch(LINE_BREAK);
        expect(out).not.toMatch(STRIPPED);
        expect(out).not.toContain('\t');
        expect(out).not.toMatch(/[<>]/);
        expect(allEscaped(out, '[]')).toBe(true);
      }),
      { numRuns: 1_500 },
    );
  });
});

describe('cell', () => {
  it('escapes pipes so an upstream |V_{cb}| cannot add a column', () => {
    expect(cell('Determination of |V_{cb}|')).toBe('Determination of \\|V_{cb}\\|');
  });

  it('applies the inline rules too', () => {
    expect(cell('a\nb [c] <d>')).toBe('a b \\[c\\] &lt;d&gt;');
  });

  it('doubles a backslash run before a pipe', () => {
    expect(cell('a\\|b')).toBe('a\\\\\\|b');
  });

  it('keeps a hostile cell inside its column', () => {
    const row = `| ${cell('x | y\nz | w')} | ${cell('second')} |`;

    expect(row).not.toContain('\n');
    expect(splitRow(row)).toEqual(['', ' x \\| y z \\| w ', ' second ', '']);
  });

  it('never splits a row, whatever the text', () => {
    fc.assert(
      fc.property(nasty, nasty, (a, b) => {
        const row = `| ${cell(a)} | ${cell(b)} |`;
        expect(row).not.toMatch(LINE_BREAK);
        expect(splitRow(row)).toHaveLength(4);
        expect(allEscaped(cell(a), '|[]')).toBe(true);
      }),
      { numRuns: 1_500 },
    );
  });
});

describe('quote', () => {
  it('prefixes every line with "> "', () => {
    expect(quote('first\nsecond')).toBe('> first\n> second');
  });

  it('writes a bare ">" for a blank line so the quote stays one block', () => {
    expect(quote('first\n\nsecond')).toBe('> first\n>\n> second');
    expect(quote('first\n   \nsecond')).toBe('> first\n>\n> second');
  });

  it('turns every kind of line break into a line of the quote', () => {
    expect(quote(`a\r\nb\rc${NEL}d${LS}e${PS}f`)).toBe('> a\n> b\n> c\n> d\n> e\n> f');
  });

  it('quotes the empty string as an empty quote line', () => {
    expect(quote('')).toBe('>');
  });

  it('keeps a trailing newline as a final empty quote line', () => {
    expect(quote('a\n')).toBe('> a\n>');
  });

  it('applies the inline escaping to every line', () => {
    expect(quote('see [1]\n<b>bold</b>')).toBe('> see \\[1\\]\n> &lt;b&gt;bold&lt;/b&gt;');
  });

  it('keeps a markdown heading, list, or fence in the text inside the quote', () => {
    expect(quote('# Heading\n- item\n```\ncode')).toBe('> # Heading\n> - item\n> ```\n> code');
  });

  it('strips control and bidi characters', () => {
    expect(quote(`a${NUL}b${RLO}c`)).toBe('> abc');
  });

  it('turns a tab into a space', () => {
    expect(quote('a\tb')).toBe('> a b');
  });

  it('puts every output line inside the quote, whatever the text', () => {
    fc.assert(
      fc.property(nasty, (text) => {
        const out = quote(text);
        expect(out).not.toContain('\r');
        expect(out).not.toMatch(STRIPPED);
        for (const line of out.split('\n')) {
          expect(line.startsWith('>')).toBe(true);
          expect(line.slice(1)).not.toMatch(/[<>]/);
          expect(allEscaped(line, '[]')).toBe(true);
        }
      }),
      { numRuns: 1_500 },
    );
  });
});

describe('fenced', () => {
  const longestRun = (text: string) =>
    Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));

  it('wraps verbatim text in a three-backtick fence tagged with the language', () => {
    expect(fenced('@article{Doe:2020xyz,\n  year = "2020"\n}', 'bibtex')).toBe(
      '```bibtex\n@article{Doe:2020xyz,\n  year = "2020"\n}\n```',
    );
  });

  it('uses a fence one backtick longer than the longest run in the text', () => {
    expect(fenced('a ``` b', 'latex')).toBe('````latex\na ``` b\n````');
    expect(fenced('`````', 'latex').startsWith('``````latex\n')).toBe(true);
  });

  it('keeps the minimum fence at three for text with fewer or no backticks', () => {
    expect(fenced('a ` b', 'bibtex').startsWith('```bibtex\n')).toBe(true);
    expect(fenced('a `` b', 'bibtex').startsWith('```bibtex\n')).toBe(true);
  });

  it('keeps tabs, LaTeX backslashes, brackets, pipes, and angle brackets verbatim', () => {
    const text = '\\bibitem{x}\n\t[1] |V_{cb}| <b>';
    expect(fenced(text, 'latex')).toBe(`\`\`\`latex\n${text}\n\`\`\``);
  });

  it('normalizes every line break to LF', () => {
    expect(fenced(`a\r\nb\rc${NEL}d${LS}e`, 'bibtex')).toBe('```bibtex\na\nb\nc\nd\ne\n```');
  });

  it('strips control and bidi characters', () => {
    expect(fenced(`a${NUL}b${RLO}c${ESC}d`, 'bibtex')).toBe('```bibtex\nabcd\n```');
  });

  it('fences the empty string', () => {
    expect(fenced('', 'bibtex')).toBe('```bibtex\n\n```');
  });

  it('cannot be closed early by the text it carries', () => {
    fc.assert(
      fc.property(nasty, (text) => {
        const out = fenced(text, 'bibtex');
        const lines = out.split('\n');
        const fence = lines[0]?.replace('bibtex', '') ?? '';
        expect(fence).toMatch(/^`{3,}$/);
        expect(lines.at(-1)).toBe(fence);
        const body = lines.slice(1, -1).join('\n');
        expect(longestRun(body)).toBeLessThan(fence.length);
        expect(out).not.toContain('\r');
        expect(out).not.toMatch(STRIPPED);
      }),
      { numRuns: 1_500 },
    );
  });
});

describe('printUrl', () => {
  it('leaves an ordinary URL alone', () => {
    const url = 'https://inspirehep.net/literature/1124337?ui-citation-summary=true#abstract';
    expect(printUrl(url)).toBe(url);
  });

  it.each([
    ['[', '%5B'],
    [']', '%5D'],
    ['<', '%3C'],
    ['>', '%3E'],
    ['|', '%7C'],
    [' ', '%20'],
    ['\n', '%0A'],
    ['\t', '%09'],
  ])('percent-encodes %j as %s', (char, encoded) => {
    expect(printUrl(`https://example.org/a${char}b`)).toBe(`https://example.org/a${encoded}b`);
  });

  it('strips control and bidi characters before encoding', () => {
    expect(printUrl(`https://example.org/${NUL}a${RLO}b${ESC}`)).toBe('https://example.org/ab');
  });

  it('encodes the characters that would break a markdown link', () => {
    expect(printUrl('https://example.org/x](javascript:alert(1))[')).toBe(
      'https://example.org/x%5D(javascript:alert(1))%5B',
    );
  });

  it('never emits whitespace, brackets, angle brackets, pipes, or stripped characters', () => {
    fc.assert(
      fc.property(nasty, (text) => {
        const out = printUrl(text);
        expect(out).not.toMatch(STRIPPED);
        expect(out).not.toMatch(/[[\]<>|\s]/);
      }),
      { numRuns: 1_500 },
    );
  });

  it('does not print a NEL (U+0085) line break raw, as inline() does not', () => {
    expect(printUrl(`https://example.org/a${NEL}b`)).not.toMatch(LINE_BREAK);
  });
});
