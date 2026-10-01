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
  CitationSummary,
  CitationSummaryParams,
  ExperimentSearchPage,
  FacetFilters,
  HepdataAvailability,
  HepdataSearchPage,
  HepdataSearchParams,
  LiteratureSearchPage,
  LiteratureSearchParams,
  PaperLookup,
  RawAuthorMetadata,
  RawCitationSummaryResponse,
  RawDataMetadata,
  RawExperimentMetadata,
  RawLiteratureMetadata,
  RawSearchEnvelope,
  ResolvedAuthor,
  ResolvedPaper,
} from './types.js';

const BASE_URL = 'https://inspirehep.net/api';
const REPO_URL = 'https://github.com/cyanheads/cern-inspire-mcp-server';

/** One budget per tool call, inside a 60 s client timeout. */
export const CALL_BUDGET_MS = 55_000;
const ATTEMPT_TIMEOUT_MS = 15_000;
/** Largest selected response observed: 0.79 MB (2,932 authors with affiliations and ids). */
const MAX_BYTES = 8 * 1024 * 1024;
/** INSPIRE asks for at least 5 s after a 429 when it sends no Retry-After. */
const DEFAULT_RETRY_AFTER_S = 5;

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

/** The recid, plus the identifiers a resolve hit is checked against. */
const RESOLVE_FIELDS = 'control_number,dois.value,arxiv_eprints.value';

type InspirePath = '/literature' | '/literature/facets' | '/authors' | '/experiments' | '/data';

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
  return `${BASE_URL}${path}?${search}`;
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
}

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
 * string, so `structuredContent` never carries them; other text stays as received.
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
  private readonly userAgent: string;

  constructor(options: InspireServiceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.pacer =
      options.pacer ??
      createPacer({
        name: 'inspire',
        limits: [{ requests: 12, perMs: 5_000 }],
        maxConcurrent: 4,
        cooldown: { baseMs: 5_000, maxMs: 30_000 },
      });
    this.userAgent = `cern-inspire-mcp-server/${options.version} (+${REPO_URL})`;
  }

  /** Opens one tool call's budget; pass the result to every method the call makes. */
  beginCall(ctx: Context, budgetMs = CALL_BUDGET_MS): InspireCall {
    return { ctx, deadline: Date.now() + budgetMs };
  }

  /** Releases the pacer's timer and rejects queued waiters. */
  dispose(): void {
    this.pacer.dispose();
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
   * its HEPData availability in parallel. `undefined` when the identifier matches
   * no record. A failed availability lookup degrades to `hepdata.status:
   * 'lookup_failed'` — except a cancelled call or an input-class rejection, which
   * rethrow — unless `requireHepdata` is set, when it throws its own error once the
   * record is known to exist. Any failure of the resolve or the record read throws.
   */
  async getPaper(
    paper: string,
    maxAuthors: number,
    call: InspireCall,
    options: { requireHepdata?: boolean } = {},
  ): Promise<PaperLookup | undefined> {
    const resolved = await this.resolvePaper(paper, call);
    if (!resolved) return;

    const [record, availability] = await Promise.allSettled([
      this.send(
        '/literature',
        { q: `recid:${resolved.recid}`, fields: PAPER_DOSSIER_FIELDS, size: 1 },
        call,
        'getPaper',
        parseSearchEnvelope<RawLiteratureMetadata>,
      ),
      this.getHepdataAvailability(resolved.recid, call),
    ]);
    if (record.status === 'rejected') throw record.reason;
    const hit = record.value.hits.hits[0];
    if (!hit?.metadata) return;
    if (availability.status === 'rejected' && options.requireHepdata) throw availability.reason;

    const hepdata: HepdataAvailability =
      availability.status === 'fulfilled'
        ? availability.value
        : this.degradeAvailability(availability.reason, resolved.recid, call);
    return toPaperLookup(hit.metadata, hit.id, resolved.resolvedAs, hepdata, maxAuthors);
  }

  /** HEPData availability for one paper recid, from INSPIRE's `data` collection. */
  async getHepdataAvailability(recid: string, call: InspireCall): Promise<HepdataAvailability> {
    const envelope = await this.send(
      '/data',
      { q: `literature.control_number:${recid}`, fields: HEPDATA_AVAILABILITY_FIELDS, size: 1 },
      call,
      'getHepdataAvailability',
      parseSearchEnvelope<RawDataMetadata>,
    );
    return toHepdataAvailability(envelope, recid);
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
   * INSPIRE's citation entries for a literature query. Requests `size + 1`
   * entries; `truncated` is true when the extra one came back. Zero matches is an
   * empty body and an empty `entries`.
   */
  async exportCitations(params: CitationExportParams, call: InspireCall): Promise<CitationExport> {
    const text = await this.send(
      '/literature',
      {
        q: params.query,
        sort: sortParam(params.sort),
        size: params.size + 1,
        format: params.format,
      },
      call,
      'exportCitations',
      parseExportText,
    );
    const entries = splitCitationEntries(text, params.format);
    return { entries: entries.slice(0, params.size), truncated: entries.length > params.size };
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

  /** INSPIRE's citation summary for a literature query under the given facet filters. */
  async getCitationSummary(
    params: CitationSummaryParams,
    call: InspireCall,
  ): Promise<CitationSummary> {
    const body = await this.send(
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
    return toCitationSummary(body);
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

  /**
   * One INSPIRE request inside the call's budget: retry (outside) around the
   * pacer (inside) around fetch + status mapping, with `parse` inside the retry
   * so an unreadable body is retried like a failed fetch.
   */
  private send<T>(
    path: InspirePath,
    params: InspireParams,
    call: InspireCall,
    operation: string,
    parse: (text: string) => T,
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
    call.ctx.log.debug('INSPIRE request', { operation, path });
    return withRetry(
      async (attempt) => {
        const response = await this.pacer.run(
          (signal) => this.exchange(url, signal, call.deadline),
          {
            signal: attempt.signal,
            maxWaitMs: attempt.remainingMs,
          },
        );
        return parse(response.text);
      },
      {
        operation: `InspireService.${operation}`,
        context: call.ctx,
        signal: call.ctx.signal,
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
  ): Promise<BoundedResponse> {
    const response = await fetchBounded(url, {
      accept: [200, 400, 429],
      fetch: this.fetchImpl,
      headers: { 'User-Agent': this.userAgent },
      maxBytes: MAX_BYTES,
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

/** Disposes the service's pacer; called from `createApp`'s `teardown()`. */
export function disposeInspireService(): void {
  _service?.dispose();
  _service = undefined;
}
