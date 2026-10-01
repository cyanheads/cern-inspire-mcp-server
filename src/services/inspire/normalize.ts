/**
 * @fileoverview Raw INSPIRE records → the normalized domain shapes the tools
 * return. Absent upstream fields stay absent (conditional spreads), never filled
 * with invented values; strings are copied verbatim.
 * @module services/inspire/normalize
 */

import type { PaperIdKind } from './identifiers.js';
import type {
  AuthorPosition,
  AuthorProfile,
  CitationBucket,
  CitationEntry,
  CitationExportFormat,
  CitationSummary,
  CitationTotals,
  ExperimentRecord,
  HepdataAvailability,
  HepdataRecord,
  LiteratureHit,
  PaperAuthor,
  PaperLookup,
  PaperPublication,
  RawAuthorMetadata,
  RawCitationBucketSet,
  RawCitationSummaryResponse,
  RawDataDoi,
  RawDataMetadata,
  RawExperimentMetadata,
  RawHit,
  RawId,
  RawLiteratureMetadata,
  RawPublicationInfo,
  RawRef,
  RawSearchEnvelope,
  RawUrl,
  RawValue,
} from './types.js';
import { CITATION_BUCKET_KEYS } from './vocabulary.js';

const INSPIRE_WEB = 'https://inspirehep.net';
const HEPDATA_WEB = 'https://www.hepdata.net';
const SNIPPET_CHARS = 300;

// ─── Primitive readers ──────────────────────────────────────────────────────

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const bool = (value: unknown): boolean | undefined =>
  typeof value === 'boolean' ? value : undefined;

/** `{ [key]: value }` when the value is present, `{}` otherwise — for optional fields. */
const opt = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const strings = (list: readonly unknown[] | undefined): string[] =>
  (list ?? []).flatMap((item) => {
    const value = str(item);
    return value === undefined ? [] : [value];
  });

const values = (list: readonly RawValue[] | undefined): string[] =>
  strings((list ?? []).map((item) => item.value));

const unique = (list: string[]): string[] => [...new Set(list)];

/** The trailing record number of an INSPIRE `$ref` URL. */
const recidFromRef = (ref: RawRef | undefined): string | undefined =>
  ref?.$ref?.match(/\/(\d+)\/?$/)?.[1];

const idOf = (ids: readonly RawId[] | undefined, schema: string): string | undefined =>
  str(ids?.find((id) => id.schema === schema && str(id.value))?.value);

const recidOf = (controlNumber: number | undefined, hitId: string | undefined): string => {
  const n = num(controlNumber);
  return n === undefined ? (hitId ?? '') : String(n);
};

const urls = (list: readonly RawUrl[] | undefined): { description?: string; url: string }[] =>
  (list ?? []).flatMap((entry) => {
    const url = str(entry.value);
    return url === undefined ? [] : [{ url, ...opt('description', str(entry.description)) }];
  });

/** Text cut to `SNIPPET_CHARS` characters at a word boundary, with whether it was cut. */
function snippet(text: string): { text: string; truncated: boolean } {
  if (text.length <= SNIPPET_CHARS) return { text, truncated: false };
  let cut = text.slice(0, SNIPPET_CHARS);
  const lastSpace = cut.search(/\s\S*$/);
  if (lastSpace > 0) cut = cut.slice(0, lastSpace);
  else if (isHighSurrogate(cut.charCodeAt(cut.length - 1))) cut = cut.slice(0, -1);
  return { text: cut.trimEnd(), truncated: true };
}

/** True for the first half of a UTF-16 surrogate pair (a cut there would split a character). */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** The arXiv-sourced abstract when one exists, else the first. */
function pickAbstract(
  abstracts: readonly { source?: string; value?: string }[] | undefined,
): { source?: string; value: string } | undefined {
  const present = (abstracts ?? []).filter((a) => str(a.value));
  const chosen = present.find((a) => a.source === 'arXiv') ?? present[0];
  const value = str(chosen?.value);
  return value === undefined ? undefined : { value, ...opt('source', str(chosen?.source)) };
}

const titlesOf = (titles: readonly { title?: string }[] | undefined): string[] =>
  strings((titles ?? []).map((t) => t.title));

function pageRange(info: RawPublicationInfo): string | undefined {
  const start = str(info.page_start);
  const end = str(info.page_end);
  if (start && end) return `${start}-${end}`;
  return start;
}

/** `Journal Vol (Year) start-end` (or article ID), else the free-text pubinfo. */
function renderPublication(info: RawPublicationInfo): string | undefined {
  const journal = str(info.journal_title);
  if (!journal) return str(info.pubinfo_freetext);
  const year = num(info.year);
  return [
    journal,
    str(info.journal_volume),
    year === undefined ? undefined : `(${year})`,
    pageRange(info) ?? str(info.artid),
  ]
    .filter((part) => part !== undefined)
    .join(' ');
}

// ─── HEPData DOIs ───────────────────────────────────────────────────────────

interface HepdataDoiFacts {
  hepdataRecid?: string;
  latestVersion?: number;
  recordDoi?: string;
  tableCount?: number;
}

/**
 * Reads HEPData facts from a `data` record's DOIs: `material: 'data'` is the
 * record DOI (`10.17182/hepdata.<n>`), `'version'` DOIs end `.v<k>`, and the
 * table count is the `'part'` DOIs under the latest version (`….v<k>/t<j>`).
 */
function hepdataDoiFacts(dois: readonly RawDataDoi[] | undefined): HepdataDoiFacts {
  const list = dois ?? [];
  const recordDoi = str(list.find((d) => d.material === 'data' && str(d.value))?.value);
  let latest: { doi: string; version: number } | undefined;
  for (const doi of list) {
    const value = str(doi.value);
    const version = doi.material === 'version' ? value?.match(/\.v(\d+)$/)?.[1] : undefined;
    if (value && version && (!latest || Number(version) > latest.version)) {
      latest = { doi: value, version: Number(version) };
    }
  }
  const tableCount = latest
    ? list.filter((d) => d.material === 'part' && d.value?.startsWith(`${latest.doi}/`)).length
    : undefined;
  return {
    ...opt('recordDoi', recordDoi),
    ...opt('hepdataRecid', recordDoi?.match(/^10\.17182\/hepdata\.(\d+)$/i)?.[1]),
    ...opt('latestVersion', latest?.version),
    ...opt('tableCount', tableCount),
  };
}

const hepdataRecordUrl = (paperRecid: string) => `${HEPDATA_WEB}/record/ins${paperRecid}`;

// ─── Literature ─────────────────────────────────────────────────────────────

export function toLiteratureHit(hit: RawHit<RawLiteratureMetadata>): LiteratureHit {
  const m = hit.metadata ?? {};
  const firstAuthorName = str(m.first_author?.full_name);
  const firstAuthorRecid = num(m.first_author?.recid);
  const arxiv = m.arxiv_eprints?.find((e) => str(e.value));
  const abstract = pickAbstract(m.abstracts);
  const cut = abstract ? snippet(abstract.value) : undefined;
  return {
    recid: recidOf(m.control_number, hit.id),
    title: titlesOf(m.titles)[0] ?? '',
    ...(firstAuthorName
      ? {
          firstAuthor: {
            name: firstAuthorName,
            ...opt('recid', firstAuthorRecid === undefined ? undefined : String(firstAuthorRecid)),
          },
        }
      : {}),
    ...opt('authorCount', num(m.author_count)),
    collaborations: values(m.collaborations),
    ...opt('date', str(m.earliest_date)),
    documentTypes: strings(m.document_type),
    citationCount: num(m.citation_count) ?? 0,
    ...opt('citationCountWithoutSelf', num(m.citation_count_without_self_citations)),
    ...opt('arxivId', str(arxiv?.value)),
    arxivCategories: strings(arxiv?.categories),
    ...opt('doi', values(m.dois)[0]),
    ...opt('publication', (m.publication_info ?? []).map(renderPublication).find(Boolean)),
    ...(cut ? { abstractSnippet: cut.text, abstractTruncated: cut.truncated } : {}),
  };
}

function toPaperAuthor(
  author: NonNullable<RawLiteratureMetadata['authors']>[number],
): PaperAuthor[] {
  const name = str(author.full_name);
  if (name === undefined) return [];
  return [
    {
      name,
      ...opt('recid', recidFromRef(author.record)),
      ...opt('bai', idOf(author.ids, 'INSPIRE BAI')),
      ...opt('orcid', idOf(author.ids, 'ORCID')),
      affiliations: values(author.affiliations),
    },
  ];
}

function toPublication(info: RawPublicationInfo): PaperPublication[] {
  const publication: PaperPublication = {
    ...opt('journal', str(info.journal_title)),
    ...opt('volume', str(info.journal_volume)),
    ...opt('year', num(info.year)),
    ...opt('pages', pageRange(info)),
    ...opt('articleId', str(info.artid)),
    ...opt('freetext', str(info.pubinfo_freetext)),
  };
  return Object.keys(publication).length === 0 ? [] : [publication];
}

/** The `get_paper` dossier, its author list capped at `maxAuthors`. */
export function toPaperLookup(
  m: RawLiteratureMetadata,
  hitId: string | undefined,
  resolvedAs: PaperIdKind,
  hepdata: HepdataAvailability,
  maxAuthors: number,
): PaperLookup {
  const recid = recidOf(m.control_number, hitId);
  const [title = '', ...otherTitles] = titlesOf(m.titles);
  const abstract = pickAbstract(m.abstracts);
  const arxiv = m.arxiv_eprints?.find((e) => str(e.value));
  const authors = (m.authors ?? []).flatMap(toPaperAuthor);
  return {
    authorsInRecord: authors.length,
    paper: {
      recid,
      resolvedAs,
      title,
      alternateTitles: unique(otherTitles.filter((t) => t !== title)),
      ...(abstract ? { abstract: abstract.value, ...opt('abstractSource', abstract.source) } : {}),
      authorCount: num(m.author_count) ?? authors.length,
      authors: authors.slice(0, maxAuthors),
      collaborations: values(m.collaborations),
      experiments: (m.accelerator_experiments ?? []).flatMap((e) => {
        const name = str(e.legacy_name);
        return name === undefined ? [] : [{ name, ...opt('recid', recidFromRef(e.record)) }];
      }),
      ...opt('date', str(m.earliest_date)),
      ...opt('preprintDate', str(m.preprint_date)),
      ...opt('publicationDate', str(m.imprints?.[0]?.date)),
      publications: (m.publication_info ?? []).flatMap(toPublication),
      ...opt('arxivId', str(arxiv?.value)),
      arxivCategories: strings(arxiv?.categories),
      dois: unique(values(m.dois)),
      reportNumbers: values(m.report_numbers),
      keywords: unique(values(m.keywords)),
      subjects: strings((m.inspire_categories ?? []).map((c) => c.term)),
      documentTypes: strings(m.document_type),
      ...opt('refereed', bool(m.refereed)),
      ...opt('citeable', bool(m.citeable)),
      ...opt('core', bool(m.core)),
      ...opt('numberOfPages', num(m.number_of_pages)),
      citationCount: num(m.citation_count) ?? 0,
      ...opt('citationCountWithoutSelf', num(m.citation_count_without_self_citations)),
      texkeys: strings(m.texkeys),
      urls: urls(m.urls),
      licenses: (m.license ?? []).flatMap((l) => {
        const url = str(l.url);
        return url === undefined
          ? []
          : [{ url, ...opt('material', str(l.material)), ...opt('imposing', str(l.imposing)) }];
      }),
      inspireUrl: `${INSPIRE_WEB}/literature/${recid}`,
      citingQuery: `refersto:recid:${recid}`,
      referencesQuery: `citedby:recid:${recid}`,
      hepdata,
    },
  };
}

/** HEPData availability for a paper from its `data`-collection lookup. */
export function toHepdataAvailability(
  envelope: RawSearchEnvelope<RawDataMetadata>,
  paperRecid: string,
): HepdataAvailability {
  const hit = envelope.hits.hits[0];
  if (envelope.hits.total === 0 || !hit) return { status: 'none' };
  const { hepdataRecid: _omitted, ...facts } = hepdataDoiFacts(hit.metadata?.dois);
  return {
    status: 'available',
    inspireDataRecid: recidOf(hit.metadata?.control_number, hit.id),
    ...facts,
    hepdataUrl: hepdataRecordUrl(paperRecid),
  };
}

// ─── Citation export ────────────────────────────────────────────────────────

/**
 * Splits an INSPIRE export body into entries. BibTeX entries start with a line
 * beginning `@` (fields are indented); LaTeX entries start with `%\cite{`. Text
 * before the first entry start is dropped; each entry is kept verbatim, trimmed.
 */
export function splitCitationEntries(text: string, format: CitationExportFormat): CitationEntry[] {
  const isStart = format === 'bibtex' ? /^@/ : /^%\\cite\{/;
  const keyOf = format === 'bibtex' ? /^@\w+\{\s*([^,\s]+)\s*,/ : /^%\\cite\{([^}]+)\}/;
  const blocks: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (isStart.test(line)) blocks.push([line]);
    else blocks.at(-1)?.push(line);
  }
  return blocks.map((lines) => {
    const entry = lines.join('\n').trim();
    return { texkey: entry.match(keyOf)?.[1] ?? '', text: entry };
  });
}

// ─── Authors ────────────────────────────────────────────────────────────────

const PRIMARY_ID_SCHEMAS = new Set(['INSPIRE BAI', 'ORCID', 'INSPIRE ID']);

export function toAuthorProfile(hit: RawHit<RawAuthorMetadata>): AuthorProfile {
  const m = hit.metadata ?? {};
  const recid = recidOf(m.control_number, hit.id);
  const current: AuthorPosition[] = [];
  const past: AuthorPosition[] = [];
  for (const position of m.positions ?? []) {
    const institution = str(position.institution);
    if (institution === undefined) continue;
    (position.current === true ? current : past).push({
      institution,
      ...opt('rank', str(position.rank)),
      ...opt('startDate', str(position.start_date)),
      ...opt('endDate', str(position.end_date)),
      ...opt('institutionRecid', recidFromRef(position.record)),
    });
  }
  return {
    recid,
    name: str(m.name?.value) ?? '',
    ...opt('preferredName', str(m.name?.preferred_name)),
    ...opt('bai', idOf(m.ids, 'INSPIRE BAI')),
    ...opt('orcid', idOf(m.ids, 'ORCID')),
    ...opt('inspireId', idOf(m.ids, 'INSPIRE ID')),
    otherIds: (m.ids ?? []).flatMap((id) => {
      const schema = str(id.schema);
      const value = str(id.value);
      return schema && value && !PRIMARY_ID_SCHEMAS.has(schema) ? [{ schema, value }] : [];
    }),
    ...opt('status', str(m.status)),
    ...opt('stub', bool(m.stub)),
    currentPositions: current,
    pastPositions: past,
    arxivCategories: strings(m.arxiv_categories),
    advisors: (m.advisors ?? []).flatMap((a) => {
      const name = str(a.name);
      return name === undefined
        ? []
        : [
            {
              name,
              ...opt('degreeType', str(a.degree_type)),
              ...opt('recid', recidFromRef(a.record)),
            },
          ];
    }),
    urls: urls(m.urls),
    awards: (m.awards ?? []).flatMap((a) => {
      const name = str(a.name);
      return name === undefined ? [] : [{ name, ...opt('year', num(a.year)) }];
    }),
    literatureQuery: `authors.recid:${recid}`,
  };
}

// ─── Citation summary ───────────────────────────────────────────────────────

function toTotals(set: RawCitationBucketSet | undefined): CitationTotals {
  return {
    papers: num(set?.doc_count) ?? 0,
    citations: Math.round(num(set?.citations_count?.value) ?? 0),
    ...opt('averageCitations', num(set?.average_citations?.value)),
  };
}

function toBuckets(set: RawCitationBucketSet | undefined): CitationBucket[] {
  return (set?.citation_buckets?.buckets ?? []).flatMap((bucket) => {
    const range = bucket.key === undefined ? undefined : CITATION_BUCKET_KEYS[bucket.key];
    return range === undefined ? [] : [{ range, papers: num(bucket.doc_count) ?? 0 }];
  });
}

export function toCitationSummary(body: RawCitationSummaryResponse): CitationSummary {
  const summary = body.aggregations.citation_summary;
  const all = summary.citations?.buckets?.all;
  const published = summary.citations?.buckets?.published;
  return {
    matchedRecords: num(body.hits?.total?.value) ?? 0,
    citeablePapers: num(summary.doc_count) ?? 0,
    hIndex: {
      all: num(summary['h-index']?.value?.all) ?? 0,
      published: num(summary['h-index']?.value?.published) ?? 0,
    },
    all: toTotals(all),
    published: toTotals(published),
    buckets: { all: toBuckets(all), published: toBuckets(published) },
  };
}

// ─── Experiments ────────────────────────────────────────────────────────────

/** INSPIRE's `date_completed` sentinel for an experiment still running. */
const ONGOING_SENTINEL = '9999';

/**
 * True for the running sentinel, false for a real completion date, and
 * `undefined` when INSPIRE records no completion date: many active experiments
 * carry none, so the status is unknown and is never inferred from other dates.
 */
const ongoingFrom = (completed: string | undefined): boolean | undefined =>
  completed === undefined ? undefined : completed === ONGOING_SENTINEL;

export function toExperimentRecord(hit: RawHit<RawExperimentMetadata>): ExperimentRecord {
  const m = hit.metadata ?? {};
  const legacyName = str(m.legacy_name) ?? '';
  const completed = str(m.date_completed);
  const collaboration = str(m.collaboration?.value);
  return {
    recid: recidOf(m.control_number, hit.id),
    legacyName,
    ...opt('name', str(m.experiment?.value)),
    ...opt('shortName', str(m.experiment?.short_name)),
    ...opt('longName', str(m.long_name)),
    ...opt('accelerator', str(m.accelerator?.value)),
    institutions: (m.institutions ?? []).flatMap((i) => {
      const name = str(i.value);
      return name === undefined ? [] : [{ name, ...opt('recid', recidFromRef(i.record)) }];
    }),
    ...(collaboration
      ? {
          collaboration: {
            name: collaboration,
            subgroups: strings(m.collaboration?.subgroup_names),
          },
        }
      : {}),
    classification: strings(m.inspire_classification),
    projectTypes: strings(m.project_type),
    ...opt('dateProposed', str(m.date_proposed)),
    ...opt('dateApproved', str(m.date_approved)),
    ...opt('dateStarted', str(m.date_started)),
    ...opt('dateCompleted', completed === ONGOING_SENTINEL ? undefined : completed),
    ...opt('ongoing', ongoingFrom(completed)),
    ...opt('numberOfPapers', num(m.number_of_papers)),
    ...opt('description', str(m.description)),
    urls: urls(m.urls),
    nameVariants: strings(m.name_variants),
    ...opt('core', bool(m.core)),
    literatureQuery: `accelerator_experiments.legacy_name:"${legacyName}"`,
  };
}

// ─── HEPData records (INSPIRE `data` collection) ────────────────────────────

export function toHepdataRecord(hit: RawHit<RawDataMetadata>): HepdataRecord {
  const m = hit.metadata ?? {};
  const paperRecids = (m.literature ?? []).flatMap((l) => {
    const n = num(l.control_number);
    return n === undefined ? [] : [String(n)];
  });
  const abstract = values(m.abstracts)[0];
  const cut = abstract === undefined ? undefined : snippet(abstract);
  return {
    inspireDataRecid: recidOf(m.control_number, hit.id),
    title: titlesOf(m.titles)[0] ?? '',
    paperRecids,
    collaborations: values(m.collaborations),
    experiments: strings((m.accelerator_experiments ?? []).map((e) => e.legacy_name)),
    keywords: values(m.keywords),
    ...(cut ? { abstractSnippet: cut.text, abstractTruncated: cut.truncated } : {}),
    ...hepdataDoiFacts(m.dois),
    ...opt(
      'hepdataUrl',
      paperRecids[0] === undefined ? undefined : hepdataRecordUrl(paperRecids[0]),
    ),
    ...opt('created', str(m.creation_date)),
    ...opt('citationCount', num(m.citation_count)),
  };
}
