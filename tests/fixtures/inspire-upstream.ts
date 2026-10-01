/**
 * @fileoverview Upstream INSPIRE response bodies in the shapes the design's API
 * Reference records, for service and tool tests. Papers carry real identifiers
 * (recids, arXiv IDs, DOIs); people are synthetic (`Doe, Jane`, `Jane.Doe.1`).
 * Builders take overrides so a test states only what it varies; absent upstream
 * fields stay absent.
 * @module tests/fixtures/inspire-upstream
 */

import type {
  RawAuthorMetadata,
  RawCitationBucketSet,
  RawCitationSummaryResponse,
  RawDataDoi,
  RawDataMetadata,
  RawExperimentMetadata,
  RawHit,
  RawLiteratureAuthor,
  RawLiteratureMetadata,
  RawSearchEnvelope,
} from '@/services/inspire/types.js';

export const INSPIRE_ORIGIN = 'https://inspirehep.net';

/** The paper a good share of the fixtures describe: the 2012 Higgs observation. */
export const HIGGS = {
  recid: '1124337',
  arxiv: '1207.7214',
  doi: '10.1016/j.physletb.2012.08.020',
};

/** hep-th/9711200, an old-style arXiv ID. */
export const MALDACENA = { recid: '451647', arxiv: 'hep-th/9711200' };

/** `value` without `keys`: how a test drops an optional upstream field (not sets it to `undefined`). */
export function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

// ─── Envelopes ──────────────────────────────────────────────────────────────

/** One search hit: `{ id, created, updated, links, metadata }`. */
export function hit<M>(metadata: M | undefined, id?: string): RawHit<M> {
  return {
    ...(id !== undefined && { id }),
    ...(metadata !== undefined && { metadata }),
  };
}

/** A search envelope; `total` defaults to the hit count, `next` adds `links.next`. */
export function searchBody<M>(
  hits: readonly RawHit<M>[],
  options: { next?: boolean; total?: number } = {},
): RawSearchEnvelope<M> {
  return {
    hits: { total: options.total ?? hits.length, hits: [...hits] },
    links: {
      self: 'https://inspirehep.net/api/literature?q=x',
      ...(options.next && { next: 'https://inspirehep.net/api/literature?q=x&page=2' }),
    },
  } as RawSearchEnvelope<M>;
}

/** The zero-hit page of any search endpoint. */
export const emptyBody = () => searchBody<never>([]);

// ─── Literature ─────────────────────────────────────────────────────────────

export function literatureMetadata(
  overrides: Partial<RawLiteratureMetadata> = {},
): RawLiteratureMetadata {
  return {
    control_number: Number(HIGGS.recid),
    titles: [
      {
        title:
          'Observation of a new particle in the search for the Standard Model Higgs boson with the ATLAS detector at the LHC',
      },
    ],
    first_author: { full_name: 'Doe, Jane', recid: 1000001 },
    author_count: 2932,
    collaborations: [{ value: 'ATLAS' }],
    earliest_date: '2012-09-17',
    document_type: ['article'],
    citation_count: 12345,
    citation_count_without_self_citations: 11800,
    arxiv_eprints: [{ value: HIGGS.arxiv, categories: ['hep-ex'] }],
    dois: [{ value: HIGGS.doi }],
    publication_info: [
      {
        journal_title: 'Phys.Lett.B',
        journal_volume: '716',
        year: 2012,
        page_start: '1',
        page_end: '29',
      },
    ],
    abstracts: [
      {
        source: 'arXiv',
        value: 'A search for the Standard Model Higgs boson in proton-proton collisions.',
      },
    ],
    ...overrides,
  };
}

/** A 1961-style record: no arXiv, no DOI, free-text publication info, no first author. */
export function sparseLiteratureMetadata(): RawLiteratureMetadata {
  return {
    control_number: 1000,
    titles: [{ title: 'Partial symmetries of weak interactions' }],
    earliest_date: '1961',
    document_type: ['article'],
    publication_info: [{ pubinfo_freetext: 'Nucl.Phys. 22 (1961) 579-588' }],
  };
}

/** A literature search page of one hit per metadata object, ids taken from `control_number`. */
export function literaturePage(
  metadata: readonly RawLiteratureMetadata[] = [literatureMetadata()],
  options: { next?: boolean; total?: number } = {},
) {
  return searchBody(
    metadata.map((m) =>
      hit(m, m.control_number === undefined ? undefined : String(m.control_number)),
    ),
    options,
  );
}

/** A dossier record: `n` synthetic authors with affiliations and ids, ahead of the usual fields. */
export function dossierMetadata(
  authorTotal: number,
  overrides: Partial<RawLiteratureMetadata> = {},
): RawLiteratureMetadata {
  const authors: RawLiteratureAuthor[] = Array.from({ length: authorTotal }, (_, i) => ({
    full_name: `Doe, Jane ${i + 1}`,
    affiliations: [{ value: 'Example Institute' }],
    record: { $ref: `https://inspirehep.net/api/authors/${2000000 + i}` },
    ids: [{ schema: 'INSPIRE BAI', value: `Jane.Doe.${i + 1}` }],
  }));
  return literatureMetadata({
    authors,
    author_count: authorTotal,
    accelerator_experiments: [
      {
        legacy_name: 'CERN-LHC-ATLAS',
        record: { $ref: 'https://inspirehep.net/api/experiments/1108541' },
      },
    ],
    keywords: [{ value: 'Higgs particle' }, { value: 'Higgs particle' }],
    inspire_categories: [{ term: 'Experiment-HEP' }],
    refereed: true,
    citeable: true,
    core: true,
    texkeys: ['ATLAS:2012yve'],
    ...overrides,
  });
}

// ─── Data collection (HEPData index) ────────────────────────────────────────

/** Record, two versions, parts under both; the latest version (v2) holds three tables. */
export const TWO_VERSION_DOIS: RawDataDoi[] = [
  { value: '10.17182/hepdata.89456', material: 'data' },
  { value: '10.17182/hepdata.89456.v1', material: 'version' },
  { value: '10.17182/hepdata.89456.v2', material: 'version' },
  { value: '10.17182/hepdata.89456.v1/t1', material: 'part' },
  { value: '10.17182/hepdata.89456.v1/t2', material: 'part' },
  { value: '10.17182/hepdata.89456.v2/t1', material: 'part' },
  { value: '10.17182/hepdata.89456.v2/t2', material: 'part' },
  { value: '10.17182/hepdata.89456.v2/t3', material: 'part' },
];

export function dataMetadata(overrides: Partial<RawDataMetadata> = {}): RawDataMetadata {
  return {
    control_number: 1860001,
    titles: [{ title: 'Differential cross sections for Higgs boson production' }],
    literature: [{ control_number: 1680459 }],
    collaborations: [{ value: 'ATLAS' }],
    accelerator_experiments: [{ legacy_name: 'CERN-LHC-ATLAS' }],
    keywords: [{ value: 'cmenergies: 13000.0-13000.0' }, { value: 'observables: SIG' }],
    abstracts: [{ value: 'Measured cross sections as a function of the transverse momentum.' }],
    dois: TWO_VERSION_DOIS,
    creation_date: '2020-01-02T03:04:05.000000+00:00',
    citation_count: 3,
    ...overrides,
  };
}

export function dataPage(
  metadata: readonly RawDataMetadata[] = [dataMetadata()],
  options: { next?: boolean; total?: number } = {},
) {
  return searchBody(
    metadata.map((m) => hit(m, String(m.control_number))),
    options,
  );
}

// ─── Authors ────────────────────────────────────────────────────────────────

export function authorMetadata(overrides: Partial<RawAuthorMetadata> = {}): RawAuthorMetadata {
  return {
    control_number: 1000001,
    name: { value: 'Doe, Jane', preferred_name: 'Jane Doe' },
    ids: [
      { schema: 'INSPIRE BAI', value: 'Jane.Doe.1' },
      { schema: 'ORCID', value: '0000-0002-1825-0097' },
      { schema: 'INSPIRE ID', value: 'INSPIRE-00000001' },
      { schema: 'WIKIPEDIA', value: 'Jane_Doe' },
    ],
    positions: [
      { institution: 'Example Institute', rank: 'STAFF', start_date: '2015', current: true },
      { institution: 'Sample University', rank: 'PHD', start_date: '2008', end_date: '2014' },
    ],
    advisors: [{ name: 'Roe, Richard', degree_type: 'phd' }],
    arxiv_categories: ['hep-th'],
    status: 'active',
    ...overrides,
  };
}

export function authorPage(
  metadata: readonly RawAuthorMetadata[] = [authorMetadata()],
  options: { total?: number } = {},
) {
  return searchBody(
    metadata.map((m) =>
      hit(m, m.control_number === undefined ? undefined : String(m.control_number)),
    ),
    options,
  );
}

// ─── Experiments ────────────────────────────────────────────────────────────

export function experimentMetadata(
  overrides: Partial<RawExperimentMetadata> = {},
): RawExperimentMetadata {
  return {
    control_number: 1108541,
    legacy_name: 'CERN-LHC-ATLAS',
    experiment: { value: 'ATLAS', short_name: 'ATLAS' },
    accelerator: { value: 'LHC' },
    collaboration: { value: 'ATLAS', subgroup_names: ['ATLAS Higgs Working Group'] },
    institutions: [
      { value: 'CERN', record: { $ref: 'https://inspirehep.net/api/institutions/902725' } },
    ],
    date_started: '2009',
    date_completed: '9999',
    number_of_papers: 18497,
    description: 'A general-purpose detector at the LHC.',
    ...overrides,
  };
}

export function experimentPage(
  metadata: readonly RawExperimentMetadata[] = [experimentMetadata()],
  options: { total?: number } = {},
) {
  return searchBody(
    metadata.map((m) =>
      hit(m, m.control_number === undefined ? undefined : String(m.control_number)),
    ),
    options,
  );
}

// ─── Citation summary ───────────────────────────────────────────────────────

function bucketSet(
  papers: number,
  citations: number,
  average: number | null,
  counts: readonly number[],
): RawCitationBucketSet {
  const keys = ['0--0', '1--9', '10--49', '50--99', '100--249', '250--499', '500--'];
  return {
    doc_count: papers,
    citations_count: { value: citations },
    average_citations: { value: average },
    citation_buckets: { buckets: keys.map((key, i) => ({ key, doc_count: counts[i] ?? 0 })) },
  };
}

/** The `citation_summary` facet response; a float `citations_count.value` as upstream sends it. */
export function citationSummaryBody(): RawCitationSummaryResponse {
  return {
    hits: { total: { value: 455 } },
    aggregations: {
      citation_summary: {
        doc_count: 413,
        'h-index': { value: { all: 197, published: 184 } },
        citations: {
          buckets: {
            all: bucketSet(413, 202121.0, 489.4, [30, 40, 90, 60, 80, 60, 53]),
            published: bucketSet(320, 189652.0, 592.7, [5, 20, 70, 55, 75, 55, 40]),
          },
        },
      },
    },
  };
}

/** The zero-match summary: every count 0, `average_citations.value: null`. */
export function zeroCitationSummaryBody(): RawCitationSummaryResponse {
  return {
    hits: { total: { value: 0 } },
    aggregations: {
      citation_summary: {
        doc_count: 0,
        'h-index': { value: { all: 0, published: 0 } },
        citations: {
          buckets: {
            all: bucketSet(0, 0, null, []),
            published: bucketSet(0, 0, null, []),
          },
        },
      },
    },
  };
}

// ─── Citation export text ───────────────────────────────────────────────────

export const BIBTEX_ENTRIES = [
  '@article{ATLAS:2012yve,\n    author = "Doe, Jane and others",\n    collaboration = "ATLAS",\n    title = "{Observation of a new particle}",\n    journal = "Phys. Lett. B",\n    volume = "716",\n    year = "2012"\n}',
  '@article{Maldacena:1997re,\n    author = "Roe, Richard",\n    title = "{The Large N limit of superconformal field theories and supergravity}",\n    eprint = "hep-th/9711200",\n    year = "1998"\n}',
  '@inproceedings{Doe:2020xyz,\n    author = "Doe, Jane",\n    title = "{Proceedings}",\n    year = "2020"\n}',
] as const;

export const LATEX_EU_ENTRIES = [
  "%\\cite{ATLAS:2012yve}\n\\bibitem{ATLAS:2012yve}\nJ. Doe {\\it et al.} [ATLAS],\n%``Observation of a new particle,''\nPhys. Lett. B \\textbf{716} (2012), 1-29",
  "%\\cite{Maldacena:1997re}\n\\bibitem{Maldacena:1997re}\nR. Roe,\n%``The Large N limit,''\narXiv:hep-th/9711200",
] as const;

/** An export body: entries joined by one blank line, ending in a newline. */
export const exportBody = (entries: readonly string[]) =>
  entries.length ? `${entries.join('\n\n')}\n` : '';

// ─── Error bodies ───────────────────────────────────────────────────────────

export const badRequestBody = (
  message = 'Maximum search page size of `1000` results exceeded.',
) => ({
  message,
  status: 400,
});

export const notFoundBody = () => ({
  message: 'PIDDoesNotExistRESTError: PID does not exist.',
  status: 404,
});

// ─── Responses ──────────────────────────────────────────────────────────────

export const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
  Response.json(body, init);

export const textResponse = (
  body: string,
  contentType = 'application/x-bibtex',
  init: ResponseInit = {},
): Response =>
  new Response(body, {
    ...init,
    headers: {
      'content-type': contentType,
      ...(init.headers as Record<string, string> | undefined),
    },
  });

export const htmlResponse = (
  body = '<html><title>Maintenance</title></html>',
  init: ResponseInit = {},
) => textResponse(body, 'text/html', init);

/** A 429 with an optional `Retry-After`. */
export const rateLimitResponse = (retryAfter?: string): Response =>
  new Response('Too Many Requests', {
    status: 429,
    ...(retryAfter !== undefined && { headers: { 'retry-after': retryAfter } }),
  });
