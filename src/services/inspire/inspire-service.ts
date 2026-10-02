/**
 * @fileoverview InspireService — every INSPIRE-HEP read the tools and the
 * literature resource make. One outbound pacer (INSPIRE allows 15 requests per
 * 5 s per IP), a retry boundary around fetch + parse, one 55 s budget per tool
 * call threaded through every request in that call, an 8 MiB byte ceiling, and a
 * strict query-parameter allowlist (INSPIRE silently ignores unknown parameters).
 * @module services/inspire/inspire-service
 */

import type { Context } from '@cyanheads/mcp-ts-core';
import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import {
  invalidParams,
  JsonRpcErrorCode,
  McpError,
  rateLimited,
  serviceUnavailable,
  timeout,
  validationError,
} from '@cyanheads/mcp-ts-core/errors';
import { createPacer, type Pacer, withRetry } from '@cyanheads/mcp-ts-core/utils';
import { inline } from '@/utils/render.js';
import { type BoundedResponse, fetchBounded } from '../http/fetch-bounded.js';
import {
  type AuthorRoute,
  classifyPaperId,
  normalizePaperId,
  paperIdKey,
  routeAuthorQuery,
} from './identifiers.js';
import {
  readRecid,
  splitCitationEntries,
  toAuthorProfile,
  toCitationSummary,
  toCitationsByYear,
  toExperimentRecord,
  toHepdataAvailability,
  toHepdataRecord,
  toLiteratureHit,
  toPaperLookup,
} from './normalize.js';
import type {
  AuthorSearchPage,
  CitationExport,
  CitationExportParams,
  CitationSummaryLookup,
  CitationSummaryParams,
  ExperimentSearchPage,
  FacetFilters,
  HepdataAvailability,
  HepdataLookup,
  HepdataSearchPage,
  HepdataSearchParams,
  LiteratureSearchPage,
  LiteratureSearchParams,
  PaperLookup,
  RawAuthorMetadata,
  RawCitationSummaryResponse,
  RawCitationsByYearResponse,
  RawDataMetadata,
  RawExperimentMetadata,
  RawLiteratureMetadata,
  RawSearchEnvelope,
  ResolvedAuthor,
  ResolvedPaper,
  SeriesIgnoredFilter,
} from './types.js';

const ORIGIN = 'https://inspirehep.net';
const BASE_URL = `${ORIGIN}/api`;
const REPO_URL = 'https://github.com/cyanheads/cern-inspire-mcp-server';

/** One budget per tool call, inside a 60 s client timeout. */
export const CALL_BUDGET_MS = 55_000;
const ATTEMPT_TIMEOUT_MS = 15_000;
/** Largest selected response observed: 0.79 MB (2,932 authors with affiliations and ids). */
const MAX_BYTES = 8 * 1024 * 1024;
/** INSPIRE asks for at least 5 s after a 429 when it sends no Retry-After. */
const DEFAULT_RETRY_AFTER_S = 5;
/**
 * The citations-by-year series' own budget: one attempt's timeout. Its time grows
 * with the matched set (0.5 s for an author, 4 s at 10,000 records, 10.5 s at
 * 122,000; 278,875 took 25 s and 644,000 drew a 500 after 30 s) while the summary
 * beside it stays near 0.5 s, so a broad query's series is cut here, not retried.
 */
export const CITATIONS_BY_YEAR_BUDGET_MS = ATTEMPT_TIMEOUT_MS;
/**
 * Past this many matched records INSPIRE takes longer than the series' budget to
 * answer it cold (2026-10-01: 121,921 records in 10.5 s, 149,688 in 16.8 s), so
 * the series is cut early instead of waited on.
 */
export const BROAD_SERIES_RECORDS = 150_000;
/**
 * How long after the facet requests start a broad query's series still may land:
 * INSPIRE answers a series it has cached in 0.2–0.5 s, whatever the matched set.
 */
const BROAD_SERIES_CUT_MS = 2_000;
/** In-flight ceiling of the INSPIRE pacer, which every request shares. */
const INSPIRE_MAX_CONCURRENT = 4;
/**
 * Citations-by-year series in flight at once. A series holds an INSPIRE slot for
 * as long as INSPIRE takes (about 11 s for CERN's ~77,000 records, up to its 15 s
 * budget), so this leaves at least two of the four slots to every other request.
 */
const SERIES_MAX_CONCURRENT = 2;

const LITERATURE_SEARCH_FIELDS = [
  'control_number',
  'titles.title',
  'first_author.full_name',
  'first_author.recid',
  'author_count',
  'collaborations.value',
  'earliest_date',
  'document_type',
  'citation_count',
  'citation_count_without_self_citations',
  'arxiv_eprints',
  'dois.value',
  'publication_info',
  'abstracts.value',
  'abstracts.source',
].join(',');

const PAPER_DOSSIER_FIELDS = [
  'control_number',
  'titles',
  'abstracts',
  'authors.full_name',
  'authors.affiliations.value',
  'authors.record',
  'authors.ids',
  'author_count',
  'collaborations',
  'accelerator_experiments',
  'arxiv_eprints',
  'dois',
  'publication_info',
  'report_numbers',
  'keywords',
  'inspire_categories',
  'document_type',
  'refereed',
  'core',
  'citeable',
  'number_of_pages',
  'earliest_date',
  'preprint_date',
  'imprints',
  'citation_count',
  'citation_count_without_self_citations',
  'texkeys',
  'urls',
  'license',
].join(',');

/** Never includes `email_addresses` — INSPIRE's terms bar collecting them in bulk. */
const AUTHOR_FIELDS = [
  'control_number',
  'name',
  'ids',
  'positions',
  'arxiv_categories',
  'advisors',
  'urls',
  'awards',
  'status',
  'stub',
  'deleted',
].join(',');

const EXPERIMENT_FIELDS = [
  'control_number',
  'legacy_name',
  'experiment',
  'long_name',
  'accelerator',
  'institutions',
  'collaboration',
  'inspire_classification',
  'project_type',
  'date_proposed',
  'date_approved',
  'date_started',
  'date_completed',
  'number_of_papers',
  'description',
  'urls',
  'name_variants',
  'core',
].join(',');

const HEPDATA_SEARCH_FIELDS = [
  'control_number',
  'titles.title',
  'literature.control_number',
  'collaborations.value',
  'accelerator_experiments.legacy_name',
  'keywords.value',
  'abstracts.value',
  'dois.value',
  'dois.material',
  'creation_date',
  'citation_count',
].join(',');

const HEPDATA_AVAILABILITY_FIELDS = 'control_number,dois.value,dois.material';
/**
 * Data records read per paper. No paper links more than 2 of INSPIRE's 11,633
 * (2026-10-01); a paper past this many gets its total in a notice.
 */
const HEPDATA_RECORDS_PER_PAPER = 10;

/** The recid, plus the identifiers a resolve hit is checked against. */
const RESOLVE_FIELDS = 'control_number,dois.value,arxiv_eprints.value';

/** The statuses INSPIRE answers a merged recid's record URL with, pointing at the record it was merged into. */
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
/** Merged-record redirects one paper read follows (each merged recid probed on 2026-10-01 took one). */
const MAX_MERGE_REDIRECTS = 3;

type InspirePath =
  | '/literature'
  | `/literature/${string}`
  | '/literature/facets'
  | '/authors'
  | '/experiments'
  | '/data';

/** Every query parameter INSPIRE is ever sent. Caller keys never reach the URL. */
interface InspireParams {
  doc_type?: readonly string[] | undefined;
  earliest_date?: string | undefined;
  'exclude-self-citations'?: boolean | undefined;
  facet_name?: string | undefined;
  fields?: string | undefined;
  format?: string | undefined;
  page?: number | undefined;
  q?: string | undefined;
  size?: number | undefined;
  sort?: string | undefined;
  subject?: readonly string[] | undefined;
}

const PARAM_NAMES = [
  'q',
  'sort',
  'size',
  'page',
  'fields',
  'format',
  'doc_type',
  'subject',
  'earliest_date',
  'facet_name',
  'exclude-self-citations',
] as const satisfies readonly (keyof InspireParams)[];

function buildUrl(path: InspirePath, params: InspireParams): string {
  const search = new URLSearchParams();
  for (const name of PARAM_NAMES) {
    const value = params[name];
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) search.append(name, item);
    else search.append(name, String(value));
  }
  const query = search.toString();
  return query ? `${BASE_URL}${path}?${query}` : `${BASE_URL}${path}`;
}

/** The facet params a set of filters maps to; `earliest_date` uses open ends (`2012--`, `--1990`). */
function facetParams(filters: FacetFilters): InspireParams {
  const { documentTypes, subjects, yearFrom, yearTo } = filters;
  return {
    ...(documentTypes?.length ? { doc_type: documentTypes } : {}),
    ...(subjects?.length ? { subject: subjects } : {}),
    ...(yearFrom !== undefined || yearTo !== undefined
      ? { earliest_date: `${yearFrom ?? ''}--${yearTo ?? ''}` }
      : {}),
  };
}

/** `relevance` is INSPIRE's default order with a query, so it sends no `sort`. */
const sortParam = (sort: string): string | undefined => (sort === 'relevance' ? undefined : sort);

/** One tool call's view of INSPIRE: its context and the deadline every request in it shares. */
export interface InspireCall {
  readonly ctx: Context;
  /** Epoch ms after which no request in this call may run. */
  readonly deadline: number;
  /** Abandons a request the call no longer needs; `ctx.signal` still cancels it too. */
  readonly signal?: AbortSignal;
}

/** The statuses one request returns to its reader, and whether it follows redirects. */
interface ExchangeOptions {
  accept: readonly number[];
  redirect: NonNullable<RequestInit['redirect']>;
}

/** Every search, facet, and export request: a 200 body, or INSPIRE's 400 or 429 mapped to a reason. */
const SEARCH_EXCHANGE: ExchangeOptions = { accept: [200, 400, 429], redirect: 'follow' };

/** Constructor options; `fetch` and `pacer` are the test seams. */
export interface InspireServiceOptions {
  fetch?: typeof fetch;
  pacer?: Pacer;
  /** The server version, carried in the User-Agent. */
  version: string;
}

const unreadable = (message: string, cause?: unknown) =>
  serviceUnavailable(
    message,
    { reason: 'upstream_unreadable' },
    cause === undefined ? undefined : { cause },
  );

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The Unicode tag block (U+E0000–E007F): invisible characters that can spell out
 * hidden text and have no use in INSPIRE metadata. Dropped from every decoded
 * string, so `structuredContent` never carries them; decoding changes nothing else.
 */
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/gu;

const dropTags = (text: string): string => text.replace(TAG_CHARACTERS, '');

/**
 * Parses a JSON route's body, dropping tag characters from every string value
 * (raw or `\u`-escaped); HTML or invalid JSON is `upstream_unreadable`.
 */
function parseJson(text: string): unknown {
  if (/^\s*</.test(text)) {
    throw unreadable('INSPIRE returned an HTML page where JSON was expected.');
  }
  try {
    return JSON.parse(text, (_key, value: unknown) =>
      typeof value === 'string' ? dropTags(value) : value,
    );
  } catch (err) {
    throw unreadable('INSPIRE returned a body that is not valid JSON.', err);
  }
}

function parseSearchEnvelope<M>(text: string): RawSearchEnvelope<M> {
  const body = parseJson(text);
  if (
    !isRecord(body) ||
    !isRecord(body.hits) ||
    !Array.isArray(body.hits.hits) ||
    typeof body.hits.total !== 'number'
  ) {
    throw unreadable(
      'INSPIRE returned JSON without the expected search envelope (hits.total, hits.hits).',
    );
  }
  return body as unknown as RawSearchEnvelope<M>;
}

function parseCitationSummary(text: string): RawCitationSummaryResponse {
  const body = parseJson(text);
  if (
    !isRecord(body) ||
    !isRecord(body.aggregations) ||
    !isRecord(body.aggregations.citation_summary)
  ) {
    throw unreadable('INSPIRE returned JSON without the citation_summary aggregation.');
  }
  return body as unknown as RawCitationSummaryResponse;
}

function parseCitationsByYear(text: string): RawCitationsByYearResponse {
  const body = parseJson(text);
  if (
    !isRecord(body) ||
    !isRecord(body.aggregations) ||
    !isRecord(body.aggregations.citations_by_year) ||
    !isRecord(body.aggregations.citations_by_year.value)
  ) {
    throw unreadable('INSPIRE returned JSON without the citations_by_year aggregation.');
  }
  return body as unknown as RawCitationsByYearResponse;
}

/** The citation-summary filters the citations-by-year facet ignores (verified 2026-10-01). */
function seriesIgnoredFilters(params: CitationSummaryParams): SeriesIgnoredFilter[] {
  return [
    ...(params.yearFrom !== undefined ? ['yearFrom' as const] : []),
    ...(params.yearTo !== undefined ? ['yearTo' as const] : []),
    ...(params.excludeSelfCitations ? ['excludeSelfCitations' as const] : []),
  ];
}

/**
 * An export body must be BibTeX/LaTeX text, returned with tag characters dropped;
 * JSON or HTML on a 200 is `upstream_unreadable`.
 */
function parseExportText(text: string): string {
  if (/^\s*[{[<]/.test(text)) {
    throw unreadable('INSPIRE returned JSON or HTML where citation text was expected.');
  }
  return dropTags(text);
}

/**
 * INSPIRE's `message` from a 400 body, or the body itself when it is not JSON:
 * tag characters dropped, trimmed, and cut to 300 characters.
 */
function upstreamMessage(text: string): string {
  let message = text;
  try {
    const body: unknown = JSON.parse(text);
    if (isRecord(body) && typeof body.message === 'string') message = body.message;
  } catch {
    // Not JSON — the raw text stands.
  }
  return dropTags(message).trim().slice(0, 300);
}

/** True when a resolve hit lists the requested arXiv ID or DOI among its own. */
function carriesPaperId(
  metadata: RawLiteratureMetadata | undefined,
  kind: 'arxiv' | 'doi',
  id: string,
): boolean {
  const key = paperIdKey(kind, id);
  const carried = kind === 'doi' ? metadata?.dois : metadata?.arxiv_eprints;
  return (carried ?? []).some(
    (entry) => typeof entry.value === 'string' && paperIdKey(kind, entry.value) === key,
  );
}

/**
 * The recid a merged record's redirect names. The `Location` (absolute or
 * relative) must be an INSPIRE literature record URL with a readable recid;
 * anything else is `upstream_unreadable`, and its target is never requested.
 */
function redirectedRecid(location: string | null, recid: string): string {
  const target = location === null ? null : URL.parse(location, `${BASE_URL}/literature/${recid}`);
  const path =
    target?.origin === ORIGIN ? /^\/api\/literature\/(\d+)\/?$/.exec(target.pathname) : null;
  const survivor = readRecid(path?.[1]);
  if (survivor === undefined) {
    throw unreadable(`INSPIRE redirected recid ${recid} somewhere other than a literature record.`);
  }
  return survivor;
}

/** `Retry-After` as seconds (delta-seconds or HTTP-date), else INSPIRE's documented 5 s. */
function retryAfterSeconds(headers: Headers): number {
  const header = headers.get('retry-after')?.trim();
  if (header && /^\d+$/.test(header)) return Number(header);
  const date = header ? Date.parse(header) : Number.NaN;
  if (!Number.isNaN(date)) return Math.max(0, Math.ceil((date - Date.now()) / 1000));
  return DEFAULT_RETRY_AFTER_S;
}

/** HTTP client for INSPIRE-HEP's search endpoints. */
export class InspireService {
  private readonly fetchImpl: typeof fetch;
  private readonly pacer: Pacer;
  /**
   * Admits citations-by-year series to the INSPIRE pacer at most
   * `SERIES_MAX_CONCURRENT` at a time. It sets no rate of its own: each series
   * still starts through `pacer`, which keeps the start rate and the 429 cooldown.
   */
  private readonly seriesGate: Pacer;
  private readonly userAgent: string;

  constructor(options: InspireServiceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.pacer =
      options.pacer ??
      createPacer({
        name: 'inspire',
        limits: [{ requests: 12, perMs: 5_000 }],
        maxConcurrent: INSPIRE_MAX_CONCURRENT,
        cooldown: { baseMs: 5_000, maxMs: 30_000 },
      });
    this.seriesGate = createPacer({
      name: 'inspire-series',
      maxConcurrent: SERIES_MAX_CONCURRENT,
    });
    this.userAgent = `cern-inspire-mcp-server/${options.version} (+${REPO_URL})`;
  }

  /** Opens one tool call's budget; pass the result to every method the call makes. */
  beginCall(ctx: Context, budgetMs = CALL_BUDGET_MS): InspireCall {
    return { ctx, deadline: Date.now() + budgetMs };
  }

  /** Releases both pacers' timers and rejects their queued waiters. */
  dispose(): void {
    this.pacer.dispose();
    this.seriesGate.dispose();
  }

  // ─── Literature ───────────────────────────────────────────────────────────

  /** One page of literature search results. */
  async searchLiterature(
    params: LiteratureSearchParams,
    call: InspireCall,
  ): Promise<LiteratureSearchPage> {
    const envelope = await this.send(
      '/literature',
      {
        q: params.query,
        sort: sortParam(params.sort),
        size: params.size,
        page: params.page,
        fields: LITERATURE_SEARCH_FIELDS,
        ...facetParams(params),
      },
      call,
      'searchLiterature',
      parseSearchEnvelope<RawLiteratureMetadata>,
    );
    return {
      total: envelope.hits.total,
      hasMore: Boolean(envelope.links?.next),
      papers: envelope.hits.hits.map(toLiteratureHit),
    };
  }

  /**
   * Resolves a paper identifier (any form the `paper` input accepts) to a recid.
   * A recid is returned as-is without a request; an arXiv ID or DOI is looked up,
   * and only a hit that carries that identifier itself (with a readable recid)
   * counts, never whatever INSPIRE ranked first. `undefined` when no hit does.
   */
  async resolvePaper(paper: string, call: InspireCall): Promise<ResolvedPaper | undefined> {
    const id = normalizePaperId(paper);
    const kind = classifyPaperId(id);
    if (kind === undefined) {
      throw invalidParams(`"${id}" is not an INSPIRE recid, arXiv ID, or DOI.`, { paper });
    }
    if (kind === 'recid') return { recid: id, resolvedAs: 'recid' };

    const envelope = await this.send(
      '/literature',
      { q: `${kind}:${id}`, fields: RESOLVE_FIELDS, size: 2 },
      call,
      'resolvePaper',
      parseSearchEnvelope<RawLiteratureMetadata>,
    );
    const recids = envelope.hits.hits.flatMap((hit) => {
      const recid = readRecid(hit.metadata?.control_number, hit.id);
      return recid !== undefined && carriesPaperId(hit.metadata, kind, id) ? [recid] : [];
    });
    if (recids.length !== 1 && envelope.hits.hits.length > 0) {
      call.ctx.log.warning('Paper identifier is not carried by exactly one INSPIRE record', {
        paper: id,
        resolvedAs: kind,
        total: envelope.hits.total,
        carriers: recids.length,
      });
    }
    const [recid] = recids;
    return recid === undefined ? undefined : { recid, resolvedAs: kind };
  }

  /**
   * The `get_paper` dossier: resolves the identifier, then reads the record and
   * its HEPData availability in parallel. When the `recid:N` search returns no
   * hit, INSPIRE may have merged the record into another and kept N as a
   * redirect, which its search does not follow: the record URL is asked where N
   * went, and the record and availability are read again for the recid it names
   * (`mergedFrom` then holds N), up to `MAX_MERGE_REDIRECTS` times. `undefined`
   * when the identifier matches no record. A failed availability lookup degrades
   * to `hepdata.status: 'lookup_failed'` — except a cancelled call or an
   * input-class rejection, which rethrow — unless `requireHepdata` is set, when it
   * throws its own error once the record is known to exist. Any failure of the
   * resolve, a record read, or a redirect lookup throws.
   */
  async getPaper(
    paper: string,
    maxAuthors: number,
    call: InspireCall,
    options: { requireHepdata?: boolean } = {},
  ): Promise<PaperLookup | undefined> {
    const resolved = await this.resolvePaper(paper, call);
    if (!resolved) return;

    let recid = resolved.recid;
    for (let redirects = 0; ; redirects++) {
      const [record, availability] = await Promise.allSettled([
        this.send(
          '/literature',
          { q: `recid:${recid}`, fields: PAPER_DOSSIER_FIELDS, size: 1 },
          call,
          'getPaper',
          parseSearchEnvelope<RawLiteratureMetadata>,
        ),
        this.getHepdataAvailability(recid, call),
      ]);
      if (record.status === 'rejected') throw record.reason;
      const [hit] = record.value.hits.hits;
      if (hit) {
        if (!hit.metadata) return;
        const resolution = {
          resolvedAs: resolved.resolvedAs,
          ...(recid === resolved.recid ? {} : { mergedFrom: resolved.recid }),
        };
        if (availability.status === 'rejected') {
          if (options.requireHepdata) throw availability.reason;
          const failed = this.degradeAvailability(availability.reason, recid, call);
          return toPaperLookup(hit.metadata, hit.id, resolution, failed, maxAuthors);
        }
        const { availability: hepdata, recordCount } = availability.value;
        return {
          ...toPaperLookup(hit.metadata, hit.id, resolution, hepdata, maxAuthors),
          hepdataRecordCount: recordCount,
        };
      }
      if (redirects === MAX_MERGE_REDIRECTS) {
        throw unreadable(
          `INSPIRE redirected recid ${resolved.recid} through more than ${MAX_MERGE_REDIRECTS} merged records.`,
        );
      }
      const survivor = await this.mergedInto(recid, call);
      if (survivor === undefined) return;
      recid = survivor;
    }
  }

  /**
   * Where INSPIRE sends a recid its search does not return: `GET
   * /literature/<recid>` with redirects not followed. A merged record answers with
   * a redirect to the record it was merged into, whose recid is returned. A recid
   * INSPIRE does not hold (404) or has deleted (410) gives `undefined`, and so does
   * one it serves (200) although its search returns nothing, which is logged.
   */
  private mergedInto(recid: string, call: InspireCall): Promise<string | undefined> {
    return this.request(
      `/literature/${recid}`,
      {},
      call,
      'followMergedRecid',
      (response) => {
        if (REDIRECT_STATUSES.includes(response.status)) {
          return redirectedRecid(response.headers.get('location'), recid);
        }
        if (response.status === 200) {
          call.ctx.log.warning(
            'INSPIRE serves a recid its search does not return; reporting it as not found',
            { recid },
          );
        }
        return;
      },
      { accept: [200, ...REDIRECT_STATUSES, 404, 410, 429], redirect: 'manual' },
    );
  }

  /**
   * HEPData availability for one paper recid, from INSPIRE's `data` collection:
   * up to `HEPDATA_RECORDS_PER_PAPER` of its data records in one request, and
   * INSPIRE's total.
   */
  async getHepdataAvailability(recid: string, call: InspireCall): Promise<HepdataLookup> {
    const envelope = await this.send(
      '/data',
      {
        q: `literature.control_number:${recid}`,
        fields: HEPDATA_AVAILABILITY_FIELDS,
        size: HEPDATA_RECORDS_PER_PAPER,
      },
      call,
      'getHepdataAvailability',
      parseSearchEnvelope<RawDataMetadata>,
    );
    return {
      availability: toHepdataAvailability(envelope, recid),
      recordCount: envelope.hits.total,
    };
  }

  private degradeAvailability(
    reason: unknown,
    recid: string,
    call: InspireCall,
  ): HepdataAvailability {
    const inputClass =
      reason instanceof McpError &&
      (reason.code === JsonRpcErrorCode.ValidationError ||
        reason.code === JsonRpcErrorCode.InvalidParams);
    if (call.ctx.signal.aborted || inputClass) throw reason;
    call.ctx.log.warning('HEPData availability lookup failed; returning the record without it', {
      recid,
      error: reason instanceof Error ? reason.message : String(reason),
    });
    return { status: 'lookup_failed' };
  }

  /**
   * INSPIRE's citation entries for one page of a literature query. Page 1 is one
   * request for `size + 1` entries, truncated when the extra one came back. A
   * later page cannot carry that probe, since INSPIRE's pages sit `size` apart: it
   * sends `page` and `size` as given, with one `fields=control_number&size=1`
   * search on the same query in parallel for the match total. The total sets
   * `truncated`, and a page at or past it returns no entries, because INSPIRE
   * answers a past-the-end page of an OR query with a leftover entry. A failed
   * total request never fails the page: the page returns as INSPIRE sent it, with
   * no `total`, unless the call was cancelled. Zero matches is an empty body and
   * an empty `entries`.
   */
  async exportCitations(params: CitationExportParams, call: InspireCall): Promise<CitationExport> {
    const exportPage = async (size: number, page?: number) =>
      splitCitationEntries(
        await this.send(
          '/literature',
          { q: params.query, sort: sortParam(params.sort), size, page, format: params.format },
          call,
          'exportCitations',
          parseExportText,
        ),
        params.format,
      );

    if (params.page === 1) {
      const entries = await exportPage(params.size + 1);
      return { entries: entries.slice(0, params.size), truncated: entries.length > params.size };
    }

    const [page, count] = await Promise.allSettled([
      exportPage(params.size, params.page),
      this.send(
        '/literature',
        { q: params.query, fields: 'control_number', size: 1 },
        call,
        'exportCitationsTotal',
        parseSearchEnvelope<RawLiteratureMetadata>,
      ),
    ]);
    if (page.status === 'rejected') throw page.reason;
    if (count.status === 'rejected') {
      if (call.ctx.signal.aborted) throw count.reason;
      call.ctx.log.warning('Citation export total lookup failed; returning the page unchecked', {
        page: params.page,
        error: count.reason instanceof Error ? count.reason.message : String(count.reason),
      });
      return { entries: page.value, truncated: page.value.length === params.size };
    }
    const total = count.value.hits.total;
    const offset = (params.page - 1) * params.size;
    return {
      entries: offset < total ? page.value : [],
      total,
      truncated: offset + params.size < total,
    };
  }

  // ─── Authors ──────────────────────────────────────────────────────────────

  /**
   * Author profiles for a name or identifier (normalize it with
   * `normalizeAuthorId` first). Identifiers route to exact `ids.value:` /
   * `control_number:` queries, anything else to free text. Profiles marked
   * deleted are dropped and counted in `deletedDropped`.
   */
  async searchAuthors(query: string, limit: number, call: InspireCall): Promise<AuthorSearchPage> {
    const route = routeAuthorQuery(query);
    const envelope = await this.send(
      '/authors',
      { q: route.q, fields: AUTHOR_FIELDS, size: limit },
      call,
      'searchAuthors',
      parseSearchEnvelope<RawAuthorMetadata>,
    );
    const live = envelope.hits.hits.filter((hit) => hit.metadata?.deleted !== true);
    return {
      matchedAs: route.matchedAs,
      total: envelope.hits.total,
      authors: live.map(toAuthorProfile),
      deletedDropped: envelope.hits.hits.length - live.length,
    };
  }

  /**
   * Resolves a routed author identifier (`routeAuthorQuery`, never a `name`
   * route) to the profile's recid and name. `undefined` when no profile matches.
   */
  async resolveAuthor(route: AuthorRoute, call: InspireCall): Promise<ResolvedAuthor | undefined> {
    const envelope = await this.send(
      '/authors',
      { q: route.q, fields: 'control_number,name', size: 1 },
      call,
      'resolveAuthor',
      parseSearchEnvelope<RawAuthorMetadata>,
    );
    const hit = envelope.hits.hits[0];
    const recid = readRecid(hit?.metadata?.control_number, hit?.id);
    if (recid === undefined) return;
    return { recid, name: hit?.metadata?.name?.value ?? '' };
  }

  /**
   * INSPIRE's citation summary for a literature query under the given facet
   * filters, and its citations-by-year series. The series facet honors `doc_type`
   * and `subject` but ignores `earliest_date` and `exclude-self-citations`, so with
   * a year bound or the self-citation exclusion set it is not requested (`skipped`,
   * naming those filters). Otherwise both facets are requested in parallel, since
   * one request keeps only its first `facet_name`; the series runs under its own
   * 15 s budget inside the call's. A failure of the summary fails the call and
   * abandons the series. When the summary counts more than `BROAD_SERIES_RECORDS`
   * matches, the series is abandoned `BROAD_SERIES_CUT_MS` after the requests
   * started unless it has landed (`too_broad`). Any other failure of the series
   * returns the summary with the series `failed`; only a cancelled call rethrows.
   */
  async getCitationSummary(
    params: CitationSummaryParams,
    call: InspireCall,
  ): Promise<CitationSummaryLookup> {
    const summaryRequest = () =>
      this.send(
        '/literature/facets',
        {
          q: params.query,
          facet_name: 'citation-summary',
          ...facetParams(params),
          ...(params.excludeSelfCitations ? { 'exclude-self-citations': true } : {}),
        },
        call,
        'getCitationSummary',
        parseCitationSummary,
      );

    const ignoredFilters = seriesIgnoredFilters(params);
    if (ignoredFilters.length > 0) {
      return {
        summary: toCitationSummary(await summaryRequest()),
        series: { status: 'skipped', ignoredFilters },
      };
    }

    const started = Date.now();
    const cut = new AbortController();
    let cutTimer: ReturnType<typeof setTimeout> | undefined;
    const seriesCall: InspireCall = {
      ctx: call.ctx,
      deadline: Math.min(call.deadline, started + CITATIONS_BY_YEAR_BUDGET_MS),
      signal: cut.signal,
    };
    const [summary, series] = await Promise.allSettled([
      summaryRequest().then(
        (raw) => {
          const read = toCitationSummary(raw);
          if (read.matchedRecords > BROAD_SERIES_RECORDS) {
            cutTimer = setTimeout(
              () => cut.abort(),
              Math.max(0, started + BROAD_SERIES_CUT_MS - Date.now()),
            );
          }
          return read;
        },
        (error: unknown) => {
          cut.abort();
          throw error;
        },
      ),
      // Time spent waiting at the gate comes out of the series' own budget.
      this.seriesGate.run(
        () =>
          this.send(
            '/literature/facets',
            {
              q: params.query,
              facet_name: 'citations-by-year',
              ...facetParams({ documentTypes: params.documentTypes, subjects: params.subjects }),
            },
            seriesCall,
            'getCitationsByYear',
            parseCitationsByYear,
          ),
        {
          signal: AbortSignal.any([call.ctx.signal, cut.signal]),
          maxWaitMs: Math.max(0, seriesCall.deadline - started),
        },
      ),
    ]);
    clearTimeout(cutTimer);
    if (summary.status === 'rejected') throw summary.reason;
    if (series.status === 'rejected') {
      if (call.ctx.signal.aborted) throw series.reason;
      if (cut.signal.aborted) {
        call.ctx.log.info('Citations-by-year request cut: the query matches too many records', {
          query: params.query,
          matchedRecords: summary.value.matchedRecords,
        });
        return { summary: summary.value, series: { status: 'too_broad' } };
      }
      call.ctx.log.warning('Citations-by-year request failed; returning the summary without it', {
        query: params.query,
        error: series.reason instanceof Error ? series.reason.message : String(series.reason),
      });
      return { summary: summary.value, series: { status: 'failed' } };
    }
    return {
      summary: summary.value,
      series: { status: 'read', rows: toCitationsByYear(series.value) },
    };
  }

  // ─── Experiments ──────────────────────────────────────────────────────────

  /**
   * Experiments, collaborations, and facilities by free text; a query of digits
   * only is a recid (`control_number:<n>` — digits as free text match nothing).
   */
  async searchExperiments(
    query: string,
    limit: number,
    call: InspireCall,
  ): Promise<ExperimentSearchPage> {
    const envelope = await this.send(
      '/experiments',
      {
        q: /^\d{1,9}$/.test(query) ? `control_number:${query}` : query,
        fields: EXPERIMENT_FIELDS,
        size: limit,
      },
      call,
      'searchExperiments',
      parseSearchEnvelope<RawExperimentMetadata>,
    );
    return { total: envelope.hits.total, experiments: envelope.hits.hits.map(toExperimentRecord) };
  }

  // ─── HEPData index (INSPIRE `data` collection) ─────────────────────────────

  /** One page of HEPData records from INSPIRE's `data` collection. */
  async searchHepdata(params: HepdataSearchParams, call: InspireCall): Promise<HepdataSearchPage> {
    const envelope = await this.send(
      '/data',
      {
        q: params.query,
        sort: sortParam(params.sort),
        size: params.size,
        page: params.page,
        fields: HEPDATA_SEARCH_FIELDS,
      },
      call,
      'searchHepdata',
      parseSearchEnvelope<RawDataMetadata>,
    );
    return {
      total: envelope.hits.total,
      hasMore: Boolean(envelope.links?.next),
      records: envelope.hits.hits.map(toHepdataRecord),
    };
  }

  // ─── Transport ────────────────────────────────────────────────────────────

  /** One INSPIRE request whose body `parse` reads; see {@link InspireService.request}. */
  private send<T>(
    path: InspirePath,
    params: InspireParams,
    call: InspireCall,
    operation: string,
    parse: (text: string) => T,
  ): Promise<T> {
    return this.request(path, params, call, operation, (response) => parse(response.text));
  }

  /**
   * One INSPIRE request inside the call's budget: retry (outside) around the
   * pacer (inside) around fetch + status mapping, with `read` inside the retry
   * so an unreadable response is retried like a failed fetch. `exchange` sets the
   * statuses returned to `read` and whether redirects are followed.
   */
  private request<T>(
    path: InspirePath,
    params: InspireParams,
    call: InspireCall,
    operation: string,
    read: (response: BoundedResponse) => T,
    exchange: ExchangeOptions = SEARCH_EXCHANGE,
  ): Promise<T> {
    const remainingMs = call.deadline - Date.now();
    if (remainingMs <= 0) {
      return Promise.reject(
        timeout(
          `This call's ${CALL_BUDGET_MS / 1000} s budget ran out before INSPIRE could be queried.`,
          {
            operation,
          },
        ),
      );
    }
    const url = buildUrl(path, params);
    // The context binds its own `operation`, which would replace this one under the same key.
    call.ctx.log.debug('INSPIRE request', { inspireOperation: operation, path });
    return withRetry(
      async (attempt) => {
        const response = await this.pacer.run(
          (signal) => this.exchange(url, signal, call.deadline, exchange),
          {
            signal: attempt.signal,
            maxWaitMs: attempt.remainingMs,
          },
        );
        return read(response);
      },
      {
        operation: `InspireService.${operation}`,
        context: call.ctx,
        // An abandoned request is a caller abort to withRetry: no retry, and the pacer frees its slot.
        signal: call.signal ? AbortSignal.any([call.ctx.signal, call.signal]) : call.ctx.signal,
        deadlineMs: remainingMs,
        maxRetries: 2,
        baseDelayMs: 1_000,
      },
    );
  }

  /** One HTTP exchange; maps INSPIRE's 400 and 429 onto the shared contract reasons. */
  private async exchange(
    url: string,
    signal: AbortSignal,
    deadline: number,
    { accept, redirect }: ExchangeOptions,
  ): Promise<BoundedResponse> {
    const response = await fetchBounded(url, {
      accept,
      fetch: this.fetchImpl,
      headers: { 'User-Agent': this.userAgent },
      maxBytes: MAX_BYTES,
      redirect,
      service: 'INSPIRE',
      signal,
      timeoutMs: Math.max(1, Math.min(ATTEMPT_TIMEOUT_MS, deadline - Date.now())),
    });
    if (response.status === 400) {
      const message = upstreamMessage(response.text);
      // The error text reaches content[]: one line, with markup and invisible characters neutralized.
      throw validationError(
        `INSPIRE rejected the request: ${inline(message).replace(/\s+/g, ' ')}`,
        {
          reason: 'invalid_query',
          upstreamMessage: message,
        },
      );
    }
    if (response.status === 429) {
      const retryAfter = retryAfterSeconds(response.headers);
      throw rateLimited(
        `INSPIRE rate limit reached (15 requests per 5 s per address); retry after ${retryAfter} s.`,
        {
          reason: 'inspire_rate_limited',
          retryAfter,
        },
      );
    }
    return response;
  }
}

// ─── Init / accessor ────────────────────────────────────────────────────────

let _service: InspireService | undefined;

/** Constructs the service; called from `createApp`'s `setup()`. */
export function initInspireService(config: AppConfig): void {
  _service = new InspireService({ version: config.mcpServerVersion });
}

/** The initialized service. Throws when `initInspireService()` has not run. */
export function getInspireService(): InspireService {
  if (!_service) {
    throw new Error('InspireService not initialized — call initInspireService() in setup()');
  }
  return _service;
}

/** Disposes the service's pacers; called from `createApp`'s `teardown()`. */
export function disposeInspireService(): void {
  _service?.dispose();
  _service = undefined;
}
