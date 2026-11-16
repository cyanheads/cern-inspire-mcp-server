/**
 * @fileoverview cern_inspire_search_experiments — one page of INSPIRE-HEP
 * experiment, collaboration, and facility records by name or legacy name:
 * accelerator, host institutions, lifecycle dates, paper count, and the
 * literature query that selects each experiment's papers.
 * @module mcp-server/tools/definitions/search-experiments.tool
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
import { atLineStart, callerEcho, inline, printUrl, quote } from '@/utils/render.js';

const MAX_LIMIT = 25;

const experimentSchema = z
  .object({
    recid: z.string().describe('INSPIRE experiment record ID.'),
    legacyName: z
      .string()
      .describe('INSPIRE legacy name (e.g. CERN-LHC-ATLAS), the key literatureQuery uses.'),
    name: z.string().optional().describe('Experiment name (e.g. ATLAS), when recorded.'),
    shortName: z.string().optional().describe('Short form of the name, when recorded.'),
    longName: z.string().optional().describe('Full descriptive name, when recorded.'),
    accelerator: z.string().optional().describe('Accelerator the experiment runs at, when any.'),
    institutions: z
      .array(
        z
          .object({
            name: z.string().describe('Institution name.'),
            recid: z
              .string()
              .optional()
              .describe(
                "INSPIRE institution record ID, when linked; pass affid:N, N being this ID, as the query of cern_inspire_search_literature or cern_inspire_get_citation_summary for the institution's papers.",
              ),
          })
          .describe('One host institution.'),
      )
      .describe('Host institutions.'),
    collaboration: z
      .object({
        name: z.string().describe('Collaboration name.'),
        subgroups: z
          .array(z.string().describe('Subgroup name.'))
          .describe('Named subgroups of the collaboration.'),
      })
      .optional()
      .describe('The collaboration running the experiment, when recorded.'),
    classification: z
      .array(z.string().describe('Classification path, e.g. "Collider Experiments|Hadrons|p p".'))
      .describe('INSPIRE classification paths.'),
    projectTypes: z
      .array(z.string().describe('Project type.'))
      .describe('Project types (e.g. experiment, collaboration, accelerator).'),
    dateProposed: z.string().optional().describe('Date proposed, when recorded.'),
    dateApproved: z.string().optional().describe('Date approved, when recorded.'),
    dateStarted: z.string().optional().describe('Date started, when recorded.'),
    dateCompleted: z
      .string()
      .optional()
      .describe('Date completed; omitted while ongoing or when unrecorded.'),
    ongoing: z
      .boolean()
      .optional()
      .describe(
        'True when INSPIRE marks the experiment as still running, false when it records a completion date; omitted when INSPIRE records neither, so the status is unknown.',
      ),
    numberOfPapers: z
      .number()
      .optional()
      .describe(
        "INSPIRE's stored paper count; it can differ from the number of records literatureQuery matches.",
      ),
    description: z.string().optional().describe('Description as INSPIRE records it.'),
    urls: z
      .array(
        z
          .object({
            url: z.string().describe('URL.'),
            description: z.string().optional().describe('Label INSPIRE gives the URL, when any.'),
          })
          .describe('One web link.'),
      )
      .describe('Web links.'),
    nameVariants: z
      .array(z.string().describe('Alternative name.'))
      .describe('Alternative names INSPIRE matches.'),
    core: z.boolean().optional().describe('True when INSPIRE marks the record as core HEP.'),
    literatureQuery: z
      .string()
      .optional()
      .describe(
        "Literature query selecting this experiment's papers; pass to cern_inspire_search_literature, or as query to cern_inspire_get_citation_summary. Absent when the record has no legacy name, or the name holds a quote or backslash that cannot sit inside the query's quoted clause.",
      ),
  })
  .describe('One matching experiment record.');

type ExperimentOutput = z.infer<typeof experimentSchema>;

function renderExperiment(e: ExperimentOutput, position: number): string[] {
  const title = [inline(e.legacyName) || '(no legacy name)', e.name && inline(e.name)]
    .filter(Boolean)
    .join(' — ');
  const lines = [`### ${position}. ${title}`];

  lines.push(
    [
      `**recid:** ${e.recid}`,
      e.shortName && `**Short name:** ${inline(e.shortName)}`,
      e.accelerator && `**Accelerator:** ${inline(e.accelerator)}`,
      e.numberOfPapers !== undefined && `**Papers (INSPIRE count):** ${e.numberOfPapers}`,
      e.core !== undefined && `**Core:** ${e.core ? 'yes' : 'no'}`,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  if (e.longName) lines.push(`**Long name:** ${inline(e.longName)}`);
  if (e.collaboration) {
    const subgroups =
      e.collaboration.subgroups.length > 0
        ? ` (subgroups: ${e.collaboration.subgroups.map(inline).join(', ')})`
        : '';
    lines.push(`**Collaboration:** ${inline(e.collaboration.name)}${subgroups}`);
  }

  const dates = [
    e.dateProposed && `proposed ${inline(e.dateProposed)}`,
    e.dateApproved && `approved ${inline(e.dateApproved)}`,
    e.dateStarted && `started ${inline(e.dateStarted)}`,
    e.dateCompleted && `completed ${inline(e.dateCompleted)}`,
  ].filter(Boolean);
  const ongoing = e.ongoing === undefined ? 'not recorded' : e.ongoing ? 'yes' : 'no';
  lines.push(
    `**Dates:** ${dates.length > 0 ? dates.join(' · ') : 'Not available'} · **Ongoing:** ${ongoing}`,
  );

  if (e.institutions.length > 0) {
    lines.push(
      `**Institutions:** ${e.institutions
        .map((i) => `${inline(i.name)}${i.recid ? ` (institution recid ${i.recid})` : ''}`)
        .join('; ')}`,
    );
  }
  if (e.classification.length > 0) {
    lines.push(`**Classification:** ${e.classification.map(inline).join('; ')}`);
  }
  if (e.projectTypes.length > 0) {
    lines.push(`**Project types:** ${e.projectTypes.map(inline).join(', ')}`);
  }
  if (e.nameVariants.length > 0) {
    lines.push(`**Name variants:** ${e.nameVariants.map(inline).join(', ')}`);
  }
  if (e.literatureQuery) lines.push(`**Literature query:** ${inline(e.literatureQuery)}`);
  if (e.urls.length > 0) {
    lines.push(
      '**URLs:**',
      ...e.urls.map(
        (u) =>
          `- ${atLineStart(printUrl(u.url))}${u.description ? ` — ${inline(u.description)}` : ''}`,
      ),
    );
  }
  if (e.description) lines.push('**Description:**', quote(e.description));
  return lines;
}

export const searchExperimentsTool = tool('cern_inspire_search_experiments', {
  title: 'Search INSPIRE experiments',
  description:
    "Find experiments, collaborations, and facilities in INSPIRE-HEP (ATLAS, CMS, DUNE, Belle II, …) by name, accelerator, or INSPIRE legacy name (CERN-LHC-CMS); digits alone look up an experiment recid. Each record carries the accelerator, host institutions, collaboration and subgroups, classification, lifecycle dates (proposed, approved, started, completed, ongoing), INSPIRE's paper count, a description, and a literatureQuery to pass to cern_inspire_search_literature or cern_inspire_get_citation_summary for the experiment's papers. Returns one page of records; request the next with page and the same limit. Only the first 10,000 results of a query are reachable.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .describe(
        'Experiment, collaboration, accelerator, or facility name (ATLAS, LHCb, Tevatron), an INSPIRE legacy name (CERN-LHC-CMS), or an experiment recid (digits only).',
      ),
    page: blankAsUnset(z.number().int().min(1).default(1)).describe(
      'Page number, starting at 1. page × effective limit (after clamping) may not exceed 10,000.',
    ),
    limit: blankAsUnset(z.number().int().min(1).default(5)).describe(
      'Experiments per page (positive integer, default 5; above 25 uses 25).',
    ),
  }),
  output: z.object({
    experiments: z
      .array(experimentSchema)
      .describe('The experiment records on this page, in INSPIRE relevance order.'),
    page: z.number().describe('The page returned.'),
    limit: z.number().describe('The effective limit after clamping: experiments per page.'),
    hasMore: z.boolean().describe('True when INSPIRE has a further page of results.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total experiment records the query matched.'),
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
        'Narrow the query with a more specific name, legacy name, or accelerator until it matches under 10,000 records, then page again with cern_inspire_search_experiments.',
      severity: 'notice',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'INSPIRE answered 400 to a parameter value it refuses.',
      recovery:
        'Retry cern_inspire_search_experiments with a plain experiment, collaboration, or accelerator name.',
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
        'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_search_experiments with the same page and limit.',
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
    const result = await inspire.searchExperiments(
      { query: input.query, page: input.page, size: input.limit },
      inspire.beginCall(ctx),
    );
    const shown = result.experiments.length;
    ctx.enrich({ shown });
    ctx.enrich.total(result.total);
    ctx.log.info('Experiment search completed', { total: result.total, shown, page: input.page });

    const notices: string[] = reduction ? [reduction] : [];
    if (shown === 0) {
      notices.push(
        result.total > 0
          ? pastLastPageNotice(input.page, result.total, input.limit)
          : isRecid(input.query)
            ? `No INSPIRE experiment record has recid ${input.query}; search by experiment, collaboration, or accelerator name instead.`
            : `No INSPIRE experiment matched "${callerEcho(input.query)}". Try the collaboration's common name or the accelerator (LHC, Tevatron), or search papers with cern_inspire_search_literature using "collaboration:NAME".`,
      );
    }

    if (result.hasMore) {
      const nextPage = input.page + 1;
      const reachable = nextPage * input.limit <= RESULT_WINDOW;
      if (reachable) ctx.enrich({ nextPage });
      notices.unshift(
        reachable
          ? moreResultsNotice(nextPage, 'limit', input.limit)
          : 'INSPIRE serves only the first 10,000 results of a query; narrow it with a more specific name, legacy name, or accelerator to reach the rest.',
      );
      ctx.enrich.truncated({ shown, cap: input.limit, guidance: notices.join(' ') });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      experiments: result.experiments,
      page: input.page,
      limit: input.limit,
      hasMore: result.hasMore,
    };
  },

  format: (result) => {
    const lines = [
      `## INSPIRE experiments, page ${result.page}`,
      `**Page:** ${result.page} · **Limit:** ${result.limit} · **Experiments on this page:** ${result.experiments.length} · **More pages:** ${result.hasMore ? 'yes' : 'no'}`,
    ];
    const offset = (result.page - 1) * result.limit;
    result.experiments.forEach((experiment, i) => {
      lines.push('', ...renderExperiment(experiment, offset + i + 1));
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
