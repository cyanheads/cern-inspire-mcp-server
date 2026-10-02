/**
 * @fileoverview Publisher markup in INSPIRE titles and abstracts → text.
 * INSPIRE stores many publisher titles and abstracts as HTML, JATS, or MathML,
 * and some entity-escaped. `markupToText()` keeps their text: scripts read
 * `_x` / `^{xy}`, prescripts precede their base, fractions read `a/b`, and
 * paragraphs are separated by a blank line. The whitespace removed markup leaves
 * collapses to one space, except that a formula's trimmed inner edge keeps one
 * only beside a letter or digit, and an HTML script binds to its neighbours
 * across a line break. A tag counts only when its local name (after any prefix)
 * is in a fixed HTML/JATS/MathML vocabulary and, unless it is void or
 * self-closing, its closing tag follows; a void element never pairs. Every
 * other `<` and `>` is prose, since comparisons and LaTeX are common in this
 * text. Entities decode once, after tags, so decoded text is never read as
 * markup; `containsMarkup()` tells whether that decode produced some. Every
 * pass — the scan, the tree build, the render, and the whitespace pass — is
 * iterative and linear in the input, unclosed and deeply nested markup included.
 * @module services/inspire/markup-to-text
 */

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/** How an element renders. */
type Kind =
  | 'block' // paragraph break around its content
  | 'inline' // content, collapsing the whitespace runs at its edges
  | 'formula' // inline, with the whitespace inside its edges trimmed
  | 'display' // a formula on its own line
  | 'label' // inline, followed by a space
  | 'row' // content as is (MathML rows and cells)
  | 'first' // only its first element child (the presentation form)
  | 'tex' // text kept as written
  | 'token' // text with whitespace collapsed and trimmed
  | 'mtext' // text with whitespace collapsed
  | 'drop' // removed with its content, leaving a collapsible space
  | 'empty' // renders nothing
  | 'br'
  | 'etal'
  | 'mspace'
  | 'sub'
  | 'sup'
  | 'msub'
  | 'msup'
  | 'msubsup'
  | 'mover'
  | 'mmultiscripts'
  | 'mfrac'
  | 'msqrt'
  | 'mroot'
  | 'mfenced'
  | 'mtable'
  | 'mtr';

const group = (kind: Kind, names: string) =>
  names.split(' ').map((name) => [name, kind] as [string, Kind]);

/** The recognized vocabulary, by local name. Names are case-sensitive, as in XML. */
const KINDS = new Map<string, Kind>([
  ...group('block', 'p div sec title list list-item'),
  ...group(
    'inline',
    'b em i small span strong u bold italic sc monospace roman sans-serif underline overline styled-content named-content ext-link uri xref mixed-citation element-citation person-group string-name surname given-names article-title source volume issue year fpage lpage page-range',
  ),
  ...group('formula', 'math inline-formula'),
  ...group('display', 'disp-formula'),
  ...group('label', 'label'),
  ...group('row', 'mrow mstyle merror mpadded menclose mtd'),
  ...group('first', 'semantics maction alternatives'),
  ...group('tex', 'tex-math'),
  ...group('token', 'mi mn mo ms'),
  ...group('mtext', 'mtext'),
  ...group('drop', 'annotation annotation-xml mphantom pub-id issn'),
  ...group('empty', 'none mprescripts malignmark maligngroup mglyph graphic inline-graphic'),
  ...group('br', 'br'),
  ...group('etal', 'etal'),
  ...group('mspace', 'mspace'),
  ...group('sub', 'sub'),
  ...group('sup', 'sup'),
  ...group('msub', 'msub munder'),
  ...group('msup', 'msup'),
  ...group('msubsup', 'msubsup munderover'),
  ...group('mover', 'mover'),
  ...group('mmultiscripts', 'mmultiscripts'),
  ...group('mfrac', 'mfrac'),
  ...group('msqrt', 'msqrt'),
  ...group('mroot', 'mroot'),
  ...group('mfenced', 'mfenced'),
  ...group('mtable', 'mtable'),
  ...group('mtr', 'mtr mlabeledtr'),
]);

/**
 * Elements read as empty. A start tag stands alone and is never paired, so what
 * follows it is its sibling, and an end tag closes nothing: `</br>`, which
 * sloppy HTML writes for a line break, is one, and any other is dropped.
 */
const VOID = new Set(
  'br none mprescripts mspace malignmark maligngroup mglyph graphic inline-graphic'.split(' '),
);

/** JATS `etal` may hold its own words, so it pairs like any element; left open, it is still markup. */
const OPTIONAL_CLOSE = 'etal';

/**
 * MathML elements other than tokens: whitespace-only text directly inside one
 * is layout, not content, and is dropped.
 */
const MATHML = new Set(
  'math mrow mstyle merror mpadded menclose mphantom mtd semantics maction msub munder msup msubsup munderover mover mmultiscripts mfrac msqrt mroot mfenced mtable mtr mlabeledtr'.split(
    ' ',
  ),
);

/** IEEE closes `<italic>`, `<bold>`, and `<sc>` with `</i>`, `</b>`, and `</small>`. */
const CLOSE_ALIASES = new Map([
  ['i', 'italic'],
  ['b', 'bold'],
  ['small', 'sc'],
]);

/**
 * Accents over a single character written in their spacing forms, as the
 * combining mark that puts them there. An accent written as a combining mark
 * (one `\p{Mn}` character) is its own mark.
 */
const ACCENTS = new Map([
  ['¯', '\u{304}'],
  ['‾', '\u{304}'],
  ['˜', '\u{303}'],
  ['~', '\u{303}'],
  ['^', '\u{302}'],
  ['ˆ', '\u{302}'],
  ['˙', '\u{307}'],
  ['¨', '\u{308}'],
  ['ˇ', '\u{30C}'],
  ['→', '\u{20D7}'],
]);

const COMBINING_MARK = /^\p{Mn}$/u;

/** Named entities that decode; any other name stays as written. */
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', '\u{A0}'],
  ['thinsp', '\u{2009}'],
  ['hyphen', '\u{2010}'],
  ['ndash', '–'],
  ['mdash', '—'],
  ['minus', '−'],
  ['plusmn', '±'],
  ['times', '×'],
]);

// ─── Entities ───────────────────────────────────────────────────────────────

const ENTITY = /&(?:#(\d{1,7})|#[xX]([\dA-Fa-f]{1,6})|([A-Za-z][A-Za-z\d]{0,31}));/g;

/**
 * True for a code point a numeric reference may produce: not a control
 * character, a surrogate, out of range, or a Unicode tag character (which the
 * service drops from every decoded string and must not come back here).
 */
const decodable = (code: number): boolean =>
  code > 0x1f &&
  !(code >= 0x7f && code <= 0x9f) &&
  !(code >= 0xd800 && code <= 0xdfff) &&
  !(code >= 0xe0000 && code <= 0xe007f) &&
  code <= 0x10ffff;

/** One pass over `text`: the output is never scanned again, so `&amp;lt;` becomes `&lt;`. */
function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(
    ENTITY,
    (whole, dec: string | undefined, hex: string | undefined, name: string | undefined) => {
      if (name !== undefined) return NAMED_ENTITIES.get(name) ?? whole;
      const code = dec === undefined ? Number.parseInt(hex ?? '', 16) : Number.parseInt(dec, 10);
      return decodable(code) ? String.fromCodePoint(code) : whole;
    },
  );
}

// ─── Scan ───────────────────────────────────────────────────────────────────

/**
 * Start and end tags. Attribute values must be quoted and nothing in a tag may
 * be `<`, so an attempt never reads past the next `<` and the scan stays linear.
 */
const START_TAG =
  /<([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?(?:[ \t\n\r]+[A-Za-z_][\w.:-]*[ \t\n\r]*=[ \t\n\r]*(?:"[^"<]*"|'[^'<]*'))*[ \t\n\r]*(\/?)>/y;
const END_TAG = /<\/([A-Za-z_][\w.-]*)(?::([A-Za-z_][\w.-]*))?[ \t\n\r]*>/y;
const PROCESSING_INSTRUCTION = /<\?[A-Za-z_][\w.:-]*(?:[ \t\n\r][^<]*?)?\?>/y;
const ATTRIBUTE = /([A-Za-z_][\w.:-]*)[ \t\n\r]*=[ \t\n\r]*(?:"([^"<]*)"|'([^'<]*)')/g;

/**
 * A raw text range (decoded at build), a CDATA section's content, the place a
 * comment, processing instruction, or void end tag was removed, or a recognized tag.
 */
type Token =
  | { kind: 'raw'; start: number; end: number }
  | { kind: 'cdata'; start: number; end: number }
  | { kind: 'gap'; start: number; end: number }
  | {
      kind: 'start' | 'end' | 'empty';
      start: number;
      end: number;
      name: string;
      local: string;
      /** The index of the matching tag; set when a start and end tag pair. */
      mate: number;
    };

type TagToken = Extract<Token, { name: string }>;

/** True when a scan recognized anything other than text. */
const hasMarkup = (tokens: readonly Token[]) => tokens.some((token) => token.kind !== 'raw');

/** The local name of a qualified name. */
const localOf = (prefix: string, second: string | undefined) => second ?? prefix;

/**
 * Tokenizes `s` and pairs its tags on a stack. A per-name count of open tags
 * answers "is there anything to close?" in O(1); a matched end tag pops the
 * tags opened after its partner, which become text (an `etal` stands alone), so
 * each tag is pushed and popped once. Void elements never go on the stack.
 * Comments and processing instructions are dropped; a comment or CDATA end is
 * found with one cached `indexOf`, so repeated unterminated openers cost linear
 * time in total.
 */
function scan(s: string): Token[] {
  const tokens: Token[] = [];
  const open: number[] = [];
  const openCount = new Map<string, number>();
  let textStart = 0;
  let i = 0;
  let commentEnd = -2;
  let cdataEnd = -2;

  const adjustCount = (name: string, by: number) =>
    openCount.set(name, (openCount.get(name) ?? 0) + by);
  const unwind = (index: number) => {
    const token = tokens[index] as TagToken;
    adjustCount(token.name, -1);
    if (token.local === OPTIONAL_CLOSE) token.kind = 'empty';
    else tokens[index] = { kind: 'raw', start: token.start, end: token.end };
  };
  const emit = (token: Token, at: number, next: number) => {
    if (at > textStart) tokens.push({ kind: 'raw', start: textStart, end: at });
    tokens.push(token);
    textStart = next;
  };
  const skip = (at: number, next: number) => emit({ kind: 'gap', start: at, end: next }, at, next);

  for (;;) {
    const lt = s.indexOf('<', i);
    if (lt === -1) break;
    i = lt + 1;
    const next = s.charCodeAt(lt + 1);

    if (next === 0x21 /* ! */) {
      if (s.startsWith('<!--', lt)) {
        if (commentEnd !== -1 && commentEnd < lt + 4) commentEnd = s.indexOf('-->', lt + 4);
        if (commentEnd !== -1) {
          skip(lt, commentEnd + 3);
          i = commentEnd + 3;
        }
      } else if (s.startsWith('<![CDATA[', lt)) {
        if (cdataEnd !== -1 && cdataEnd < lt + 9) cdataEnd = s.indexOf(']]>', lt + 9);
        if (cdataEnd !== -1) {
          emit({ kind: 'cdata', start: lt + 9, end: cdataEnd }, lt, cdataEnd + 3);
          i = cdataEnd + 3;
        }
      }
      continue;
    }

    if (next === 0x3f /* ? */) {
      PROCESSING_INSTRUCTION.lastIndex = lt;
      if (PROCESSING_INSTRUCTION.test(s)) {
        skip(lt, PROCESSING_INSTRUCTION.lastIndex);
        i = PROCESSING_INSTRUCTION.lastIndex;
      }
      continue;
    }

    if (next === 0x2f /* / */) {
      END_TAG.lastIndex = lt;
      const match = END_TAG.exec(s);
      if (!match) continue;
      const local = localOf(match[1] as string, match[2]);
      if (!KINDS.has(local)) continue;
      const name = match[2] === undefined ? local : `${match[1]}:${local}`;
      if (VOID.has(local)) {
        const end = END_TAG.lastIndex;
        if (local === 'br') emit({ kind: 'empty', start: lt, end, name, local, mate: -1 }, lt, end);
        else skip(lt, end);
        i = end;
        continue;
      }
      const alias = CLOSE_ALIASES.get(local);
      const aliasName =
        alias === undefined ? undefined : match[2] === undefined ? alias : `${match[1]}:${alias}`;
      const waiting =
        (openCount.get(name) ?? 0) +
        (aliasName === undefined ? 0 : (openCount.get(aliasName) ?? 0));
      if (waiting === 0) continue; // nothing to close: the end tag is prose
      const endIndex = tokens.length + (lt > textStart ? 1 : 0);
      for (;;) {
        const index = open.pop() as number;
        const token = tokens[index] as TagToken;
        if (token.name === name || token.name === aliasName) {
          adjustCount(token.name, -1);
          token.mate = endIndex;
          emit(
            { kind: 'end', start: lt, end: END_TAG.lastIndex, name, local, mate: index },
            lt,
            END_TAG.lastIndex,
          );
          break;
        }
        unwind(index);
      }
      i = END_TAG.lastIndex;
      continue;
    }

    START_TAG.lastIndex = lt;
    const match = START_TAG.exec(s);
    if (!match) continue;
    const local = localOf(match[1] as string, match[2]);
    if (!KINDS.has(local)) continue;
    const name = match[2] === undefined ? local : `${match[1]}:${local}`;
    const standsAlone = match[3] === '/' || VOID.has(local);
    const token: TagToken = {
      kind: standsAlone ? 'empty' : 'start',
      start: lt,
      end: START_TAG.lastIndex,
      name,
      local,
      mate: -1,
    };
    emit(token, lt, START_TAG.lastIndex);
    if (!standsAlone) {
      open.push(tokens.length - 1);
      adjustCount(name, 1);
    }
    i = START_TAG.lastIndex;
  }

  if (s.length > textStart) tokens.push({ kind: 'raw', start: textStart, end: s.length });
  for (let k = open.length - 1; k >= 0; k--) unwind(open[k] as number);
  return tokens;
}

// ─── Tree ───────────────────────────────────────────────────────────────────

interface Element {
  children: Child[];
  /** True for a paragraph inside a list item, which renders inline after its label. */
  inList: boolean;
  kind: Kind | 'root';
  local: string;
  /** The start tag's range in the source, read again only for attributes. */
  tag: { end: number; start: number };
  /** Collected text, for `tex`, `token`, and `mtext` elements. */
  text: string;
}

type Child = Element | string;

const XML_SPACE = /[ \t\n\r]+/g;
const LINE_BREAK = /[\n\r]/;

const isXmlSpace = (code: number) =>
  code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

function isBlank(text: string): boolean {
  for (let k = 0; k < text.length; k++) if (!isXmlSpace(text.charCodeAt(k))) return false;
  return true;
}

function element(kind: Kind | 'root', local: string, tag = { start: 0, end: 0 }): Element {
  return { kind, local, tag, children: [], inList: false, text: '' };
}

/**
 * The element tree, built in one pass. Text runs decode their entities on their
 * own, never across a removed tag; `tex`, token, and `mtext` elements collect
 * the text of their whole span; `drop` elements are skipped with their span,
 * leaving a gap, as removed comments and processing instructions do.
 */
function buildTree(s: string, tokens: readonly Token[]): Element {
  const root = element('root', '');
  const stack: Element[] = [root];

  /** Decoded text of the raw run starting at `from`, and the index after it. */
  const rawRun = (from: number): [string, number] => {
    const first = tokens[from] as Token;
    let end = first.end;
    let next = from + 1;
    for (let t = tokens[next]; t?.kind === 'raw' && t.start === end; t = tokens[++next])
      end = t.end;
    return [decodeEntities(s.slice(first.start, end)), next];
  };
  const collect = (from: number, to: number): string => {
    const parts: string[] = [];
    let k = from;
    while (k < to) {
      const token = tokens[k] as Token;
      if (token.kind === 'raw') {
        const [text, next] = rawRun(k);
        parts.push(text);
        k = next;
      } else {
        if (token.kind === 'cdata') parts.push(s.slice(token.start, token.end));
        k++;
      }
    }
    return parts.join('');
  };
  const addText = (parent: Element, text: string) => {
    if (text === '' || (MATHML.has(parent.local) && isBlank(text))) return;
    parent.children.push(text);
  };
  /**
   * A `drop` node where something was removed, so the whitespace around it
   * collapses; none among MathML's positional children, whose whitespace is
   * already layout, or where `first` picks its first element child.
   */
  const addGap = (parent: Element) => {
    if (!MATHML.has(parent.local) && parent.kind !== 'first') {
      parent.children.push(element('drop', ''));
    }
  };

  let k = 0;
  while (k < tokens.length) {
    const token = tokens[k] as Token;
    const top = stack[stack.length - 1] as Element;
    if (token.kind === 'raw') {
      const [text, next] = rawRun(k);
      addText(top, text);
      k = next;
      continue;
    }
    if (token.kind === 'cdata') {
      addText(top, s.slice(token.start, token.end));
      k++;
      continue;
    }
    if (token.kind === 'gap') {
      addGap(top);
      k++;
      continue;
    }
    if (token.kind === 'end') {
      stack.pop();
      k++;
      continue;
    }
    const kind = KINDS.get(token.local) as Kind;
    const last = token.kind === 'start' ? token.mate : k;
    if (kind === 'drop') {
      addGap(top);
      k = last + 1;
      continue;
    }
    const node = element(kind, token.local, { start: token.start, end: token.end });
    node.inList = token.local === 'p' && top.local === 'list-item';
    top.children.push(node);
    if (kind === 'tex' || kind === 'token' || kind === 'mtext') {
      node.text = collect(k + 1, last);
      k = last + 1;
      continue;
    }
    if (token.kind === 'start') stack.push(node);
    k++;
  }
  return root;
}

// ─── Render ─────────────────────────────────────────────────────────────────

/**
 * Whitespace markers between rendered pieces. `SOFT` collapses the whitespace
 * run it sits in to one space; `PARA` and `LINE` make the run a blank line or a
 * line break; `TRIM_OPEN` drops the whitespace after it in its run and
 * `TRIM_CLOSE` the whitespace before it. `EDGE_OPEN` and `EDGE_CLOSE` trim a
 * formula's edges the same way, except that trimmed whitespace leaves one space
 * when the text beyond the edge is a letter or digit: IEEE writes the space that
 * separates a formula from the next word inside `</tex-math>`. `BIND` sits
 * beside an HTML script: a run holding a line break is pretty-printing layout
 * and is dropped, so the script joins its base (`Nb\n  <sub>3</sub>\n  Sn` reads
 * `Nb_3Sn`), and any other run collapses to one space, since a prescript often
 * follows a written space (`of <sup>12</sup>C`). A run of whitespace with no
 * marker in it is kept as written.
 */
const SOFT = 0;
const PARA = 1;
const LINE = 2;
const TRIM_OPEN = 3;
const TRIM_CLOSE = 4;
const EDGE_OPEN = 5;
const EDGE_CLOSE = 6;
const BIND = 7;
type Marker = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type Item = Child | Marker;

/** Code points in `text` once XML whitespace is trimmed from both ends, capped at 2. */
function trimmedLength(text: string): 0 | 1 | 2 {
  let start = 0;
  let end = text.length;
  while (start < end && isXmlSpace(text.charCodeAt(start))) start++;
  while (end > start && isXmlSpace(text.charCodeAt(end - 1))) end--;
  const units = end - start;
  if (units === 0) return 0;
  if (units === 1) return 1;
  const high = text.charCodeAt(start);
  return units === 2 && high >= 0xd800 && high <= 0xdbff ? 1 : 2;
}

const collapse = (text: string) => text.replace(XML_SPACE, ' ');

function trimCollapse(text: string): string {
  const collapsed = collapse(text);
  const start = collapsed.startsWith(' ') ? 1 : 0;
  const end = collapsed.endsWith(' ') ? collapsed.length - 1 : collapsed.length;
  return start >= end ? '' : collapsed.slice(start, end);
}

const firstElement = (children: readonly Child[]) =>
  children.find((child) => typeof child !== 'string') ?? children[0];

/**
 * How many code points `item` renders to, capped at 2 — whether a script or a
 * fraction operand is one character. Walks rows and inline wrappers only; any
 * other structure counts as 2 at once, so each node is walked by at most one
 * enclosing operand.
 */
function measure(item: Child): 0 | 1 | 2 {
  let total = 0;
  const pending: Child[] = [item];
  while (pending.length > 0 && total < 2) {
    const next = pending.pop() as Child;
    if (typeof next === 'string') {
      total += trimmedLength(next);
      continue;
    }
    switch (next.kind) {
      case 'root':
      case 'block':
      case 'inline':
      case 'formula':
      case 'display':
      case 'label':
      case 'row':
        for (const child of next.children) pending.push(child);
        break;
      case 'first': {
        const first = firstElement(next.children);
        if (first !== undefined) pending.push(first);
        break;
      }
      case 'tex':
      case 'token':
      case 'mtext':
        total += trimmedLength(next.text);
        break;
      case 'empty':
      case 'br':
      case 'mspace':
      case 'drop':
        break;
      default:
        total = 2;
    }
  }
  return total >= 2 ? 2 : (total as 0 | 1);
}

/** The one character a one-character `item` renders to. */
function singleText(item: Child): string {
  const pending: Child[] = [item];
  while (pending.length > 0) {
    const next = pending.pop() as Child;
    if (typeof next === 'string') {
      if (trimmedLength(next) > 0) return trimCollapse(next);
    } else if (next.kind === 'tex' || next.kind === 'token' || next.kind === 'mtext') {
      if (trimmedLength(next.text) > 0) return trimCollapse(next.text);
    } else if (next.kind === 'first') {
      const first = firstElement(next.children);
      if (first !== undefined) pending.push(first);
    } else {
      for (const child of next.children) pending.push(child);
    }
  }
  return '';
}

/** A list of children as one operand. */
const asGroup = (children: Child[]): Element => ({ ...element('row', 'mrow'), children });

/** `_x` or `_{xy}` (likewise `^`); nothing for an empty or missing operand. */
function script(symbol: '_' | '^', operand: Child | undefined): Item[] {
  if (operand === undefined) return [];
  const size = measure(operand);
  if (size === 0) return [];
  return size === 1
    ? [symbol, TRIM_OPEN, operand, TRIM_CLOSE]
    : [symbol, '{', TRIM_OPEN, operand, TRIM_CLOSE, '}'];
}

/** An HTML script between `BIND` markers; nothing when the script is empty. */
const bound = (items: Item[]): Item[] => (items.length === 0 ? items : [BIND, ...items, BIND]);

/** An operand, parenthesized when it is longer than one character. */
function operand(item: Child | undefined): Item[] {
  if (item === undefined) return [];
  const size = measure(item);
  if (size === 0) return [];
  return size === 1 ? [TRIM_OPEN, item, TRIM_CLOSE] : ['(', TRIM_OPEN, item, TRIM_CLOSE, ')'];
}

const base = (item: Child | undefined): Item[] => (item === undefined ? [] : [item]);

/** A start tag's attribute, decoded. */
function attribute(s: string, node: Element, name: string): string | undefined {
  for (const match of s.slice(node.tag.start, node.tag.end).matchAll(ATTRIBUTE)) {
    if (match[1] === name) return decodeEntities(match[2] ?? match[3] ?? '');
  }
  return;
}

/** True when an `mspace` has a positive width (a named width unless it is a negative one). */
function hasWidth(s: string, node: Element): boolean {
  const width = attribute(s, node, 'width')?.trim();
  if (width === undefined || width === '') return false;
  const value = Number.parseFloat(width);
  return Number.isNaN(value) ? !width.startsWith('negative') : value > 0;
}

/** `open child sep child … close`, with MathML's defaults `(`, `)`, and `,`. */
function fenced(s: string, node: Element): Item[] {
  const separators = [...(attribute(s, node, 'separators') ?? ',').replace(XML_SPACE, '')];
  const items: Item[] = [attribute(s, node, 'open') ?? '('];
  for (const [index, child] of node.children.entries()) {
    if (index > 0 && separators.length > 0) {
      items.push(separators[Math.min(index - 1, separators.length - 1)] as string);
    }
    items.push(child);
  }
  items.push(attribute(s, node, 'close') ?? ')');
  return items;
}

/** Prescripts (after `<mprescripts/>`) first, then the base, then the postscripts. */
function multiscripts(children: readonly Child[]): Item[] {
  const [first, ...rest] = children;
  const pre: Item[] = [];
  const post: Item[] = [];
  let target = post;
  let position = 0;
  for (const child of rest) {
    if (typeof child !== 'string' && child.local === 'mprescripts') {
      target = pre;
      position = 0;
      continue;
    }
    for (const item of script(position % 2 === 0 ? '_' : '^', child)) target.push(item);
    position++;
  }
  return [...pre, ...base(first), ...post];
}

/** `x̄` for an accent over one character, as a combining mark; else `undefined`. */
function accented(over: Child | undefined, under: Child | undefined): Item[] | undefined {
  if (over === undefined || under === undefined) return;
  if (measure(over) !== 1 || measure(under) !== 1) return;
  const accent = singleText(over);
  const mark = ACCENTS.get(accent) ?? (COMBINING_MARK.test(accent) ? accent : undefined);
  return mark === undefined ? undefined : [`${singleText(under)}${mark}`];
}

/** The items one element renders to, in order. */
function expand(s: string, node: Element): Item[] {
  const children = node.children;
  const [first, second, third] = children;
  switch (node.kind) {
    case 'root':
    case 'row':
      return children;
    case 'block':
      return node.inList ? [SOFT, ...children, SOFT] : [PARA, ...children, PARA];
    case 'inline':
      return [SOFT, ...children, SOFT];
    case 'formula':
      return [SOFT, EDGE_OPEN, ...children, EDGE_CLOSE, SOFT];
    case 'display':
      return [LINE, EDGE_OPEN, ...children, EDGE_CLOSE, LINE];
    case 'label':
      return [SOFT, ...children, ' ', SOFT];
    case 'first':
      return base(firstElement(children));
    case 'tex':
      return [SOFT, EDGE_OPEN, node.text, EDGE_CLOSE, SOFT];
    case 'token':
      return [trimCollapse(node.text)];
    case 'mtext':
      return [SOFT, collapse(node.text), SOFT];
    case 'drop':
      return [SOFT];
    case 'empty':
      return [];
    case 'br':
      return [LINE];
    case 'etal':
      return [SOFT, ...(children.length > 0 ? children : [' et al.']), SOFT];
    case 'mspace':
      return hasWidth(s, node) ? [SOFT, ' ', SOFT] : [];
    case 'sub':
      return bound(script('_', asGroup(children)));
    case 'sup':
      return bound(script('^', asGroup(children)));
    case 'msub':
      return [...base(first), ...script('_', second)];
    case 'msup':
      return [...base(first), ...script('^', second)];
    case 'msubsup':
      return [...base(first), ...script('_', second), ...script('^', third)];
    case 'mover':
      return accented(second, first) ?? [...base(first), ...script('^', second)];
    case 'mmultiscripts':
      return multiscripts(children);
    case 'mfrac':
      return [...operand(first), '/', ...operand(second)];
    case 'msqrt':
      return ['√', ...operand(asGroup(children))];
    case 'mroot':
      return [
        '√',
        ...(second === undefined ? [] : (['[', TRIM_OPEN, second, TRIM_CLOSE, ']'] as Item[])),
        ...operand(first),
      ];
    case 'mfenced':
      return fenced(s, node);
    case 'mtable':
      return children.flatMap((row, index) => (index === 0 ? [row] : ['; ', row]));
    case 'mtr':
      return children.flatMap((cell, index) =>
        index === 0 ? [SOFT, cell, SOFT] : [' ', SOFT, cell, SOFT],
      );
  }
}

/** A letter or digit ending the text before a run or starting the text after it (each tested on two code units). */
const WORD_END = /[\p{L}\p{N}]$/u;
const WORD_START = /^[\p{L}\p{N}]/u;

/**
 * The text of one whitespace run between the rendered text `before` and `after`
 * it (`''` at either end of the string): kept as written with no marker in it,
 * else resolved.
 */
function resolveRun(run: readonly (string | Marker)[], before: string, after: string): string {
  let marked = false;
  let firstOpen = -1;
  let lastClose = -1;
  let firstEdgeOpen = -1;
  let lastEdgeClose = -1;
  let para = false;
  let line = false;
  let bind = false;
  for (const [index, item] of run.entries()) {
    if (typeof item === 'string') continue;
    marked = true;
    if (item === TRIM_OPEN || item === EDGE_OPEN) {
      if (firstOpen === -1) firstOpen = index;
      if (item === EDGE_OPEN && firstEdgeOpen === -1) firstEdgeOpen = index;
    } else if (item === TRIM_CLOSE || item === EDGE_CLOSE) {
      lastClose = index;
      if (item === EDGE_CLOSE) lastEdgeClose = index;
    } else if (item === PARA) para = true;
    else if (item === LINE) line = true;
    else if (item === BIND) bind = true;
  }
  if (!marked) return run.join('');
  if (before === '' || after === '') return '';
  if (para) return '\n\n';
  if (line) return '\n';
  const spaceWhere = (keep: (index: number) => boolean) =>
    run.some((item, index) => typeof item === 'string' && keep(index));
  if (bind && run.some((item) => typeof item === 'string' && LINE_BREAK.test(item))) return '';
  if (spaceWhere((index) => !(firstOpen !== -1 && index > firstOpen) && index > lastClose)) {
    return ' ';
  }
  const closedOnWord =
    lastEdgeClose !== -1 &&
    WORD_START.test(after.slice(0, 2)) &&
    spaceWhere((index) => index < lastEdgeClose);
  const openedOnWord =
    firstEdgeOpen !== -1 &&
    WORD_END.test(before.slice(-2)) &&
    spaceWhere((index) => index > firstEdgeOpen);
  return closedOnWord || openedOnWord ? ' ' : '';
}

/** Rendered pieces joined, each whitespace run resolved once; runs at either end of marked text are dropped. */
function joinPieces(pieces: readonly (string | Marker)[]): string {
  const out: string[] = [];
  let run: (string | Marker)[] = [];
  let before = '';
  for (const piece of pieces) {
    if (typeof piece === 'number') {
      run.push(piece);
      continue;
    }
    let start = 0;
    let end = piece.length;
    while (start < end && isXmlSpace(piece.charCodeAt(start))) start++;
    if (start === end) {
      if (end > 0) run.push(piece);
      continue;
    }
    while (isXmlSpace(piece.charCodeAt(end - 1))) end--;
    if (start > 0) run.push(piece.slice(0, start));
    const text = piece.slice(start, end);
    out.push(resolveRun(run, before, text), text);
    before = text;
    run = end < piece.length ? [piece.slice(end)] : [];
  }
  out.push(resolveRun(run, before, ''));
  return out.join('');
}

function render(s: string, root: Element): string {
  const pieces: (string | Marker)[] = [];
  const work: Item[] = [root];
  while (work.length > 0) {
    const item = work.pop() as Item;
    if (typeof item !== 'object') {
      pieces.push(item);
      continue;
    }
    const items = expand(s, item);
    for (let k = items.length - 1; k >= 0; k--) work.push(items[k] as Item);
  }
  return joinPieces(pieces);
}

// ─── Entry point ────────────────────────────────────────────────────────────

/**
 * `text` with recognized publisher markup converted to text and entities
 * decoded. A string with no recognized markup and no entity comes back
 * unchanged, byte for byte.
 */
export function markupToText(text: string): string {
  if (!text.includes('<')) return decodeEntities(text);
  const tokens = scan(text);
  return hasMarkup(tokens) ? render(text, buildTree(text, tokens)) : decodeEntities(text);
}

/**
 * True when `text` holds markup `markupToText()` would convert: a recognized tag
 * that pairs or stands alone, a comment, a processing instruction, or a CDATA
 * section. Converted text answers true when its one entity decode produced
 * markup: a CDS abstract stored as `&lt;p&gt;…&lt;/p&gt;` converts to `<p>…</p>`.
 */
export function containsMarkup(text: string): boolean {
  return text.includes('<') && hasMarkup(scan(text));
}
