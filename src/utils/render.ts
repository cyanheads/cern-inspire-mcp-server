/**
 * @fileoverview Markdown rendering for upstream-authored and caller-supplied text
 * in every tool's `format()`. INSPIRE and HEPData strings are data, never
 * markup: inline slots are flattened to one line with link, emphasis,
 * strikethrough, HTML, control, and invisible format characters neutralized;
 * text that opens a line or list item cannot open a block; free text is
 * blockquoted; citation entries are fenced. A caller's own text echoed in a
 * notice or error message goes through `callerEcho()`, and an identifier value
 * (DOI, texkey, BAI, …) through `identifier()`; both leave `*`, `_`, `~`, `>`,
 * and a `<` that opens no markup as written so the text copies back. The domain
 * fields of `structuredContent` never pass through here: they hold what the
 * service normalized (titles and abstracts converted from publisher markup to
 * text, other strings as decoded).
 * The service also uses `inline()` for upstream text it puts in an error message.
 * @module utils/render
 */

/**
 * A regex character class from inclusive code-point ranges. Built numerically so
 * no invisible or line-separator character has to appear in this source file.
 */
const charClass = (ranges: readonly (readonly [number, number])[]): string =>
  `[${ranges.map(([from, to]) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`).join('')}]`;

/**
 * Stripped everywhere: C0 controls except tab, LF, and CR; DEL; C1 controls
 * except NEL; and every format character (`\p{Cf}`: bidi marks, embeddings,
 * overrides, and isolates, zero-width spaces, the word joiner and invisible
 * operators, the byte-order mark, soft hyphens, tag characters) except ZWNJ and
 * ZWJ (U+200C–200D), which Persian, Arabic, and Indic names need.
 */
const STRIPPED = new RegExp(
  `${charClass([
    [0x00, 0x08],
    [0x0b, 0x0c],
    [0x0e, 0x1f],
    [0x7f, 0x84],
    [0x86, 0x9f],
  ])}|(?![\\u{200C}\\u{200D}])\\p{Cf}`,
  'gu',
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

/** A letter, digit, or combining mark: an underscore between two of them cannot delimit emphasis. */
const WORD = '[\\p{L}\\p{N}\\p{M}]';

/** `[` and `]`, which could form a link: all that `callerEcho()` and `identifier()` escape. */
const LINK_ESCAPES = '[[\\]]';

/**
 * A `<` CommonMark could read as the start of markup: an HTML tag, comment,
 * declaration, or processing instruction (`<` before a letter, `/`, `!`, or `?`),
 * a URI autolink (its scheme opens with a letter), or an email autolink (an
 * address's local part, then `@`). Any other `<` (`date<2015`, `0.8<|eta|`) and
 * every `>` are inert once no markup can open.
 */
const MARKUP_OPENER = /<(?=[A-Za-z/!?]|[\w.!#$%&'*+/=?^`{|}~-]+@)/g;

/**
 * What `inline()` and `quote()` escape: `[` `]`, which could form a link; `*`,
 * which can open or close emphasis anywhere; `~`, which pairs into a GFM
 * strikethrough (LaTeX's `Fig.~1` spacing, a `~10 Hz` approximation); and `_`
 * unless it sits between two word characters, so intraword `p_T` stays as
 * written while LaTeX's `$_{3}$` and converted `^{*0}` cannot pair into emphasis.
 */
const TEXT_ESCAPES = `[[\\]*~]|(?<!${WORD})_|_(?!${WORD})`;

/**
 * Backslash-escapes each match of `escapable` (a regex source for one
 * character), doubling any backslash run directly before one so an upstream
 * backslash cannot cancel the escape (`\]` must not become `\\]`). One pass that
 * consumes each backslash run whole, so a long run costs linear time.
 */
function escapeWithBackslash(text: string, escapable: string): string {
  return text.replace(
    new RegExp(`(\\\\+)(${escapable})?|${escapable}`, 'gu'),
    (match, run: string | undefined, char: string | undefined) => {
      if (run === undefined) return `\\${match}`;
      return char === undefined ? run : `${run}${run}\\${char}`;
    },
  );
}

/** Control and format characters stripped, tabs made spaces, then `escapable` backslash-escaped. */
const escaped = (text: string, escapable: string): string =>
  escapeWithBackslash(text.replace(STRIPPED, '').replace(/\t/g, ' '), escapable);

/** Stripping and escaping shared by every inline and quoted slot; line breaks untouched. */
function neutralize(text: string): string {
  return escaped(text, TEXT_ESCAPES).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Text for an inline slot — a heading, bold name, list item, or a value
 * interpolated into a sentence: line breaks become one space, control and format
 * characters are stripped, `[` `]` `*` `~` and any `_` outside a word are
 * escaped, `<` `>` become entities.
 */
export function inline(text: string): string {
  return neutralize(text.replace(LINE_BREAK, ' '));
}

/**
 * A caller's own query, author, or paper identifier echoed in a notice or error
 * message. Those strings ride `structuredContent` as well as `content[]`, and a
 * caller may send the echo back as its next query, so INSPIRE's `*` wildcard,
 * `_`, `~`, and the `>` of `date > 2015` or `P P --> TOP TOPBAR X` are left as
 * written. Line breaks become one space, control and format characters are
 * stripped, `[` `]` are escaped, and a `<` that could open a tag, comment, or
 * autolink becomes `&lt;` (`date < 2015` stays), so the echo still cannot form a
 * link or HTML in `content[]`.
 */
export function callerEcho(text: string): string {
  return escaped(text.replace(LINE_BREAK, ' '), LINK_ESCAPES).replace(MARKUP_OPENER, '&lt;');
}

/**
 * An identifier value a caller copies out of `content[]` into a query, a
 * citation, or a URL: a DOI or HEPData record DOI, a report number, a texkey,
 * an arXiv ID, a BAI, an ORCID, an INSPIRE ID, or a profile's other IDs
 * (`John_Ellis_(physicist,_born_1946)`). The same rules as `callerEcho()`: `*`,
 * `_`, `~`, and `>` stay as written, since an escape would be copied with the
 * value (a SICI DOI's `<1::AID-JBM1>` included); `[` `]` are escaped and a `<`
 * that could open markup becomes `&lt;`. Titles, abstracts, names, and keywords
 * are prose and go through `inline()`.
 */
export function identifier(text: string): string {
  return callerEcho(text);
}

/** Text for a markdown table cell: `inline()` plus `|` escaped (backslash runs before it doubled). */
export function cell(text: string): string {
  return escapeWithBackslash(inline(text), '\\|');
}

/** Free text (abstracts, descriptions) as a blockquote: `inline()` rules with line breaks kept. */
export function quote(text: string): string {
  return neutralize(text.replace(LINE_BREAK, '\n'))
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/**
 * A fenced code block — for verbatim citation entries. Control and format
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
 * A URL printed as text: control and format characters stripped; `[` `]` `<`
 * `>` `|`, whitespace, and NEL (U+0085, a line break `\s` does not match)
 * percent-encoded.
 */
export function printUrl(url: string): string {
  return url.replace(STRIPPED, '').replace(/[[\]<>|\s\u0085]/g, encodeURIComponent);
}

/**
 * A block marker a markdown line can open with once its indentation is gone: an
 * ATX heading, a bullet, a code fence, or a thematic break or setext underline.
 * A backslash before its first character keeps the line a paragraph.
 */
const BLOCK_MARKER = /^(?:#{1,6}(?= |$)|[-+*](?= |$)|`{3}|~{3}|([-*_=])(?: *\1)* *$)/;

/** An ordered-list marker; its `.` or `)` takes the backslash, since `\1` is no escape. */
const ORDERED_MARKER = /^(\d{1,9})([.)])(?= |$)/;

/**
 * Rendered inline text (`inline()` or `printUrl()` output) placed at the start
 * of a line or list item: leading spaces removed, since four would open a code
 * block, and a leading block marker escaped, so upstream text cannot open a
 * heading, list, fence, or rule there. Text inside it is left as it is.
 */
export function atLineStart(markdown: string): string {
  const text = markdown.replace(/^ +/, '');
  return BLOCK_MARKER.test(text) ? `\\${text}` : text.replace(ORDERED_MARKER, '$1\\$2');
}
