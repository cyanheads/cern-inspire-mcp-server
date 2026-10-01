/**
 * @fileoverview cern_inspire_search_experiments — INSPIRE-HEP experiment,
 * collaboration, and facility records by name or legacy name: accelerator, host
 * institutions, lifecycle dates, paper count, and the literature query that
 * selects each experiment's papers.
 * @module mcp-server/tools/definitions/search-experiments.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset } from '@/mcp-server/tools/inputs.js';
import { inline, printUrl, quote } from '@/mcp-server/tools/render.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';

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
            recid: z.string().optional().describe('INSPIRE institution record ID, when linked.'),
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
        "INSPIRE's stored paper count; it can trail the number of records literatureQuery matches.",
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
      .describe(
        "Literature query selecting this experiment's papers; pass to cern_inspire_search_literature, or as query to cern_inspire_get_citation_summary.",
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
  lines.push(`**Literature query:** ${inline(e.literatureQuery)}`);
  if (e.urls.length > 0) {
    lines.push(
      '**URLs:**',
      ...e.urls.map(
        (u) => `- ${printUrl(u.url)}${u.description ? ` — ${inline(u.description)}` : ''}`,
      ),
    );
  }
  if (e.description) lines.push('**Description:**', quote(e.description));
  return lines;
}

export const searchExperimentsTool = tool('cern_inspire_search_experiments', {
  title: 'Search INSPIRE experiments',
  description:
    "Find experiments, collaborations, and facilities in INSPIRE-HEP (ATLAS, CMS, DUNE, Belle II, …) by name, accelerator, or INSPIRE legacy name (CERN-LHC-CMS); digits alone look up an experiment recid. Each record carries the accelerator, host institutions, collaboration and subgroups, classification, lifecycle dates (proposed, approved, started, completed, ongoing), INSPIRE's paper count, a description, and a literatureQuery to pass to cern_inspire_search_literature or cern_inspire_get_citation_summary for the experiment's papers.",
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
    limit: blankAsUnset(z.number().int().min(1).max(MAX_LIMIT).default(5)).describe(
      `Experiments to return (1–${MAX_LIMIT}, default 5).`,
    ),
  }),
  output: z.object({
    experiments: z
      .array(experimentSchema)
      .describe('Matching experiment records, in INSPIRE relevance order.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total experiment records the query matched.'),
    truncated: z.boolean().describe('True when more records matched than were returned.'),
    shown: z.number().describe('Number of records returned.'),
    cap: z.number().describe('The limit applied.'),
    notice: z.string().optional().describe('Guidance on an empty or capped result.'),
  },
  errors: [
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
        'Retry this call in a few seconds; if it fails again, retry cern_inspire_search_experiments with a smaller limit.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit });
    ctx.enrich.total(0);

    const inspire = getInspireService();
    const result = await inspire.searchExperiments(
      input.query,
      input.limit,
      inspire.beginCall(ctx),
    );
    const shown = result.experiments.length;
    ctx.enrich({ shown });
    ctx.enrich.total(result.total);
    ctx.log.info('Experiment search completed', { total: result.total, shown });

    if (shown === 0) {
      ctx.enrich.notice(
        `No INSPIRE experiment matched "${inline(input.query)}". Try the collaboration's common name or the accelerator (LHC, Tevatron), or search papers with cern_inspire_search_literature using "collaboration:<name>".`,
      );
    } else if (result.total > shown) {
      ctx.enrich.truncated({
        shown,
        cap: input.limit,
        guidance:
          input.limit < MAX_LIMIT
            ? `More experiments matched; raise limit (max ${MAX_LIMIT}) or use a more specific name or legacy name.`
            : 'More experiments matched than the 25 returned; use a more specific name or legacy name.',
      });
    }

    return { experiments: result.experiments };
  },

  format: (result) => {
    const lines = [`## INSPIRE experiments (${result.experiments.length})`];
    result.experiments.forEach((experiment, i) => {
      lines.push('', ...renderExperiment(experiment, i + 1));
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
