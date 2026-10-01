/**
 * @fileoverview cern_inspire_get_citation_summary — INSPIRE's citation summary
 * (h-index, citation totals and averages, papers per citation bucket, for all
 * citeable and for published papers) for one author identifier or any
 * literature query, narrowed by document type, subject, and year.
 * @module mcp-server/tools/definitions/get-citation-summary.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  authorIdInput,
  blankAsUnset,
  documentTypesInput,
  formatAppliedFilters,
  subjectsInput,
  yearFromInput,
  yearToInput,
} from '@/mcp-server/tools/inputs.js';
import { cell, inline } from '@/mcp-server/tools/render.js';
import { containsOrcid, routeAuthorQuery } from '@/services/inspire/identifiers.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';
import type { FacetFilters } from '@/services/inspire/types.js';
import { CITATION_BUCKET_RANGES } from '@/services/inspire/vocabulary.js';

const totalsSchema = (scope: string) =>
  z
    .object({
      papers: z.number().describe(`Number of ${scope} papers.`),
      citations: z.number().describe(`Citations to the ${scope} papers.`),
      averageCitations: z
        .number()
        .optional()
        .describe(`Mean citations per ${scope} paper; omitted when there are no papers.`),
    })
    .describe(`Totals over ${scope} papers.`);

const bucketsSchema = (scope: string) =>
  z
    .array(
      z
        .object({
          range: z.enum(CITATION_BUCKET_RANGES).describe('Citation-count range of the bucket.'),
          papers: z.number().describe('Papers whose citation count falls in the range.'),
        })
        .describe('One citation bucket.'),
    )
    .describe(`Papers per citation range, over ${scope} papers.`);

type Totals = z.infer<ReturnType<typeof totalsSchema>>;
type Buckets = z.infer<ReturnType<typeof bucketsSchema>>;

/** A float average shown to two decimals; integers print unchanged. */
const average = (value: number) => Number(value.toFixed(2));

function renderTotals(label: string, t: Totals): string {
  const avg =
    t.averageCitations === undefined
      ? 'Not available (no papers)'
      : String(average(t.averageCitations));
  return `| ${label} | ${t.papers} | ${t.citations} | ${avg} |`;
}

/** One table over both bucket sets, rows in range order (union of both sets' ranges). */
function renderBuckets(all: Buckets, published: Buckets): string[] {
  const ranges = [...new Set([...all, ...published].map((b) => b.range))];
  return [
    '| Citation range | All citeable papers | Published papers |',
    '|:--|--:|--:|',
    ...ranges.map((range) => {
      const a = all.find((b) => b.range === range)?.papers;
      const p = published.find((b) => b.range === range)?.papers;
      return `| ${cell(range)} | ${a ?? '—'} | ${p ?? '—'} |`;
    }),
  ];
}

export const getCitationSummaryTool = tool('cern_inspire_get_citation_summary', {
  title: 'Get INSPIRE citation summary',
  description:
    'Compute INSPIRE-HEP\'s citation summary for one author or for any literature query: h-index, citation totals, average citations per paper, and paper counts per citation bucket (0, 1–9, 10–49, 50–99, 100–249, 250–499, 500+), each for all citeable papers and for published papers. Pass exactly one of author (a BAI, ORCID, INSPIRE ID, or author recid — resolve a name with cern_inspire_search_authors first) or query (any INSPIRE literature query: a topic, collaboration, institution, or "a <BAI>"). Document type, subject, and year filters narrow every figure; exclude_self_citations recounts without self-citations.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    author: authorIdInput,
    query: blankAsUnset(z.string().trim().max(1000).optional()).describe(
      'An INSPIRE literature query, e.g. "collaboration:atlas", "t neutrino oscillation", "a Edward.Witten.1". Literature queries do not match ORCIDs; pass an ORCID as author. Pass this or author, not both.',
    ),
    document_types: documentTypesInput,
    subjects: subjectsInput,
    year_from: yearFromInput,
    year_to: yearToInput,
    exclude_self_citations: blankAsUnset(z.boolean().default(false)).describe(
      "Count citations without self-citations (INSPIRE's definition), default false.",
    ),
  }),
  output: z.object({
    target: z
      .object({
        kind: z
          .enum(['author', 'query'])
          .describe('author when an author identifier was resolved; query for a literature query.'),
        authorRecid: z
          .string()
          .optional()
          .describe('INSPIRE author record ID the identifier resolved to (author target only).'),
        authorName: z
          .string()
          .optional()
          .describe('Name on the resolved author profile (author target only).'),
        query: z
          .string()
          .describe('The literature query summarized ("authors.recid:N" for an author target).'),
      })
      .describe('What the summary covers.'),
    matchedRecords: z.number().describe('Literature records the query matched, citeable or not.'),
    citeablePapers: z.number().describe('Citeable papers among the matched records.'),
    hIndex: z
      .object({
        all: z.number().describe('h-index over all citeable papers.'),
        published: z.number().describe('h-index over published papers.'),
      })
      .describe('h-index for all citeable and for published papers.'),
    all: totalsSchema('citeable'),
    published: totalsSchema('published'),
    buckets: z
      .object({
        all: bucketsSchema('citeable'),
        published: bucketsSchema('published'),
      })
      .describe('Papers per citation range, for all citeable and for published papers.'),
  }),
  enrichment: {
    effectiveQuery: z.string().describe('The literature query sent to INSPIRE.'),
    appliedFilters: z
      .string()
      .describe(
        'Filters applied, e.g. "document_types=published; years=2012–2015; exclude_self_citations=true", or "none".',
      ),
    notice: z.string().optional().describe('Guidance when no citeable paper matched.'),
  },
  enrichmentTrailer: {
    // The caller's query reaches the content[] trailer; inline() keeps a newline in it from forging structure.
    effectiveQuery: { render: (query) => `Query: ${inline(query)}` },
    appliedFilters: { label: 'Applied filters' },
  },
  errors: [
    {
      reason: 'missing_target',
      code: JsonRpcErrorCode.ValidationError,
      when: 'Neither or both of author and query were given.',
      recovery:
        'Pass exactly one of author (a BAI, ORCID, INSPIRE ID, or author recid) or query (an INSPIRE literature query) to cern_inspire_get_citation_summary.',
      severity: 'notice',
    },
    {
      reason: 'author_not_identifier',
      code: JsonRpcErrorCode.ValidationError,
      when: 'author is not a BAI, ORCID, INSPIRE ID, or recid — usually a name.',
      recovery:
        'Resolve the name with cern_inspire_search_authors, then pass the returned bai or recid as author.',
      severity: 'notice',
    },
    {
      reason: 'author_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The author identifier matches no INSPIRE profile.',
      recovery:
        'Resolve the person with cern_inspire_search_authors, then pass the returned bai or recid as author.',
      severity: 'notice',
    },
    {
      reason: 'invalid_year_range',
      code: JsonRpcErrorCode.ValidationError,
      when: 'year_from is later than year_to.',
      recovery:
        'Swap year_from and year_to so the range runs forward, or drop one bound for an open range, then retry this call.',
      severity: 'notice',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'INSPIRE answered 400 to a parameter value it refuses.',
      recovery:
        'Check the query and filters against cern_inspire_list_reference topic search_syntax, then retry cern_inspire_get_citation_summary.',
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
        'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_get_citation_summary.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    const filters: FacetFilters = {
      documentTypes: input.document_types,
      subjects: input.subjects,
      yearFrom: input.year_from,
      yearTo: input.year_to,
    };
    ctx.enrich({
      appliedFilters: formatAppliedFilters({
        ...filters,
        excludeSelfCitations: input.exclude_self_citations,
      }),
    });
    ctx.enrich.echo(input.query || input.author || '');

    if (
      input.year_from !== undefined &&
      input.year_to !== undefined &&
      input.year_from > input.year_to
    ) {
      throw ctx.fail(
        'invalid_year_range',
        `year_from (${input.year_from}) is later than year_to (${input.year_to}).`,
      );
    }
    if (Boolean(input.author) === Boolean(input.query)) {
      throw ctx.fail(
        'missing_target',
        input.author
          ? 'Both author and query were given; pass exactly one.'
          : 'Neither author nor query was given; pass exactly one.',
      );
    }

    const inspire = getInspireService();
    const call = inspire.beginCall(ctx);

    let target: {
      kind: 'author' | 'query';
      authorRecid?: string;
      authorName?: string;
      query: string;
    };
    if (input.author) {
      const route = routeAuthorQuery(input.author);
      if (route.matchedAs === 'name') {
        throw ctx.fail(
          'author_not_identifier',
          `author "${inline(input.author)}" is not a BAI, ORCID, INSPIRE ID, or author recid.`,
          { author: input.author },
        );
      }
      const resolved = await inspire.resolveAuthor(route, call);
      if (!resolved) {
        throw ctx.fail(
          'author_not_found',
          `No INSPIRE author profile matched "${inline(input.author)}" as ${route.matchedAs}.`,
          { author: input.author, matchedAs: route.matchedAs },
        );
      }
      target = {
        kind: 'author',
        authorRecid: resolved.recid,
        ...(resolved.name ? { authorName: resolved.name } : {}),
        query: `authors.recid:${resolved.recid}`,
      };
    } else {
      target = { kind: 'query', query: input.query ?? '' };
    }
    ctx.enrich.echo(target.query);

    const summary = await inspire.getCitationSummary(
      { query: target.query, excludeSelfCitations: input.exclude_self_citations, ...filters },
      call,
    );
    ctx.log.info('Citation summary computed', {
      kind: target.kind,
      matchedRecords: summary.matchedRecords,
      citeablePapers: summary.citeablePapers,
    });

    if (summary.citeablePapers === 0) {
      const notices = [
        'No citeable papers matched; the summary is all zeros. Check the query with cern_inspire_search_literature first.',
      ];
      if (input.query && containsOrcid(input.query)) {
        notices.push('Literature queries do not match ORCIDs; pass the ORCID as author instead.');
      }
      ctx.enrich.notice(notices.join(' '));
    }

    return { target, ...summary };
  },

  format: (result) => {
    const t = result.target;
    const subject =
      t.authorRecid !== undefined || t.authorName !== undefined
        ? `${t.authorName ? inline(t.authorName) : '(unnamed)'}${t.authorRecid ? ` (author recid ${t.authorRecid})` : ''}`
        : undefined;
    const lines = [
      `## INSPIRE citation summary${subject ? ` — ${subject}` : ''}`,
      `**Target kind:** ${t.kind} · **Query:** ${inline(t.query)}`,
      `**Matched records:** ${result.matchedRecords} · **Citeable papers:** ${result.citeablePapers}`,
      `**h-index:** ${result.hIndex.all} (all citeable) · ${result.hIndex.published} (published)`,
      '',
      '| Scope | Papers | Citations | Average citations |',
      '|:--|--:|--:|--:|',
      renderTotals('All citeable', result.all),
      renderTotals('Published', result.published),
    ];
    if (result.buckets.all.length > 0 || result.buckets.published.length > 0) {
      lines.push('', ...renderBuckets(result.buckets.all, result.buckets.published));
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
