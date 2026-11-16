/**
 * @fileoverview Input schemas and helpers shared across the INSPIRE tools: the
 * blank-as-unset wrapper for form clients, the paging window and past-the-end
 * notice, the query scanners (the empty-field guard and the arXiv version-suffix
 * rewrite with its notice), the `paper` identifier input and the route from a
 * HEPData record to its paper, the facet enum arrays (comma-joined or array,
 * case-folded), the year bounds, the author-identifier inputs, and the
 * applied-filters echo string.
 * @module mcp-server/tools/inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  hepdataRecordNumber,
  normalizeAuthorId,
  normalizePaperId,
  PAPER_ID_PATTERN,
  stripArxivVersion,
} from '@/services/inspire/identifiers.js';
import type { FacetFilters } from '@/services/inspire/types.js';
import { DOCUMENT_TYPES, SUBJECTS } from '@/services/inspire/vocabulary.js';
import { callerEcho } from '@/utils/render.js';

/**
 * Treats `''` as unset before `schema` runs, so a form client's blank optional
 * field (enums with a default included) takes the default instead of failing.
 */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

/** INSPIRE serves at most this many results of one query (`page × size`). */
export const RESULT_WINDOW = 10_000;

/** The notice for a page that holds nothing although the query matched `total` records. */
export const pastLastPageNotice = (page: number, total: number, size: number): string =>
  `Page ${page} is past the last page (${Math.ceil(total / size)}); request a lower page.`;

/** The next-page notice; it names the page-size parameter and its value, since the next call must repeat the size to keep the page boundaries. */
export const moreResultsNotice = (
  nextPage: number,
  param: 'limit' | 'size',
  value: number,
): string => `More results: request page ${nextPage} with ${param} ${value}.`;

/** Known aliases from INSPIRE's query-parser keyword tables, not arbitrary metadata paths. */
const QUERY_FIELDS = new Set(
  (
    'abstract address affiliation affil aff af institution inst affid affiliation-id author au a name ' +
    'author-count authorcount ac cat caption cite c reference citedby citedbyexcludingselfcites citedbyx ' +
    'citedexcludingselfcites cx collaboration cn cnum control_number recid country cc doi bb bull eprint arxiv ' +
    'exact-author exactauthor ea experiment exp fc field-code first-author firstauthor fa fulltext ft irn ' +
    'coden journal j published_in volume vol keyword keywords kw k primarch rawref citation jour-vol-page jvp ' +
    'refersto referstoexcludingselfcites referstox reportnumber report-num report rept rn r subject title ti t ' +
    'texkey cited topcit topcite type-code type tc ty scl ps collection date d year date-added dadd da ' +
    'date-earliest de date-updated dupd du journal-year jy'
  ).split(' '),
);

/**
 * Finds an empty standalone recognized `field:` clause, including empty quoted values, ignoring nonempty quoted and regex values
 * and embedded selectors. This is a linear scan, not a complete query parser:
 * value negation, groups, unknown fields and nested colon values pass through.
 */
export function hasEmptyQueryField(query: string): boolean {
  const tokens: string[] = [];
  let start = 0;
  let firstColon = -1;
  for (let i = 0; i < query.length; i++) {
    const char = query.charAt(i);
    if (char === '"' || char === "'" || (char === '/' && (i === start || query[i - 1] === ':'))) {
      const quote = char;
      for (i++; i < query.length; i++) {
        if (query[i] === '\\') i++;
        else if (query[i] === quote) break;
      }
    } else if (char === '(' || char === ')' || /\s/.test(char)) {
      // A nonempty colon-bearing token (DOI, URL, nested selector) is opaque.
      if ((char === '(' || char === ')') && firstColon >= start && firstColon < i - 1) continue;
      if (start < i) tokens.push(query.slice(start, i).toLowerCase());
      if (char === '(' || char === ')') tokens.push(char);
      start = i + 1;
    } else if (char === ':' && firstColon < start) {
      firstColon = i;
    }
  }
  if (start < query.length) tokens.push(query.slice(start).toLowerCase());
  const emptyQuoted = (value: string) =>
    (value[0] === '"' || value[0] === "'") &&
    value.length >= 2 &&
    value.at(-1) === value[0] &&
    value.slice(1, -1).trim() === '';
  for (const [i, token] of tokens.entries()) {
    const colon = token.indexOf(':');
    if (colon < 0 || !QUERY_FIELDS.has(token.slice(0, colon))) continue;
    const value = token.slice(colon + 1);
    if (value !== '') {
      if (emptyQuoted(value)) return true;
      continue;
    }
    let next = i + 1;
    while (tokens[next] === '(' || tokens[next] === 'not') next++;
    if (
      next === tokens.length ||
      tokens[next] === ')' ||
      tokens[next] === 'and' ||
      tokens[next] === 'or' ||
      emptyQuoted(tokens[next] ?? '')
    )
      return true;
  }
  return false;
}

/** The fields whose value is an arXiv ID: `arxiv:`, `eprint:`, and the metadata path INSPIRE stores it under. */
const ARXIV_FIELDS = new Set(['arxiv', 'eprint', 'arxiv_eprints.value']);

/** The short operators that take an arXiv ID after a space (`eprint 1207.7214`). */
const ARXIV_OPERATORS = new Set(['arxiv', 'eprint']);

/** One arXiv clause sent without its version suffix: the clause as the caller wrote it and as sent. */
interface ArxivVersionRewrite {
  sent: string;
  written: string;
}

/** What the scan expects next: a new clause, an arXiv value, another field's value, or neither. */
type Expecting = 'clause' | 'arxivValue' | 'otherValue' | 'none';

const isSpace = (char: string) => /\s/.test(char);

/**
 * Removes the version suffix (`v2` or `V2`) from every arXiv ID a literature query
 * gives as an arXiv clause value, since INSPIRE indexes arXiv IDs without one:
 * `arxiv:ID`, `eprint:ID`, and `arxiv_eprints.value:ID` (quoted, `arXiv:`-prefixed,
 * or after a space), `arxiv ID` and `eprint ID` at a clause start, and a bare ID at
 * a clause start (the query start, or after `(`, `and`, `or`, `not`). The values of
 * other fields stay as written: `refersto:` and `citedby:` (which select by recid),
 * title words, and a group given as a field's value; so do quoted phrases, regex
 * values, URLs, and DOIs. One pass over quote- and regex-aware tokens, not a parser.
 */
export function unversionArxivIds(query: string): {
  query: string;
  rewrites: ArxivVersionRewrite[];
} {
  const edits: {
    clauseStart: number;
    clauseEnd: number;
    id: string;
    start: number;
    end: number;
  }[] = [];
  let expecting: Expecting = 'clause';
  let operatorStart = 0;
  let skipDepth = 0;
  let first = true;

  /** Strips the ID in `[start, end)`: exactly, or (as a clause value) also quoted or `arXiv:`-prefixed. */
  const rewrite = (clauseStart: number, start: number, end: number, asValue: boolean) => {
    let idStart = start;
    let idEnd = end;
    if (asValue) {
      const quote = query[start];
      if ((quote === '"' || quote === "'") && end - start >= 2 && query[end - 1] === quote) {
        idStart++;
        idEnd--;
      } else if (query.slice(start, start + 6).toLowerCase() === 'arxiv:') {
        idStart += 6;
      }
    }
    const written = query.slice(idStart, idEnd);
    const id = stripArxivVersion(written);
    if (id !== written) edits.push({ clauseStart, clauseEnd: end, id, start: idStart, end: idEnd });
  };

  /** Advances the clause state over one token; `colon` is its first colon outside quotes, or -1. */
  const step = (start: number, end: number, colon: number) => {
    const text = query.slice(start, end);
    const isFirst = first;
    first = false;
    if (skipDepth > 0) {
      if (text === '(') skipDepth++;
      else if (text === ')' && --skipDepth === 0) expecting = 'none';
      return;
    }
    if (text === '(') {
      // A group given as another field's value (`t:(…)`, `refersto:(…)`) is skipped whole.
      if (expecting === 'otherValue') skipDepth = 1;
      else {
        const before = query.charAt(start - 1);
        const opens = start === 0 || before === '(' || isSpace(before);
        expecting = expecting === 'arxivValue' || opens ? 'clause' : 'none';
      }
      return;
    }
    if (text === ')') {
      expecting = 'none';
      return;
    }
    const word = text.toLowerCase();
    if (word === 'and' || word === 'or' || word === 'not') {
      // `not` after a field negates its value (`a: not Witten`); otherwise a clause follows.
      if (word !== 'not' || expecting === 'clause' || expecting === 'none') expecting = 'clause';
      return;
    }
    if (colon >= 0) {
      const field = query.slice(start, colon).toLowerCase();
      if (expecting === 'otherValue') expecting = 'none';
      else if (colon + 1 === end) {
        operatorStart = start;
        expecting = ARXIV_FIELDS.has(field) ? 'arxivValue' : 'otherValue';
      } else {
        if (ARXIV_FIELDS.has(field)) {
          rewrite(expecting === 'arxivValue' ? operatorStart : start, colon + 1, end, true);
        }
        expecting = 'none';
      }
      return;
    }
    if (expecting === 'arxivValue') {
      rewrite(operatorStart, start, end, true);
      expecting = 'none';
    } else if (expecting === 'otherValue') {
      expecting = 'none';
    } else if (expecting === 'none') {
      if (QUERY_FIELDS.has(word)) expecting = 'otherValue';
    } else if (ARXIV_OPERATORS.has(word)) {
      operatorStart = start;
      expecting = 'arxivValue';
    } else if (isFirst && (word === 'find' || word === 'f')) {
      // SPIRES-style `find eprint …`: the clause follows.
    } else if (QUERY_FIELDS.has(word)) {
      expecting = 'otherValue';
    } else {
      rewrite(start, start, end, false);
      expecting = 'none';
    }
  };

  let i = 0;
  while (i < query.length) {
    const char = query.charAt(i);
    if (isSpace(char)) {
      i++;
      continue;
    }
    if (char === '(' || char === ')') {
      step(i, i + 1, -1);
      i++;
      continue;
    }
    const start = i;
    let colon = -1;
    while (i < query.length) {
      const c = query.charAt(i);
      if (c === '(' || c === ')' || isSpace(c)) break;
      if (c === '"' || c === "'" || (c === '/' && (i === start || query[i - 1] === ':'))) {
        for (i++; i < query.length && query[i] !== c; i++) {
          if (query[i] === '\\') i++;
        }
        i++;
      } else {
        if (c === ':' && colon < 0) colon = i;
        i++;
      }
    }
    i = Math.min(i, query.length);
    step(start, i, colon);
  }

  if (edits.length === 0) return { query, rewrites: [] };
  const parts: string[] = [];
  let last = 0;
  for (const edit of edits) {
    parts.push(query.slice(last, edit.start), edit.id);
    last = edit.end;
  }
  parts.push(query.slice(last));
  return {
    query: parts.join(''),
    rewrites: edits.map((edit) => ({
      written: query.slice(edit.clauseStart, edit.clauseEnd),
      sent: `${query.slice(edit.clauseStart, edit.start)}${edit.id}${query.slice(edit.end, edit.clauseEnd)}`,
    })),
  };
}

/** The notice naming each clause `unversionArxivIds` rewrote, as written and as sent; `undefined` for none. */
export function arxivVersionNotice(rewrites: readonly ArxivVersionRewrite[]): string | undefined {
  if (rewrites.length === 0) return;
  const pairs = rewrites.map(
    ({ written, sent }) => `"${callerEcho(written)}" sent as "${callerEcho(sent)}"`,
  );
  return `INSPIRE indexes arXiv IDs without a version suffix, so the suffix was removed: ${pairs.join('; ')}.`;
}

/**
 * The call that leads from HEPData record `n` to its paper: the HEPData search
 * matches the record DOI and returns the record's paper recids.
 */
export const hepdataRecordRoute = (n: string) =>
  `call cern_inspire_search_hepdata with query dois.value:"10.17182/hepdata.${n}" and pass one of the record's paperRecids to cern_inspire_get_paper`;

/** The pattern refinement's message: the HEPData route for a numbered record link, else the accepted forms. */
const paperIdError = (value: unknown) => {
  const record = typeof value === 'string' ? hepdataRecordNumber(value) : undefined;
  return record
    ? `A hepdata.net/record/${record} link names HEPData record ${record}, not a paper: ${hepdataRecordRoute(record)}.`
    : 'Expected an INSPIRE recid (451647), an arXiv ID (1207.7214 or hep-th/9711200), or a DOI (10.1016/…).';
};

/**
 * One paper identifier, normalized before the length and pattern checks (see
 * `normalizePaperId`): recid, new or old arXiv ID, or DOI, at most 256 characters.
 * The pattern runs as a refinement, so the advertised JSON Schema carries no
 * `pattern` that would reject the prefixed and URL spellings the preprocess maps.
 */
export const paperInput = z
  .preprocess(
    (value) => (typeof value === 'string' ? normalizePaperId(value) : value),
    z
      .string()
      .max(256)
      .refine((id) => PAPER_ID_PATTERN.test(id), { error: (issue) => paperIdError(issue.input) }),
  )
  .describe(
    "INSPIRE recid (e.g. 451647), arXiv ID (1207.7214 or hep-th/9711200, with or without 'arXiv:', a version suffix, or an https://arxiv.org/abs/ or https://arxiv.org/pdf/ prefix), DOI (10.1016/…, with or without 'doi:' or an https://doi.org/ prefix; no * or ? wildcards), an https://inspirehep.net/literature/<recid> URL, or HEPData's ins<recid> form, alone or in an https://www.hepdata.net/record/ins<recid> URL. Up to 256 characters.",
  );

/**
 * An optional array of enum values that also accepts a comma-joined string.
 * `''` and `[]` are unset; each entry is trimmed, case-folded to the canonical
 * spelling (a fixed lookup over the enum), de-duplicated, and the list is cut to
 * `max + 1` so an oversized list fails with one bounded issue.
 */
function enumArray<const T extends readonly [string, ...string[]]>(
  values: T,
  max: number,
  itemDescription: string,
) {
  const canonical = new Map(values.map((value) => [value.toLowerCase(), value]));
  return z.preprocess((value) => {
    if (value === '' || (Array.isArray(value) && value.length === 0)) return;
    const list: unknown = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(list)) return value;
    const folded = list
      .map((item) => {
        if (typeof item !== 'string') return item;
        const trimmed = item.trim();
        return canonical.get(trimmed.toLowerCase()) ?? trimmed;
      })
      .filter((item) => item !== '');
    return folded.length === 0 ? undefined : [...new Set(folded)].slice(0, max + 1);
  }, z.array(z.enum(values).describe(itemDescription)).max(max).optional());
}

/**
 * Up to 4 INSPIRE document types; multiple values AND together upstream. The
 * description documents the advertised enum array only; the comma-joined string
 * and case folding stay undocumented leniency.
 */
export const documentTypesInput = enumArray(
  DOCUMENT_TYPES,
  4,
  'An INSPIRE document type.',
).describe(
  `Restrict to INSPIRE document types (up to 4). Multiple values must ALL hold (published + review = published reviews), not either. Values: ${DOCUMENT_TYPES.join(', ')}.`,
);

/** Up to 4 INSPIRE subject categories; multiple values AND together upstream. Documented as `documentTypesInput` is. */
export const subjectsInput = enumArray(SUBJECTS, 4, 'An INSPIRE subject category.').describe(
  `Restrict to INSPIRE subject categories (up to 4). Multiple values must ALL hold, not either. Values: ${SUBJECTS.join(', ')}.`,
);

const year = () => blankAsUnset(z.number().int().min(1900).max(2100).optional());

/** Earliest publication year to include (inclusive); maps to INSPIRE `earliest_date`. */
export const yearFromInput = year().describe(
  'Earliest year to include (1900–2100, inclusive), matched on the earliest date INSPIRE records for the paper. Omit for no lower bound.',
);

/** Latest publication year to include (inclusive); maps to INSPIRE `earliest_date`. */
export const yearToInput = year().describe(
  'Latest year to include (1900–2100, inclusive), matched on the earliest date INSPIRE records for the paper. Omit for no upper bound.',
);

const asAuthorId = (value: unknown) =>
  typeof value === 'string' ? normalizeAuthorId(value) : value;

/** A required author name or identifier, normalized by `normalizeAuthorId` (ORCID URL, checksum, `INSPIRE-` case). */
export const authorQueryInput = z
  .preprocess(asAuthorId, z.string().min(1).max(200))
  .describe(
    'A physicist\'s name ("Witten, Edward" or "Edward Witten") or one identifier: INSPIRE BAI (Edward.Witten.1, exact and case-sensitive), ORCID (0000-0002-7752-6073 or an orcid.org URL), INSPIRE ID (INSPIRE-00136372), or author recid.',
  );

/** An optional author identifier (BAI, ORCID, INSPIRE ID, or recid); blank is unset. */
export const authorIdInput = z
  .preprocess((value) => {
    const id = asAuthorId(value);
    return id === '' ? undefined : id;
  }, z.string().max(200).optional())
  .describe(
    'One author identifier: INSPIRE BAI (Edward.Witten.1, exact and case-sensitive), ORCID (0000-0002-7752-6073 or an orcid.org URL), INSPIRE ID (INSPIRE-00136372), or author recid. Not a name — resolve names with cern_inspire_search_authors first. Pass this or query, not both.',
  );

/** `2012–2015`, `2012–` (open end), `–1990` (open start), or `undefined` when neither bound is set. */
export function yearRangeLabel(
  yearFrom: number | undefined,
  yearTo: number | undefined,
): string | undefined {
  if (yearFrom === undefined && yearTo === undefined) return;
  return `${yearFrom ?? ''}–${yearTo ?? ''}`;
}

/** The filters a call applied, for the `appliedFilters` echo. */
export interface AppliedFilters extends FacetFilters {
  excludeSelfCitations?: boolean | undefined;
  /** Echoed only when it is not the default `relevance`. */
  sort?: string | undefined;
}

/**
 * The `appliedFilters` echo: `sort=mostcited; document_types=published;
 * years=2012–2015`, or `none` when nothing narrows or reorders the result.
 */
export function formatAppliedFilters(filters: AppliedFilters): string {
  const years = yearRangeLabel(filters.yearFrom, filters.yearTo);
  const parts = [
    filters.sort && filters.sort !== 'relevance' ? `sort=${filters.sort}` : undefined,
    filters.documentTypes?.length ? `document_types=${filters.documentTypes.join(',')}` : undefined,
    filters.subjects?.length ? `subjects=${filters.subjects.join(',')}` : undefined,
    years ? `years=${years}` : undefined,
    filters.excludeSelfCitations ? 'exclude_self_citations=true' : undefined,
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? 'none' : parts.join('; ');
}

/** True when any facet filter (document types, subjects, years) is set. */
export function hasFacetFilters(filters: FacetFilters): boolean {
  return Boolean(
    filters.documentTypes?.length ||
      filters.subjects?.length ||
      filters.yearFrom !== undefined ||
      filters.yearTo !== undefined,
  );
}
