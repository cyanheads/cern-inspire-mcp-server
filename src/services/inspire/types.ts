/**
 * @fileoverview INSPIRE types: the raw upstream shapes the service reads (every
 * field optional — INSPIRE omits what a record lacks), and the normalized domain
 * shapes the service returns to the tools, named as the tool outputs name them.
 * @module services/inspire/types
 */

import type { AuthorMatch, PaperIdKind } from './identifiers.js';
import type { CitationBucketRange, DocumentType, Subject } from './vocabulary.js';

// ─── Raw upstream shapes ────────────────────────────────────────────────────

/** A JSON reference to another INSPIRE record (`{ $ref: 'https://…/api/<collection>/<n>' }`). */
export interface RawRef {
  $ref?: string;
}

/** The envelope every INSPIRE search endpoint returns. */
export interface RawSearchEnvelope<M> {
  hits: { hits: RawHit<M>[]; total: number };
  links?: { next?: string };
}

export interface RawHit<M> {
  id?: string;
  metadata?: M;
}

export interface RawValue {
  value?: string;
}

export interface RawId {
  schema?: string;
  value?: string;
}

export interface RawUrl {
  description?: string;
  value?: string;
}

export interface RawPublicationInfo {
  artid?: string;
  journal_title?: string;
  journal_volume?: string;
  page_end?: string;
  page_start?: string;
  pubinfo_freetext?: string;
  year?: number;
}

export interface RawLiteratureAuthor {
  affiliations?: RawValue[];
  full_name?: string;
  ids?: RawId[];
  record?: RawRef;
}

export interface RawLiteratureMetadata {
  abstracts?: { source?: string; value?: string }[];
  accelerator_experiments?: { legacy_name?: string; record?: RawRef }[];
  arxiv_eprints?: { categories?: string[]; value?: string }[];
  author_count?: number;
  authors?: RawLiteratureAuthor[];
  citation_count?: number;
  citation_count_without_self_citations?: number;
  citeable?: boolean;
  collaborations?: RawValue[];
  control_number?: number;
  core?: boolean;
  document_type?: string[];
  dois?: RawValue[];
  earliest_date?: string;
  first_author?: { full_name?: string; recid?: number };
  imprints?: { date?: string }[];
  inspire_categories?: { term?: string }[];
  keywords?: RawValue[];
  license?: { imposing?: string; url?: string }[];
  number_of_pages?: number;
  preprint_date?: string;
  publication_info?: RawPublicationInfo[];
  refereed?: boolean;
  report_numbers?: RawValue[];
  texkeys?: string[];
  titles?: { title?: string }[];
  urls?: RawUrl[];
}

export interface RawAuthorMetadata {
  advisors?: { degree_type?: string; name?: string; record?: RawRef }[];
  arxiv_categories?: string[];
  awards?: { name?: string; year?: number }[];
  control_number?: number;
  deleted?: boolean;
  ids?: RawId[];
  name?: { preferred_name?: string; value?: string };
  positions?: {
    current?: boolean;
    end_date?: string;
    institution?: string;
    rank?: string;
    record?: RawRef;
    start_date?: string;
  }[];
  status?: string;
  stub?: boolean;
  urls?: RawUrl[];
}

export interface RawExperimentMetadata {
  accelerator?: RawValue;
  collaboration?: { subgroup_names?: string[]; value?: string };
  control_number?: number;
  core?: boolean;
  date_approved?: string;
  date_completed?: string;
  date_proposed?: string;
  date_started?: string;
  description?: string;
  experiment?: { short_name?: string; value?: string };
  inspire_classification?: string[];
  institutions?: { record?: RawRef; value?: string }[];
  legacy_name?: string;
  long_name?: string;
  name_variants?: string[];
  number_of_papers?: number;
  project_type?: string[];
  urls?: RawUrl[];
}

export interface RawDataDoi {
  material?: string;
  value?: string;
}

export interface RawDataMetadata {
  abstracts?: RawValue[];
  accelerator_experiments?: { legacy_name?: string }[];
  citation_count?: number;
  collaborations?: RawValue[];
  control_number?: number;
  creation_date?: string;
  dois?: RawDataDoi[];
  keywords?: RawValue[];
  literature?: { control_number?: number }[];
  titles?: { title?: string }[];
}

export interface RawCitationBucketSet {
  average_citations?: { value?: number | null };
  citation_buckets?: { buckets?: { doc_count?: number; key?: string }[] };
  citations_count?: { value?: number };
  doc_count?: number;
}

export interface RawCitationSummaryResponse {
  aggregations: {
    citation_summary: {
      citations?: { buckets?: { all?: RawCitationBucketSet; published?: RawCitationBucketSet } };
      doc_count?: number;
      'h-index'?: { value?: { all?: number; published?: number } };
    };
  };
  hits?: { total?: { value?: number } };
}

// ─── Request parameters ─────────────────────────────────────────────────────

export type LiteratureSort = 'relevance' | 'mostrecent' | 'mostcited';
export type HepdataSort = 'relevance' | 'mostrecent';
export type CitationExportFormat = 'bibtex' | 'latex-eu' | 'latex-us';

/** Literature facet filters. Multiple document types or subjects AND together upstream. */
export interface FacetFilters {
  documentTypes?: readonly DocumentType[] | undefined;
  subjects?: readonly Subject[] | undefined;
  yearFrom?: number | undefined;
  yearTo?: number | undefined;
}

export interface LiteratureSearchParams extends FacetFilters {
  page: number;
  query: string;
  size: number;
  sort: LiteratureSort;
}

export interface CitationExportParams {
  format: CitationExportFormat;
  query: string;
  /** Entries wanted; the service asks for one more to detect truncation. */
  size: number;
  sort: LiteratureSort;
}

export interface CitationSummaryParams extends FacetFilters {
  excludeSelfCitations: boolean;
  /** A literature query (an author target is passed as `authors.recid:<n>`). */
  query: string;
}

export interface HepdataSearchParams {
  page: number;
  query: string;
  size: number;
  sort: HepdataSort;
}

// ─── Normalized domain shapes ───────────────────────────────────────────────

export interface LiteratureHit {
  abstractSnippet?: string;
  abstractTruncated?: boolean;
  arxivCategories: string[];
  arxivId?: string;
  authorCount?: number;
  citationCount: number;
  citationCountWithoutSelf?: number;
  collaborations: string[];
  date?: string;
  documentTypes: string[];
  doi?: string;
  firstAuthor?: { name: string; recid?: string };
  publication?: string;
  recid: string;
  title: string;
}

export interface LiteratureSearchPage {
  hasMore: boolean;
  papers: LiteratureHit[];
  total: number;
}

export interface ResolvedPaper {
  recid: string;
  resolvedAs: PaperIdKind;
}

export interface PaperAuthor {
  affiliations: string[];
  bai?: string;
  name: string;
  orcid?: string;
  recid?: string;
}

export interface PaperPublication {
  articleId?: string;
  freetext?: string;
  journal?: string;
  pages?: string;
  volume?: string;
  year?: number;
}

/** HEPData availability for one paper, read from INSPIRE's `data` collection. */
export interface HepdataAvailability {
  hepdataUrl?: string;
  inspireDataRecid?: string;
  latestVersion?: number;
  recordDoi?: string;
  status: 'available' | 'none' | 'lookup_failed';
  tableCount?: number;
}

export interface PaperDossier {
  abstract?: string;
  abstractSource?: string;
  alternateTitles: string[];
  arxivCategories: string[];
  arxivId?: string;
  authorCount: number;
  /** Capped at the requested `maxAuthors`. */
  authors: PaperAuthor[];
  citationCount: number;
  citationCountWithoutSelf?: number;
  citeable?: boolean;
  citingQuery: string;
  collaborations: string[];
  core?: boolean;
  date?: string;
  documentTypes: string[];
  dois: string[];
  experiments: { name: string; recid?: string }[];
  hepdata: HepdataAvailability;
  inspireUrl: string;
  keywords: string[];
  licenses: { imposing?: string; url: string }[];
  numberOfPages?: number;
  preprintDate?: string;
  publicationDate?: string;
  publications: PaperPublication[];
  recid: string;
  refereed?: boolean;
  referencesQuery: string;
  reportNumbers: string[];
  resolvedAs: PaperIdKind;
  subjects: string[];
  texkeys: string[];
  title: string;
  urls: { description?: string; url: string }[];
}

export interface PaperLookup {
  /** Length of the record's downloaded author list, before the `maxAuthors` cap. */
  authorsInRecord: number;
  paper: PaperDossier;
}

export interface CitationEntry {
  texkey: string;
  text: string;
}

export interface CitationExport {
  entries: CitationEntry[];
  /** True when more than `size` entries came back. */
  truncated: boolean;
}

export interface AuthorPosition {
  endDate?: string;
  institution: string;
  institutionRecid?: string;
  rank?: string;
  startDate?: string;
}

export interface AuthorProfile {
  advisors: { degreeType?: string; name: string; recid?: string }[];
  arxivCategories: string[];
  awards: { name: string; year?: number }[];
  bai?: string;
  currentPositions: AuthorPosition[];
  inspireId?: string;
  literatureQuery: string;
  name: string;
  orcid?: string;
  otherIds: { schema: string; value: string }[];
  pastPositions: AuthorPosition[];
  preferredName?: string;
  recid: string;
  status?: string;
  stub?: boolean;
  urls: { description?: string; url: string }[];
}

export interface AuthorSearchPage {
  authors: AuthorProfile[];
  /** Hits dropped because the profile is marked deleted. */
  deletedDropped: number;
  matchedAs: AuthorMatch;
  total: number;
}

export interface ResolvedAuthor {
  name: string;
  recid: string;
}

export interface CitationTotals {
  averageCitations?: number;
  citations: number;
  papers: number;
}

export interface CitationBucket {
  papers: number;
  range: CitationBucketRange;
}

export interface CitationSummary {
  all: CitationTotals;
  buckets: { all: CitationBucket[]; published: CitationBucket[] };
  citeablePapers: number;
  hIndex: { all: number; published: number };
  matchedRecords: number;
  published: CitationTotals;
}

export interface ExperimentRecord {
  accelerator?: string;
  classification: string[];
  collaboration?: { name: string; subgroups: string[] };
  core?: boolean;
  dateApproved?: string;
  dateCompleted?: string;
  dateProposed?: string;
  dateStarted?: string;
  description?: string;
  institutions: { name: string; recid?: string }[];
  legacyName: string;
  literatureQuery: string;
  longName?: string;
  name?: string;
  nameVariants: string[];
  numberOfPapers?: number;
  ongoing: boolean;
  projectTypes: string[];
  recid: string;
  shortName?: string;
  urls: { description?: string; url: string }[];
}

export interface ExperimentSearchPage {
  experiments: ExperimentRecord[];
  total: number;
}

export interface HepdataRecord {
  abstractSnippet?: string;
  abstractTruncated?: boolean;
  citationCount?: number;
  collaborations: string[];
  created?: string;
  experiments: string[];
  hepdataRecid?: string;
  hepdataUrl?: string;
  inspireDataRecid: string;
  keywords: string[];
  latestVersion?: number;
  paperRecids: string[];
  recordDoi?: string;
  tableCount?: number;
  title: string;
}

export interface HepdataSearchPage {
  hasMore: boolean;
  records: HepdataRecord[];
  total: number;
}
