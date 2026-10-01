/**
 * @fileoverview cern_inspire_search_hepdata — one page of HEPData measurement
 * records from INSPIRE's `data` collection, found by physics content (process,
 * observable, energy, collaboration) without knowing the paper. Each hit names
 * its paper recids, HEPData record DOI, latest version, and table count; this
 * path never reads hepdata.net itself.
 * @module mcp-server/tools/definitions/search-hepdata.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset } from '@/mcp-server/tools/inputs.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';
import { inline, printUrl, quote } from '@/utils/render.js';

/** INSPIRE serves at most this many results of one query (`page × size`). */
const RESULT_WINDOW = 10_000;

const SORTS = ['relevance', 'mostrecent'] as const;

const hepdataRecordSchema = z
  .object({
    inspireDataRecid: z
      .string()
      .describe("Record ID of the HEPData entry in INSPIRE's data collection."),
    title: z.string().describe('Title of the HEPData submission (usually the paper title).'),
    paperRecids: z
      .array(z.string().describe('INSPIRE literature record ID.'))
      .describe(
        'Literature records the data belongs to; pass to cern_inspire_get_paper. HEPData addresses the same paper as ins<recid>.',
      ),
    collaborations: z
      .array(z.string().describe('Collaboration name.'))
      .describe('Collaborations credited.'),
    experiments: z
      .array(z.string().describe('INSPIRE experiment legacy name.'))
      .describe('Experiments credited, by INSPIRE legacy name.'),
    keywords: z
      .array(
        z.string().describe('Keyword as INSPIRE stores it, e.g. "cmenergies: 13000.0-13000.0".'),
      )
      .describe('HEPData keywords: reactions, observables, phrases, centre-of-mass energies.'),
    abstractSnippet: z
      .string()
      .optional()
      .describe('Start of the abstract, up to 300 characters at a word boundary.'),
    abstractTruncated: z
      .boolean()
      .optional()
      .describe('True when the abstract continues past the snippet.'),
    recordDoi: z.string().optional().describe('HEPData record DOI; cite it when reusing the data.'),
    hepdataRecid: z
      .string()
      .optional()
      .describe('HEPData record number, parsed from the record DOI.'),
    latestVersion: z.number().optional().describe('Latest HEPData record version.'),
    tableCount: z.number().optional().describe('Number of tables in the latest version.'),
    hepdataUrl: z
      .string()
      .optional()
      .describe('The HEPData record page on hepdata.net, where the table values are read.'),
    created: z.string().optional().describe('Date INSPIRE created the data record.'),
    citationCount: z.number().optional().describe('Citations INSPIRE counts for the data record.'),
  })
  .describe('One matching HEPData record.');

type HepdataRecordOutput = z.infer<typeof hepdataRecordSchema>;

function renderRecord(r: HepdataRecordOutput, position: number): string[] {
  const lines = [`### ${position}. ${inline(r.title) || '(untitled)'}`];
  lines.push(
    [
      `**INSPIRE data recid:** ${r.inspireDataRecid}`,
      r.created && `**Created:** ${inline(r.created)}`,
      r.citationCount !== undefined && `**Citations:** ${r.citationCount}`,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  lines.push(
    `**Paper recids:** ${r.paperRecids.length > 0 ? r.paperRecids.map(inline).join(', ') : 'Not available'}`,
  );
  const credits = [
    r.collaborations.length > 0 && `**Collaborations:** ${r.collaborations.map(inline).join(', ')}`,
    r.experiments.length > 0 && `**Experiments:** ${r.experiments.map(inline).join(', ')}`,
  ].filter(Boolean);
  if (credits.length > 0) lines.push(credits.join(' · '));

  const hepdata = [
    r.recordDoi && `**Record DOI:** ${inline(r.recordDoi)}`,
    r.hepdataRecid && `**HEPData recid:** ${inline(r.hepdataRecid)}`,
    r.latestVersion !== undefined && `**Latest version:** ${r.latestVersion}`,
    r.tableCount !== undefined && `**Tables:** ${r.tableCount}`,
  ].filter(Boolean);
  if (hepdata.length > 0) lines.push(hepdata.join(' · '));
  if (r.hepdataUrl) lines.push(`**Record page:** ${printUrl(r.hepdataUrl)}`);
  if (r.keywords.length > 0) lines.push(`**Keywords:** ${r.keywords.map(inline).join('; ')}`);
  if (r.abstractSnippet) {
    lines.push(
      r.abstractTruncated ? '**Abstract** (truncated):' : '**Abstract:**',
      quote(r.abstractSnippet),
    );
  }
  return lines;
}

export const searchHepdataTool = tool('cern_inspire_search_hepdata', {
  title: 'Search HEPData records',
  description:
    'Find HEPData measurement records by physics content — process, observable, energy, collaboration — when the paper is unknown, through INSPIRE-HEP\'s index of every HEPData submission. Each hit carries the paper recids (pass to cern_inspire_get_paper), collaborations, keywords (reactions such as "P P --> TOP TOPBAR X", observables, centre-of-mass energies), the HEPData record DOI (recordDoi, the citation for the data), latest version, table count, and hepdataUrl, the hepdata.net record page that holds the table values; this tool does not return the values themselves. Only the first 10,000 results of a query are reachable.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        'Free text or INSPIRE syntax over HEPData records, e.g. top pair differential cross section 13 TeV; collaborations.value:LHCb; keywords.value:"Inclusive"; or literature.control_number:<recid> for one paper\'s data. INSPIRE does not reject malformed syntax; see cern_inspire_list_reference topic search_syntax.',
      ),
    sort: blankAsUnset(z.enum(SORTS).default('relevance')).describe(
      'Result order: relevance (default) or mostrecent.',
    ),
    page: blankAsUnset(z.number().int().min(1).default(1)).describe(
      'Page number, starting at 1. page × size may not exceed 10,000.',
    ),
    size: blankAsUnset(z.number().int().min(1).max(50).default(10)).describe(
      'Records per page (1–50, default 10).',
    ),
  }),
  output: z.object({
    records: z
      .array(hepdataRecordSchema)
      .describe('The HEPData records on this page, in the requested order.'),
    page: z.number().describe('The page returned.'),
    size: z.number().describe('The page size requested.'),
    hasMore: z.boolean().describe('True when INSPIRE has a further page of results.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total HEPData records the query matched.'),
    truncated: z.boolean().describe('True when more results exist beyond this page.'),
    shown: z.number().describe('Number of records on this page.'),
    cap: z.number().describe('The page size applied.'),
    nextPage: z
      .number()
      .optional()
      .describe(
        'The page number to request next, when one exists within the 10,000-result window.',
      ),
    notice: z.string().optional().describe('Guidance on an empty or paged result.'),
  },
  enrichmentTrailer: {
    nextPage: { label: 'Next page' },
  },
  errors: [
    {
      reason: 'beyond_result_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page × size exceeds the 10,000 results INSPIRE serves for one query.',
      recovery:
        'Narrow the query with tighter terms, a collaborations.value:<name> clause, or an energy until it matches under 10,000 records, then page again with cern_inspire_search_hepdata.',
      severity: 'notice',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'INSPIRE answered 400 to a parameter value it refuses.',
      recovery:
        'Check the query against cern_inspire_list_reference topic search_syntax, then retry cern_inspire_search_hepdata with corrected values.',
      severity: 'notice',
      thrownBy: 'service',
    },
    {
      reason: 'inspire_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'INSPIRE returned 429 after the pacer and retries.',
      recovery:
        'Wait the retry-after seconds this error states (at least 5), then retry this call; INSPIRE allows 15 requests per 5 seconds from one address.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "The server's outbound INSPIRE queue could not start the request within the call's remaining budget.",
      recovery:
        "This server's INSPIRE request queue is saturated; wait the seconds in this error's retryAfter field (about 5 when it is not shown), then retry this call with fewer cern_inspire calls running in parallel.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The INSPIRE body exceeded the byte ceiling, was HTML where JSON was expected, or was invalid JSON.',
      recovery:
        'Retry this call in a few seconds; if it fails again, retry cern_inspire_search_hepdata with a smaller size.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.size });
    ctx.enrich.total(0);

    if (input.page * input.size > RESULT_WINDOW) {
      throw ctx.fail(
        'beyond_result_window',
        `page ${input.page} × size ${input.size} reaches past the first 10,000 results, which is all INSPIRE serves for one query.`,
        { page: input.page, size: input.size },
      );
    }

    const inspire = getInspireService();
    const result = await inspire.searchHepdata(
      { query: input.query, sort: input.sort, page: input.page, size: input.size },
      inspire.beginCall(ctx),
    );
    ctx.enrich.total(result.total);
    ctx.enrich({ shown: result.records.length });
    ctx.log.info('HEPData search completed', {
      total: result.total,
      shown: result.records.length,
      page: input.page,
    });

    const notices: string[] = [];
    if (result.records.length === 0) {
      notices.push(
        result.total > 0
          ? `Page ${input.page} is past the last page (${Math.ceil(result.total / input.size)}); request a lower page.`
          : `No HEPData record matched "${inline(input.query)}". HEPData keywords use phrases like "Inclusive", "Differential Cross Section", and reactions like "P P --> TOP TOPBAR X"; try fewer words or a collaborations.value:<name> clause, or find the paper with cern_inspire_search_literature.`,
      );
    }

    if (result.hasMore) {
      const nextPage = input.page + 1;
      const reachable = nextPage * input.size <= RESULT_WINDOW;
      if (reachable) ctx.enrich({ nextPage });
      notices.unshift(
        reachable
          ? `More results: request page ${nextPage} for the next ${input.size}.`
          : 'INSPIRE serves only the first 10,000 results of a query; narrow it with tighter terms, a collaboration, or an energy to reach the rest.',
      );
      ctx.enrich.truncated({
        shown: result.records.length,
        cap: input.size,
        guidance: notices.join(' '),
      });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      records: result.records,
      page: input.page,
      size: input.size,
      hasMore: result.hasMore,
    };
  },

  format: (result) => {
    const lines = [
      `## HEPData records, page ${result.page}`,
      `**Page:** ${result.page} · **Size:** ${result.size} · **Records on this page:** ${result.records.length} · **More pages:** ${result.hasMore ? 'yes' : 'no'}`,
    ];
    const offset = (result.page - 1) * result.size;
    result.records.forEach((record, i) => {
      lines.push('', ...renderRecord(record, offset + i + 1));
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
