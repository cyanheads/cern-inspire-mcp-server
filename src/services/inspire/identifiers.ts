/**
 * @fileoverview Paper and author identifier handling for INSPIRE: the one-to-one
 * normalizations the tool schemas run in their preprocess, the patterns they
 * validate against, and the classification that routes an identifier to the
 * INSPIRE query form that matches it.
 * @module services/inspire/identifiers
 */

/** How a paper identifier was resolved to an INSPIRE recid. */
export type PaperIdKind = 'recid' | 'arxiv' | 'doi';

const RECID = /^\d{1,9}$/;
const NEW_ARXIV = /^\d{4}\.\d{4,5}$/;
const OLD_ARXIV = /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}$/;
const DOI = /^10\.\d{4,9}\/\S+$/;

/** A normalized paper identifier: recid, new or old arXiv ID, or DOI. */
export const PAPER_ID_PATTERN =
  /^(?:\d{1,9}|\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}|10\.\d{4,9}\/\S+)$/;

/**
 * Reduces the accepted spellings of a paper identifier to its bare form: trims,
 * maps arxiv.org, doi.org, inspirehep.net literature, and hepdata.net record URLs
 * to the identifier they carry, strips `arXiv:` / `doi:` prefixes (and any space after them) and HEPData's
 * `ins` prefix, lower-cases an old-style arXiv archive (`HEP-TH/9711200` →
 * `hep-th/9711200`, the subject class of `math.AG/0601001` kept as written), and
 * drops an arXiv version suffix (INSPIRE matches `1207.7214`, not `1207.7214v2`).
 * Every mapping is one-to-one; anything else passes through for the pattern
 * check to reject.
 */
export function normalizePaperId(raw: string): string {
  let id = raw.trim();
  id = id.replace(
    /^https?:\/\/(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i,
    '$1',
  );
  id = id.replace(/^arxiv:\s*/i, '');
  id = id.replace(/^doi:\s*/i, '');
  id = id.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '');
  id = id.replace(
    /^https?:\/\/(?:www\.)?inspirehep\.net\/(?:api\/)?literature\/(\d+)\/?(?:[?#].*)?$/i,
    '$1',
  );
  id = id.replace(/^https?:\/\/(?:www\.)?hepdata\.net\/record\/ins(\d+)\/?(?:[?#].*)?$/i, '$1');
  id = id.replace(/^ins(\d+)$/i, '$1');
  id = id.replace(/^[A-Za-z-]+(?=(?:\.[A-Za-z]{2})?\/\d{7}(?:v\d+)?$)/, (archive) =>
    archive.toLowerCase(),
  );
  id = id.replace(/^(\d{4}\.\d{4,5})v\d+$/, '$1');
  id = id.replace(/^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})v\d+$/, '$1');
  return id;
}

/** Classifies a normalized paper identifier; `undefined` when it matches no form. */
export function classifyPaperId(id: string): PaperIdKind | undefined {
  if (RECID.test(id)) return 'recid';
  if (NEW_ARXIV.test(id) || OLD_ARXIV.test(id)) return 'arxiv';
  if (DOI.test(id)) return 'doi';
  return;
}

/** How an author query was routed: one of the identifier forms, or a free-text name. */
export type AuthorMatch = 'orcid' | 'inspire_id' | 'bai' | 'recid' | 'name';

const ORCID = /^\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/;
const INSPIRE_ID = /^INSPIRE-\d{8}$/;
const BAI = /^[A-Za-z][A-Za-z'-]*(?:\.[A-Za-z'-]+)*\.\d+$/;

/**
 * Normalizes an author identifier: trims, reduces an orcid.org URL to the bare iD,
 * upper-cases an ORCID checksum `x`, and upper-cases an `inspire-` prefix. BAIs
 * are left as written — their case is part of the identifier.
 */
export function normalizeAuthorId(raw: string): string {
  let id = raw.trim().replace(/^https?:\/\/(?:www\.)?orcid\.org\/(\S+?)\/?$/i, '$1');
  if (/^\d{4}-\d{4}-\d{4}-\d{3}x$/.test(id)) id = `${id.slice(0, -1)}X`;
  if (/^inspire-\d{8}$/i.test(id)) id = `INSPIRE-${id.slice(8)}`;
  return id;
}

/** An author query routed to the INSPIRE `/authors` query string that matches it. */
export interface AuthorRoute {
  matchedAs: AuthorMatch;
  /** The `q` value sent to `/api/authors`. */
  q: string;
}

/**
 * Routes a normalized author query, first match wins: ORCID, INSPIRE ID, and BAI
 * → `ids.value:<id>` (exact, case-sensitive); a recid → `control_number:<n>`;
 * anything else is a free-text name sent as written.
 */
export function routeAuthorQuery(query: string): AuthorRoute {
  if (ORCID.test(query)) return { matchedAs: 'orcid', q: `ids.value:${query}` };
  if (INSPIRE_ID.test(query)) return { matchedAs: 'inspire_id', q: `ids.value:${query}` };
  if (BAI.test(query)) return { matchedAs: 'bai', q: `ids.value:${query}` };
  if (RECID.test(query)) return { matchedAs: 'recid', q: `control_number:${query}` };
  return { matchedAs: 'name', q: query };
}

/** True when the text carries an ORCID-shaped token (literature queries never match one). */
export function containsOrcid(text: string): boolean {
  return /(?:^|[^\d])\d{4}-\d{4}-\d{4}-\d{3}[\dXx](?![\d])/.test(text);
}
