/**
 * @fileoverview INSPIRE's controlled vocabularies: the literature facet values
 * (document types, subjects) and the citation-summary bucket ranges. Facet values
 * are exact and case-sensitive upstream, so these spellings are the canonical
 * forms every input is folded to.
 * @module services/inspire/vocabulary
 */

/** The 13 literature `doc_type` facet values, pulled from the live facet buckets. */
export const DOCUMENT_TYPES = [
  'article',
  'published',
  'conference paper',
  'thesis',
  'review',
  'note',
  'proceedings',
  'lectures',
  'book chapter',
  'book',
  'introductory',
  'activity report',
  'report',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** The 18 literature `subject` facet values (INSPIRE categories). */
export const SUBJECTS = [
  'Astrophysics',
  'Phenomenology-HEP',
  'Theory-HEP',
  'Quantum Physics',
  'Unknown',
  'Gravitation and Cosmology',
  'Experiment-HEP',
  'Theory-Nucl',
  'Accelerators',
  'Instrumentation',
  'General Physics',
  'Experiment-Nucl',
  'Math and Math Physics',
  'Condensed Matter',
  'Computing',
  'Lattice',
  'Other',
  'Data Analysis and Statistics',
] as const;

export type Subject = (typeof SUBJECTS)[number];

/** Citation-summary bucket ranges, in upstream order. */
export const CITATION_BUCKET_RANGES = [
  '0',
  '1–9',
  '10–49',
  '50–99',
  '100–249',
  '250–499',
  '500+',
] as const;

export type CitationBucketRange = (typeof CITATION_BUCKET_RANGES)[number];

/**
 * Upstream citation-summary bucket key → output range label. A `Map`, since the
 * key comes from the response: an object literal would answer `constructor`.
 */
export const CITATION_BUCKET_KEYS: ReadonlyMap<string, CitationBucketRange> = new Map([
  ['0--0', '0'],
  ['1--9', '1–9'],
  ['10--49', '10–49'],
  ['50--99', '50–99'],
  ['100--249', '100–249'],
  ['250--499', '250–499'],
  ['500--', '500+'],
]);
