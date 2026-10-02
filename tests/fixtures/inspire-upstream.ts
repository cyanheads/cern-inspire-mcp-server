/**
 * @fileoverview Upstream INSPIRE response bodies in the shapes the design's API
 * Reference records, for service and tool tests. Papers carry real identifiers
 * (recids, arXiv IDs, DOIs); people are synthetic (`Doe, Jane`, `Jane.Doe.1`).
 * Builders take overrides so a test states only what it varies; absent upstream
 * fields stay absent.
 * @module tests/fixtures/inspire-upstream
 */

import type {
  CitationExportFormat,
  RawAuthorMetadata,
  RawCitationBucketSet,
  RawCitationSummaryResponse,
  RawCitationsByYearResponse,
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

/**
 * A HEPData record's DOIs: the record DOI `10.17182/hepdata.<n>`, then for each
 * version its DOI and `tablesPerVersion[k]` table DOIs.
 */
export function hepdataDois(
  hepdataRecid: number,
  tablesPerVersion: readonly number[],
): RawDataDoi[] {
  const record = `10.17182/hepdata.${hepdataRecid}`;
  return [
    { value: record, material: 'data' },
    ...tablesPerVersion.flatMap((tables, k): RawDataDoi[] => [
      { value: `${record}.v${k + 1}`, material: 'version' },
      ...Array.from({ length: tables }, (_, t) => ({
        value: `${record}.v${k + 1}/t${t + 1}`,
        material: 'part',
      })),
    ]),
  ];
}

/** A data record as the availability lookup selects it: `control_number` and `dois` only. */
const availabilityRecord = (
  controlNumber: number,
  hepdataRecid: number,
  tablesPerVersion: readonly number[],
): RawDataMetadata => ({
  control_number: controlNumber,
  dois: hepdataDois(hepdataRecid, tablesPerVersion),
});

/**
 * Papers INSPIRE links to two HEPData records, with each record's data recid,
 * record number, and tables per version as INSPIRE's `data` collection held them
 * on 2026-10-01, in the order its relevance-sorted search returned them (the
 * higher record number first). One record of each was submitted under a recid
 * INSPIRE later merged into the paper.
 */
export const TWO_RECORD_PAPERS = {
  /** 98625 (9 tables) and 156903 (1 table; submitted under 2829718). */
  '1797621': [availabilityRecord(2890786, 156903, [1]), availabilityRecord(2884928, 98625, [9])],
  /** 153717 (v2, 4 tables; submitted under 2814778) and 155498 (4 tables). */
  '2844507': [
    availabilityRecord(2875617, 155498, [4]),
    availabilityRecord(2875618, 153717, [4, 4]),
  ],
};

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

// ─── Citations by year ──────────────────────────────────────────────────────

/**
 * `citations-by-year` facet bodies as INSPIRE returned them on 2026-10-01, byte
 * for byte: the year map arrives unordered, and a year without citations has no key.
 */
export const CAPTURED_SERIES = {
  /** `recid:451647`: 30 years, 1997–2026, summing to the paper's citation_count, 22,635; 2025 → 1,227. */
  paper:
    '{"took":5,"timed_out":false,"_shards":{"total":6,"successful":6,"skipped":0,"failed":0},"hits":{"total":{"value":1,"relation":"eq"},"max_score":null,"hits":[]},"aggregations":{"citations_by_year":{"value":{"2012":813,"2011":863,"2010":878,"1998":493,"2009":798,"1997":11,"2008":823,"2007":676,"2006":613,"2005":479,"2004":488,"2026":881,"2003":428,"2025":1227,"2002":492,"2024":1084,"1999":666,"2001":435,"2023":1006,"2000":554,"2022":971,"2021":865,"2020":961,"2019":913,"2018":903,"2017":856,"2016":928,"2015":885,"2014":837,"2013":808}}}}',
  /** `authors.recid:983868`: 286 records, 71 years, 1956–2026 without a gap, summing to 108,219. */
  multiDecadeAuthor:
    '{"took":33,"timed_out":false,"_shards":{"total":6,"successful":6,"skipped":0,"failed":0},"hits":{"total":{"value":286,"relation":"eq"},"max_score":null,"hits":[]},"aggregations":{"citations_by_year":{"value":{"1976":1032,"1975":953,"1974":1218,"1973":735,"1972":541,"1971":438,"2026":2975,"2025":4237,"1970":513,"2024":4012,"1979":1664,"1978":1507,"1977":1231,"2001":1387,"1990":1217,"2000":1348,"1987":1206,"1986":1204,"1985":1252,"1984":1466,"1983":1564,"1982":1561,"1981":1747,"1980":1745,"1989":1084,"1988":1089,"2012":2757,"2011":2296,"2010":2246,"1998":1512,"2009":2169,"2008":1837,"1997":1316,"1996":1334,"2007":1769,"1995":1330,"2006":1576,"1994":1337,"2005":1494,"1993":1301,"2004":1487,"2003":1434,"1992":1239,"1991":1075,"2002":1406,"1959":12,"1958":5,"1957":1,"1956":2,"1999":1357,"2023":3643,"2022":3672,"2021":3340,"2020":3228,"1965":61,"1964":76,"2019":3096,"1963":32,"2018":3073,"1962":21,"2017":3355,"1961":12,"2016":3244,"1960":16,"2015":3168,"2014":2919,"2013":2878,"1969":535,"1968":379,"1967":186,"1966":67}}}}',
  /** `collaboration:atlas`: 9,817 records, 36 years spanning 1964–2026, none for 1965–1976 or 1978–1992. */
  gapped:
    '{"took":3686,"timed_out":false,"_shards":{"total":6,"successful":6,"skipped":0,"failed":0},"hits":{"total":{"value":9817,"relation":"eq"},"max_score":null,"hits":[]},"aggregations":{"citations_by_year":{"value":{"2012":16629,"2011":7860,"2010":3028,"2009":1566,"1998":240,"1997":133,"2008":1141,"1996":72,"2007":723,"1995":66,"2006":545,"2005":361,"1994":8,"2004":369,"1993":1,"2026":13675,"2025":21218,"2003":318,"2024":23953,"2002":290,"1977":2,"1999":233,"2023":22242,"2001":316,"2022":23429,"2000":285,"2021":21152,"2020":19967,"1964":1,"2019":21877,"2018":22978,"2017":22772,"2016":23310,"2015":22617,"2014":18487,"2013":18786}}}}',
} as const;

/** A `citations-by-year` facet response over `value`, matching `total` records. */
export function citationsByYearBody(
  value: Record<string, unknown>,
  total = 1,
): RawCitationsByYearResponse {
  return { hits: { total: { value: total } }, aggregations: { citations_by_year: { value } } };
}

/** The zero-match series: `value: {}`. */
export const zeroCitationsByYearBody = () => citationsByYearBody({}, 0);

/** A captured body as INSPIRE served it: the exact bytes, as JSON. */
export const capturedResponse = (body: string): Response =>
  new Response(body, { headers: { 'content-type': 'application/json' } });

/** A facet reply: a body sent as JSON, a `Response` (cloned per request), or a responder. */
export type FacetReply = object | Response | ((request: Request) => Response | Promise<Response>);

/**
 * A `/literature/facets` fake answering each request by its `facet_name`:
 * `citation-summary` with `summary` (default {@link citationSummaryBody}),
 * `citations-by-year` with `series` (default the captured multi-decade author).
 * Any other facet name fails the fetch.
 */
export function facetResponder(
  replies: { series?: FacetReply; summary?: FacetReply } = {},
): (request: Request) => Response | Promise<Response> {
  const answer = (reply: FacetReply, request: Request) => {
    if (reply instanceof Response) return reply.clone();
    if (typeof reply === 'function') return reply(request);
    return jsonResponse(reply);
  };
  return (request) => {
    const facet = new URL(request.url).searchParams.get('facet_name');
    if (facet === 'citation-summary')
      return answer(replies.summary ?? citationSummaryBody(), request);
    if (facet === 'citations-by-year') {
      return answer(replies.series ?? capturedResponse(CAPTURED_SERIES.multiDecadeAuthor), request);
    }
    throw new Error(`facetResponder: unexpected facet_name ${facet}`);
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

// ─── Citation export paging ─────────────────────────────────────────────────

/**
 * The texkeys of `citedby:recid:1124337` (the references of the ATLAS Higgs
 * observation) as INSPIRE exported them on 2026-10-01 at size 50, pages 1–3, in
 * default order: 138 papers, the same keys in the same order in bibtex, latex-eu,
 * and latex-us, the last page short (50, 50, 38).
 */
export const HIGGS_REFERENCE_TEXKEYS = `
  ATLAS:2011xed ATLAS:2012rld ATLAS:2011lgt Harlander:2002wh Ravindran:2003um Stewart:2011cf
  Baglio:2010ae Kibble:1967sv Frixione:2002ik deFlorian:2011xf Brein:2003wg Binoth:2008pr
  ATLAS:2011qia Cahn:1983ip Frixione:2005vw Alwall:2007st Cacciari:2007fd ATLAS:2011cia
  Catani:2003zt Bolzoni:2010xr Djouadi:1991tka Martin:2009iq ATLAS:2008xda deFlorian:2012yg
  OPAL:1997zgv ATLAS:2011zja ATLAS:1994vge Nason:2009ai ATLAS:2011evi ATLAS:2011qri ATLAS:2011dwi
  Anastasiou:2008tj ATLAS:2011hga ATLAS:2012tvg ATLAS:2011aa Han:1991ia Dittmar:1996ss
  Dixon:2003yb Campbell:2011bn LEPWorkingGroupforHiggsbosonsearches:2003ing Butterworth:1996zw
  CMS:2011ooa Barr:2009mx Nadolsky:2008zw Beenakker:2002nc Evans:2008zzb Verkerke:2003ir
  Sjostrand:2006za ATLAS:2010arf Anastasiou:2002yz ATLAS:2012ac ATLAS:2012roa Gray:2011us
  ATLAS:2011gmi ATLAS:2012ad ATLAS:2011len ATLAS:2012qaq Mangano:2002ea Kauer:2012hd
  Kunszt:1984ri CDF:2012jmx ATLAS:2012ima Bredenstein:2006ha Binoth:2006mf Aglietti:2004nj
  ATLAS:2012hoa Ellis:1987xu Cranmer:2012sba Cacciari:2011ma Guralnik:1964eu Glashow:1961tr
  Higgs:1964ia ATLAS:2012goa Anastasiou:2012hx Ciccolini:2007jr Campbell:2011cu Campbell:2006xx
  Vesterinen:2008hx ATLAS:2011tau Gaiser:1982yw Frixione:2008yi Georgi:1977gs Frixione:2003ei
  ATLAS:2012gfw ATLAS:2010uco Dawson:2003zu Lai:2010vv tHooft:1972tcz Landau:1948kw Actis:2008ug
  Alwall:2011uj Dawson:1990zj Salam:1968rm Higgs:1964pj Melia:2011tj Ciccolini:2003jy CDF:2012laj
  Gleisberg:2008ta D0:2012jgw Englert:1964et Cacciari:2008gp Sjostrand:2007gs GEANT4:2002zbu
  Dittmaier:2012vm ATLAS:2011jka ATLAS:2012eoa Frixione:2010ra ATLAS:2011krm Glashow:1978ab
  Golonka:2005pn Sherstnev:2007nd Botje:2011sn ATLAS:2012nks Beenakker:2001rj Higgs:1966ev
  Djouadi:1997yw Bagnaschi:2011tu Ciccolini:2007ec Lampl:2008zz Gross:2010qma Spira:1995rr
  Yang:1950rg ATLAS:2012gqy Weinberg:1967tq ATLAS:2012foa Moneta:2010pm ATLAS:2012fcz
  Alioli:2008tz Jadach:1993hs Arnold:2008rz Kersevan:2004yg Dawson:2002tg Ball:2011mu
  Bredenstein:2006rh CMS:2012zhx LHCHiggsCrossSectionWorkingGroup:2011wcg Read:2002hq Cowan:2010js
`
  .trim()
  .split(/\s+/);

/**
 * The whole body INSPIRE answered for page 2 at size 5 of
 * `arxiv:1207.7214 or arxiv:1207.7235` (2 matches) in bibtex on 2026-10-01: one
 * leftover entry, a paper page 1 already held, where a past-the-end page of a
 * single-term query is empty.
 */
export const OR_LEFTOVER_BIBTEX = `@article{CMS:2012qbp,
    author = "Chatrchyan, Serguei and others",
    collaboration = "CMS",
    title = "{Observation of a New Boson at a Mass of 125 GeV with the CMS Experiment at the LHC}",
    eprint = "1207.7235",
    archivePrefix = "arXiv",
    primaryClass = "hep-ex",
    reportNumber = "CMS-HIG-12-028, CERN-PH-EP-2012-220",
    doi = "10.1016/j.physletb.2012.08.021",
    journal = "Phys. Lett. B",
    volume = "716",
    pages = "30--61",
    year = "2012"
}
`;

/** The content type INSPIRE serves each export format with. */
export const EXPORT_CONTENT_TYPES: Record<CitationExportFormat, string> = {
  bibtex: 'application/x-bibtex',
  'latex-eu': 'application/vnd+inspire.latex.eu+x-latex',
  'latex-us': 'application/vnd+inspire.latex.us+x-latex',
};

/** One entry in INSPIRE's shape for `format`, keyed by `texkey`; `n` varies its text. */
export function exportEntry(format: CitationExportFormat, texkey: string, n: number): string {
  if (format === 'bibtex') {
    return `@article{${texkey},\n    author = "Doe, Jane and others",\n    title = "{Measurement ${n}}",\n    journal = "Phys. Lett. B",\n    volume = "716",\n    year = "2012"\n}`;
  }
  const journal =
    format === 'latex-eu'
      ? `Phys. Lett. B \\textbf{716} (2012), ${n}`
      : `Phys. Lett. B \\textbf{716}, ${n} (2012)`;
  return `%\\cite{${texkey}}\n\\bibitem{${texkey}}\nJ.~Doe \\textit{et al.},\n%\`\`Measurement ${n},''\n${journal}\n%${n} citations counted in INSPIRE as of 01 Oct 2026`;
}

/**
 * A fake of INSPIRE's `/literature` paging over the papers `texkeys` names, for
 * both requests an export page can make. An export (`format` set) answers the
 * `size` entries of 1-based `page` in that format, with INSPIRE's 400 when
 * `page × size` passes 10,000; past the last paper it answers an empty body, or
 * with `leftover` the last paper's entry again, as INSPIRE does for an OR query. A
 * JSON search (`fields` set) answers `total` (default: the number of papers) as
 * `hits.total`. Any other request fails the fetch.
 */
export function pagedLiterature(
  texkeys: readonly string[],
  options: { leftover?: boolean; total?: number } = {},
): (request: Request) => Response {
  return (request) => {
    const params = new URL(request.url).searchParams;
    const size = Number(params.get('size'));
    const format = params.get('format') as CitationExportFormat | null;
    if (format) {
      const page = Number(params.get('page') ?? 1);
      if (page * size > 10_000) {
        return jsonResponse(
          badRequestBody(
            'SearchPaginationRESTError: Maximum number of 10000 results have been reached.',
          ),
          { status: 400 },
        );
      }
      const indexes = texkeys.map((_, i) => i).slice((page - 1) * size, page * size);
      const leftover = options.leftover && indexes.length === 0 && texkeys.length > 0;
      const shown = leftover ? [texkeys.length - 1] : indexes;
      return textResponse(
        exportBody(shown.map((i) => exportEntry(format, texkeys[i] as string, i + 1))),
        EXPORT_CONTENT_TYPES[format],
      );
    }
    if (params.get('fields') === 'control_number' && size === 1) {
      const total = options.total ?? texkeys.length;
      return jsonResponse(
        searchBody(total > 0 ? [hit({ control_number: 1 }, '1')] : [], { total }),
      );
    }
    throw new Error(`pagedLiterature: unexpected request ${request.url}`);
  };
}

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

/**
 * INSPIRE's answer to `GET /api/literature/<recid>` for a recid it merged into
 * `survivor` (2829718 → 1797621 on 2026-10-02): a redirect whose `Location` names
 * the surviving record, absolute by default.
 */
export const mergedRecidResponse = (
  survivor: string,
  location = `${INSPIRE_ORIGIN}/api/literature/${survivor}`,
  status = 301,
): Response => new Response(null, { status, headers: { location } });

/** A 429 with an optional `Retry-After`. */
export const rateLimitResponse = (retryAfter?: string): Response =>
  new Response('Too Many Requests', {
    status: 429,
    ...(retryAfter !== undefined && { headers: { 'retry-after': retryAfter } }),
  });
