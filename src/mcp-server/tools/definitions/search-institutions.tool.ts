/**
 * @fileoverview cern_inspire_search_institutions — one page of INSPIRE-HEP
 * institution records by name words, an exact recorded name (`legacy_ICN`), or
 * recid: the recorded name, hierarchy, types, location, paper count, related
 * records, and the `affid:N` literature query that selects each record's papers.
 * @module mcp-server/tools/definitions/search-institutions.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  blankAsUnset,
  moreResultsNotice,
  pastLastPageNotice,
  RESULT_WINDOW,
} from '@/mcp-server/tools/inputs.js';
import { isRecid } from '@/services/inspire/identifiers.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';
import { callerEcho, inline } from '@/utils/render.js';

/** Also the default: a university's main and physics records can sit 20 rows apart. */
const MAX_LIMIT = 25;

const institutionSchema = z
  .object({
    recid: z.string().describe('INSPIRE institution record ID.'),
    legacyIcn: z
      .string()
      .optional()
      .describe(
        'The institution name INSPIRE records on papers (e.g. Tokyo U.): the name paper affiliations carry and aff NAME matches; legacy_ICN:"NAME" as the query finds this record exactly. Absent when not recorded.',
      ),
    hierarchy: z
      .array(
        z
          .object({
            name: z.string().optional().describe('Unit name, when recorded.'),
            acronym: z.string().optional().describe('Unit acronym, when recorded.'),
          })
          .describe('One level: a name, an acronym, or both.'),
      )
      .describe(
        'The unit this record represents, then each parent, most specific first (a department, then its university).',
      ),
    institutionTypes: z
      .array(z.string().describe('Institution type.'))
      .describe('Institution types (University, Research Center, Company, Other).'),
    cities: z
      .array(z.string().describe('City.'))
      .describe("Cities across the record's addresses, primary address first."),
    countryCodes: z
      .array(z.string().describe('Country code.'))
      .describe("Country codes across the record's addresses, primary address first."),
    numberOfPapers: z
      .number()
      .optional()
      .describe(
        "INSPIRE's stored paper count; it can differ from the number of records literatureQuery matches.",
      ),
    relatedRecords: z
      .array(
        z
          .object({
            recid: z.string().describe('INSPIRE institution record ID of the related record.'),
            relation: z
              .string()
              .optional()
              .describe(
                "parent: the related record is this one's parent institution (a department's university); successor: this institution has become the related one; predecessor: the related one has become this institution. Absent when INSPIRE records none of these.",
              ),
          })
          .describe('One linked institution record.'),
      )
      .describe('Linked institution records: parents, successors, and predecessors.'),
    inactive: z
      .boolean()
      .optional()
      .describe(
        'True when INSPIRE marks the institution as no longer active; omitted when INSPIRE records nothing.',
      ),
    literatureQuery: z
      .string()
      .describe(
        "affid:N, selecting the papers linked to this record; pass to cern_inspire_search_literature, or as query to cern_inspire_get_citation_summary. It matches this record only: join a department's and its parent's with or (affid:903338 or affid:945165).",
      ),
  })
  .describe('One matching institution record.');

type InstitutionOutput = z.infer<typeof institutionSchema>;

const renderLevel = (level: InstitutionOutput['hierarchy'][number]): string =>
  level.name && level.acronym
    ? `${inline(level.name)} (${inline(level.acronym)})`
    : inline(level.name ?? level.acronym ?? '');

function renderInstitution(i: InstitutionOutput, position: number): string[] {
  const lines = [`### ${position}. ${i.legacyIcn ? inline(i.legacyIcn) : '(no recorded name)'}`];

  lines.push(
    [
      `**recid:** ${i.recid}`,
      i.numberOfPapers !== undefined && `**Papers (INSPIRE count):** ${i.numberOfPapers}`,
      i.inactive !== undefined && `**Inactive:** ${i.inactive ? 'yes' : 'no'}`,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  if (i.hierarchy.length > 0) {
    lines.push(`**Hierarchy (most specific first):** ${i.hierarchy.map(renderLevel).join('; ')}`);
  }
  if (i.institutionTypes.length > 0) {
    lines.push(`**Types:** ${i.institutionTypes.map(inline).join(', ')}`);
  }
  const location = [
    i.cities.length > 0 && `**Cities:** ${i.cities.map(inline).join(', ')}`,
    i.countryCodes.length > 0 && `**Country codes:** ${i.countryCodes.map(inline).join(', ')}`,
  ].filter(Boolean);
  if (location.length > 0) lines.push(location.join(' · '));
  if (i.relatedRecords.length > 0) {
    lines.push(
      `**Related institution recids:** ${i.relatedRecords
        .map((r) =>
          r.relation ? `${inline(r.relation)} ${r.recid}` : `${r.recid} (no relation type)`,
        )
        .join('; ')}`,
    );
  }
  lines.push(`**Literature query:** ${inline(i.literatureQuery)}`);
  return lines;
}

export const searchInstitutionsTool = tool('cern_inspire_search_institutions', {
  title: 'Search INSPIRE institutions',
  description:
    'Find institutions in INSPIRE-HEP (universities, departments, laboratories) by name words, an exact recorded name, or recid, for the recid that affid:N takes. Free text (University of Washington, Tokyo) returns candidates in INSPIRE\'s order, not by size: a university\'s papers often sit under department records whose parent is its "(main)" record, so pick from each record\'s hierarchy, paper count, and related records, and page on before concluding a unit is absent. legacy_ICN:"NAME" matches one recorded name exactly and case-sensitively (legacy_ICN:"Tokyo U."), the form cern_inspire_get_paper lists in authors[].affiliations; digits alone look up a recid. Each record carries that recorded name (legacyIcn, which aff NAME matches), hierarchy, institution types, cities, country codes, INSPIRE\'s paper count, parent, successor, and predecessor links, inactive status, and a literatureQuery (affid:N) for cern_inspire_search_literature or cern_inspire_get_citation_summary. affid:N matches one record; join several with or. Returns one page of records; request the next with page and the same limit. Only the first 10,000 results of a query are reachable.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        'Institution name words (University of Washington, Tokyo); one exact recorded name as legacy_ICN:"NAME" (case-sensitive, e.g. legacy_ICN:"Tokyo U."; legacy_ICN clauses joined with or match nothing); or an institution recid (digits only).',
      ),
    page: blankAsUnset(z.number().int().min(1).default(1)).describe(
      'Page number, starting at 1. page × effective limit (after clamping) may not exceed 10,000.',
    ),
    limit: blankAsUnset(z.number().int().min(1).default(MAX_LIMIT)).describe(
      'Institutions per page (positive integer, default 25; above 25 uses 25).',
    ),
  }),
  output: z.object({
    institutions: z
      .array(institutionSchema)
      .describe('The institution records on this page, in INSPIRE order.'),
    page: z.number().describe('The page returned.'),
    limit: z.number().describe('The effective limit after clamping: institutions per page.'),
    hasMore: z.boolean().describe('True when INSPIRE has a further page of results.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total institution records the query matched.'),
    truncated: z.boolean().describe('True when more results exist beyond this page.'),
    shown: z.number().describe('Number of records on this page.'),
    cap: z.number().describe('The limit applied.'),
    nextPage: z
      .number()
      .optional()
      .describe(
        'The page number to request next, with the same limit, when one exists within the 10,000-result window.',
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
      when: 'page × effective limit (after clamping) exceeds the 10,000 results INSPIRE serves for one query.',
      recovery:
        'Narrow the query with more name words, the city, or the exact legacy_ICN:"NAME" form until it matches under 10,000 records, then page again with cern_inspire_search_institutions.',
      severity: 'notice',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'INSPIRE answered 400 to a parameter value it refuses.',
      recovery:
        'Retry cern_inspire_search_institutions with plain institution name words, or one legacy_ICN:"NAME" clause with the name in double quotes.',
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
        'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_search_institutions with the same page and limit.',
      thrownBy: 'service',
    },
  ],

  async handler(requested, ctx) {
    const input = { ...requested, limit: Math.min(requested.limit, MAX_LIMIT) };
    const reduction =
      requested.limit > input.limit
        ? `limit ${requested.limit} reduced to ${input.limit}.`
        : undefined;
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit });
    ctx.enrich.total(0);

    if (input.page * input.limit > RESULT_WINDOW) {
      throw ctx.fail(
        'beyond_result_window',
        `page ${input.page} × limit ${input.limit} reaches past the first 10,000 results, which is all INSPIRE serves for one query.`,
        { page: input.page, limit: input.limit },
      );
    }

    const inspire = getInspireService();
    const result = await inspire.searchInstitutions(
      { query: input.query, page: input.page, size: input.limit },
      inspire.beginCall(ctx),
    );
    const shown = result.institutions.length;
    ctx.enrich({ shown });
    ctx.enrich.total(result.total);
    ctx.log.info('Institution search completed', { total: result.total, shown, page: input.page });

    const notices: string[] = reduction ? [reduction] : [];
    if (shown === 0) {
      notices.push(
        result.total > 0
          ? pastLastPageNotice(input.page, result.total, input.limit)
          : isRecid(input.query)
            ? `No INSPIRE institution record has recid ${input.query}; search by name words or by legacy_ICN:"NAME" instead.`
            : `No INSPIRE institution matched "${callerEcho(input.query)}". Try fewer name words or the city; legacy_ICN:"NAME" matches one recorded name exactly, case and punctuation included, as a paper's author affiliations list it in cern_inspire_get_paper.`,
      );
    }

    if (result.hasMore) {
      const nextPage = input.page + 1;
      const reachable = nextPage * input.limit <= RESULT_WINDOW;
      if (reachable) ctx.enrich({ nextPage });
      notices.unshift(
        reachable
          ? moreResultsNotice(nextPage, 'limit', input.limit)
          : 'INSPIRE serves only the first 10,000 results of a query; narrow it with more name words, the city, or the exact legacy_ICN:"NAME" form to reach the rest.',
      );
      ctx.enrich.truncated({ shown, cap: input.limit, guidance: notices.join(' ') });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      institutions: result.institutions,
      page: input.page,
      limit: input.limit,
      hasMore: result.hasMore,
    };
  },

  format: (result) => {
    const lines = [
      `## INSPIRE institutions, page ${result.page}`,
      `**Page:** ${result.page} · **Limit:** ${result.limit} · **Institutions on this page:** ${result.institutions.length} · **More pages:** ${result.hasMore ? 'yes' : 'no'}`,
    ];
    const offset = (result.page - 1) * result.limit;
    result.institutions.forEach((institution, i) => {
      lines.push('', ...renderInstitution(institution, offset + i + 1));
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
