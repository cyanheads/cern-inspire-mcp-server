/**
 * @fileoverview Input schemas and helpers shared across the INSPIRE tools: the
 * blank-as-unset wrapper for form clients, the `paper` identifier input and the
 * route from a HEPData record to its paper, the facet enum arrays (comma-joined
 * or array, case-folded), the year bounds, the author-identifier inputs, and the
 * applied-filters echo string.
 * @module mcp-server/tools/inputs
 */

import { z } from '@cyanheads/mcp-ts-core';
import {
  hepdataRecordNumber,
  normalizeAuthorId,
  normalizePaperId,
  PAPER_ID_PATTERN,
} from '@/services/inspire/identifiers.js';
import type { FacetFilters } from '@/services/inspire/types.js';
import { DOCUMENT_TYPES, SUBJECTS } from '@/services/inspire/vocabulary.js';

/**
 * Treats `''` as unset before `schema` runs, so a form client's blank optional
 * field (enums with a default included) takes the default instead of failing.
 */
export const blankAsUnset = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema);

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
