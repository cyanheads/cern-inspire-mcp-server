/**
 * @fileoverview Markdown rendering for upstream-authored and caller-supplied text
 * in every tool's `format()`. INSPIRE and HEPData strings are data, never
 * markup: inline slots are flattened to one line with link, HTML, and control
 * characters neutralized; free text is blockquoted; citation entries are fenced.
 * `structuredContent` never passes through here and keeps strings verbatim.
 * @module mcp-server/tools/render
 */

/**
 * A regex character class from inclusive code-point ranges. Built numerically so
 * no invisible or line-separator character has to appear in this source file.
 */
const charClass = (ranges: readonly (readonly [number, number])[]): string =>
  `[${ranges.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`;

/**
 * Stripped everywhere: C0 controls except tab, LF, and CR; DEL; C1 controls
 * except NEL; and the bidi marks, embeddings, overrides, and isolates
 * (U+200E–200F, U+202A–202E, U+2066–2069).
 */
const STRIPPED = new RegExp(
  charClass([
    [0x00, 0x08],
    [0x0b, 0x0c],
    [0x0e, 0x1f],
    [0x7f, 0x84],
    [0x86, 0x9f],
    [0x200e, 0x200f],
    [0x202a, 0x202e],
    [0x2066, 0x2069],
  ]),
  'g',
);

/** Line breaks: CRLF, then CR, LF, NEL (U+0085), LINE SEPARATOR, PARAGRAPH SEPARATOR (U+2028–2029). */
const LINE_BREAK = new RegExp(
  `\\r\\n|${charClass([
    [0x0a, 0x0a],
    [0x0d, 0x0d],
    [0x85, 0x85],
    [0x2028, 0x2029],
  ])}`,
  'g',
);

/**
 * Backslash-escapes `chars`, doubling any backslash run directly before one so an
 * upstream backslash cannot cancel the escape (`\]` must not become `\\]`).
 */
function escapeWithBackslash(text: string, chars: string): string {
  const set = chars.replace(/[\\\]^-]/g, '\\$&');
  return text
    .replace(new RegExp(`\\\\+(?=[${set}])`, 'g'), (run) => run + run)
    .replace(new RegExp(`[${set}]`, 'g'), '\\$&');
}

/** Stripping and escaping shared by `inline()` and `quote()`; line breaks untouched. */
function neutralize(text: string): string {
  return escapeWithBackslash(text.replace(STRIPPED, '').replace(/\t/g, ' '), '[]')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Text for an inline slot — a heading, bold name, list item, or a value
 * interpolated into a sentence: line breaks become one space, control and bidi
 * characters are stripped, `[` `]` are escaped, `<` `>` become entities.
 */
export function inline(text: string): string {
  return neutralize(text.replace(LINE_BREAK, ' '));
}

/** Text for a markdown table cell: `inline()` plus `|` escaped (backslash runs before it doubled). */
export function cell(text: string): string {
  return escapeWithBackslash(inline(text), '|');
}

/** Free text (abstracts, descriptions) as a blockquote: `inline()` rules with line breaks kept. */
export function quote(text: string): string {
  return neutralize(text.replace(LINE_BREAK, '\n'))
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * A fenced code block — for verbatim citation entries. Control and bidi
 * characters are stripped; the fence is one backtick longer than the longest
 * backtick run in the text (minimum three).
 */
export function fenced(text: string, language: string): string {
  const body = text.replace(LINE_BREAK, '\n').replace(STRIPPED, '');
  const longestRun = Math.max(0, ...(body.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${body}\n${fence}`;
}

/**
 * A URL printed as text: controls stripped; `[` `]` `<` `>` `|`, whitespace, and
 * NEL (U+0085, a line break `\s` does not match) percent-encoded.
 */
export function printUrl(url: string): string {
  return url.replace(STRIPPED, '').replace(/[[\]<>|\s\u0085]/g, encodeURIComponent);
}
