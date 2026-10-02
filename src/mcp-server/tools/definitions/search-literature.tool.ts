/**
 * @fileoverview cern_inspire_search_literature — one page of INSPIRE-HEP
 * literature search results for INSPIRE query syntax or free text, filtered by
 * document type, subject, and year, sorted by relevance, recency, or citations.
 * @module mcp-server/tools/definitions/search-literature.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  blankAsUnset,
  documentTypesInput,
  formatAppliedFilters,
  hasFacetFilters,
  subjectsInput,
  yearFromInput,
  yearToInput,
} from '@/mcp-server/tools/inputs.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';
import type { FacetFilters } from '@/services/inspire/types.js';
import { callerEcho, identifier, inline, quote } from '@/utils/render.js';

/** INSPIRE serves at most this many results of one query (`page × size`). */
const RESULT_WINDOW = 10_000;

/** Above this many matches a query is flagged as possibly mis-parsed (Design Decisions #17). */
const BROAD_MATCH_THRESHOLD = 100_000;

/**
 * INSPIRE's short-form field operators, recognized at the start of a clause; the
 * affiliation ones are every alias INSPIRE's query parser maps to `affiliation`.
 */
const SHORT_OPERATORS = new Set([
  'a',
  'au',
  'author',
  't',
  'ti',
  'title',
  'cn',
  'collaboration',
  'j',
  'journal',
  'd',
  'date',
  'de',
  'topcite',
  'tc',
  'eprint',
  'k',
  'keyword',
  'rn',
  'fa',
  'ac',
  'aff',
  'af',
  'affil',
  'affiliation',
  'inst',
  'institution',
]);

/** Tokens after which a new search clause starts. */
const CLAUSE_LEADERS = new Set(['and', 'or', 'not', 'find', 'f']);

/** A `field:value` token (`refersto:recid:1`, `affiliation-id:902725`), optionally after `(`. */
const FIELD_PREFIX = /^\(*[a-z_.][a-z_.-]*:/i;

/** An author operator (`a`, `au`, `author`, `exactauthor:`). */
const AUTHOR_OPERATOR = /(?:^|[\s(])(?:a|au|author)\s|exactauthor:/i;

/** An INSPIRE BAI-shaped token: `Jane.Doe.1`, `J.Doe.1`. */
const BAI_TOKEN = /[A-Za-z][\w'-]*\.[A-Za-z][\w'-]*\.\d+/;

/** True when the query uses a field operator rather than bare words. */
function hasFieldOperator(query: string): boolean {
  const tokens = query.trim().split(/\s+/);
  return tokens.some((token, i) => {
    if (FIELD_PREFIX.test(token)) return true;
    if (i === tokens.length - 1) return false;
    const clauseStart =
      i === 0 || token.startsWith('(') || CLAUSE_LEADERS.has(tokens[i - 1]?.toLowerCase() ?? '');
    return clauseStart && SHORT_OPERATORS.has(token.replace(/^\(+/, '').toLowerCase());
  });
}

const SORTS = ['relevance', 'mostrecent', 'mostcited'] as const;

const literatureHitSchema = z
  .object({
    recid: z.string().describe('INSPIRE literature record ID; pass to cern_inspire_get_paper.'),
    title: z
      .string()
      .describe(
        'Title as text: publisher HTML, JATS, and MathML converted (scripts as _x or ^{xy}), LaTeX left as published.',
      ),
    firstAuthor: z
      .object({
        name: z.string().describe('First author, "Surname, Given names".'),
        recid: z
          .string()
          .optional()
          .describe(
            'INSPIRE author record ID, when linked; pass as query to cern_inspire_search_authors for the profile.',
          ),
      })
      .optional()
      .describe('First author, when INSPIRE indexes one.'),
    authorCount: z
      .number()
      .optional()
      .describe('Number of authors, when INSPIRE indexes the count.'),
    collaborations: z
      .array(z.string().describe('Collaboration name.'))
      .describe('Collaborations credited on the paper; empty for most non-collaboration papers.'),
    date: z
      .string()
      .optional()
      .describe('Earliest date INSPIRE records for the paper: YYYY, YYYY-MM, or YYYY-MM-DD.'),
    documentTypes: z
      .array(z.string().describe('INSPIRE document type.'))
      .describe('INSPIRE document types.'),
    citationCount: z.number().describe('Citations INSPIRE counts for the paper.'),
    citationCountWithoutSelf: z
      .number()
      .optional()
      .describe('Citations excluding self-citations, when INSPIRE reports it.'),
    arxivId: z.string().optional().describe('arXiv identifier, when the paper has one.'),
    arxivCategories: z
      .array(z.string().describe('arXiv category.'))
      .describe('arXiv categories of the e-print.'),
    doi: z.string().optional().describe('First DOI, when the paper has one.'),
    publication: z
      .string()
      .optional()
      .describe('First publication reference: "Journal Vol (Year) pages" or its free-text form.'),
    abstractSnippet: z
      .string()
      .optional()
      .describe(
        'Start of the abstract as text (arXiv-sourced when available; publisher markup converted, LaTeX left as published), up to 300 characters at a word boundary.',
      ),
    abstractTruncated: z
      .boolean()
      .optional()
      .describe(
        'True when the abstract continues past the snippet; cern_inspire_get_paper has it in full.',
      ),
  })
  .describe('One matching paper.');

type LiteratureHitOutput = z.infer<typeof literatureHitSchema>;

function renderHit(hit: LiteratureHitOutput, position: number): string[] {
  const lines = [`### ${position}. ${inline(hit.title) || '(untitled)'}`];
  const facts = [`**recid:** ${hit.recid}`];
  if (hit.date) facts.push(`**Date:** ${inline(hit.date)}`);
  facts.push(
    `**Citations:** ${hit.citationCount}${
      hit.citationCountWithoutSelf === undefined
        ? ''
        : ` (${hit.citationCountWithoutSelf} without self-citations)`
    }`,
  );
  lines.push(facts.join(' · '));

  const firstAuthor = hit.firstAuthor
    ? `${inline(hit.firstAuthor.name)}${hit.firstAuthor.recid ? ` (author recid ${hit.firstAuthor.recid})` : ''}`
    : 'Not available';
  lines.push(
    `**First author:** ${firstAuthor} · **Authors:** ${hit.authorCount ?? 'Not available'}`,
  );
  if (hit.collaborations.length > 0) {
    lines.push(`**Collaborations:** ${hit.collaborations.map(inline).join(', ')}`);
  }
  if (hit.documentTypes.length > 0) {
    lines.push(`**Document types:** ${hit.documentTypes.map(inline).join(', ')}`);
  }

  const ids: string[] = [];
  if (hit.arxivId) {
    const categories =
      hit.arxivCategories.length > 0 ? ` (${hit.arxivCategories.map(inline).join(', ')})` : '';
    ids.push(`**arXiv:** ${identifier(hit.arxivId)}${categories}`);
  }
  if (hit.doi) ids.push(`**DOI:** ${identifier(hit.doi)}`);
  if (hit.publication) ids.push(`**Publication:** ${inline(hit.publication)}`);
  if (ids.length > 0) lines.push(ids.join(' · '));

  if (hit.abstractSnippet) {
    lines.push(
      hit.abstractTruncated
        ? '**Abstract** (truncated; cern_inspire_get_paper has it in full):'
        : '**Abstract:**',
      quote(hit.abstractSnippet),
    );
  }
  return lines;
}

export const searchLiteratureTool = tool('cern_inspire_search_literature', {
  title: 'Search INSPIRE literature',
  description:
    'Search INSPIRE-HEP papers with INSPIRE query syntax or free text, filtered by document type, subject, and year, sorted by relevance, recency, or citations. Returns one page of papers with recid, title, first author, date, citation counts, arXiv ID, DOI, publication, and an abstract snippet; pass a recid to cern_inspire_get_paper for the full record or to cern_inspire_export_citations ("recid:N") for BibTeX. INSPIRE never rejects malformed syntax: an unparsed operator widens or empties the match, so a very broad or empty result usually means the query needs fixing (cern_inspire_list_reference topic search_syntax). Only the first 10,000 results of a query are reachable.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        'INSPIRE query syntax or free text. Common operators: "a Jane.Doe.1" or "a Doe, J" (author), "t higgs boson" (title words), "cn atlas" or "collaboration:atlas" (collaboration), "date > 2015", "topcite 500+" (cited 500+ times), "refersto:recid:451647" (papers citing a record), "citedby:recid:451647" (its references), "j Phys.Rev.Lett." (journal), "eprint 1207.7214"; combine with and/or/not. Bare words search all fields. INSPIRE does not reject malformed syntax; see cern_inspire_list_reference topic search_syntax for the rest.',
      ),
    sort: blankAsUnset(z.enum(SORTS).default('relevance')).describe(
      'Result order: relevance (default), mostrecent, or mostcited.',
    ),
    document_types: documentTypesInput,
    subjects: subjectsInput,
    year_from: yearFromInput,
    year_to: yearToInput,
    page: blankAsUnset(z.number().int().min(1).default(1)).describe(
      'Page number, starting at 1. page × size may not exceed 10,000.',
    ),
    size: blankAsUnset(z.number().int().min(1).max(100).default(10)).describe(
      'Papers per page (1–100, default 10).',
    ),
  }),
  output: z.object({
    papers: z
      .array(literatureHitSchema)
      .describe('The papers on this page, in the requested order.'),
    page: z.number().describe('The page returned.'),
    size: z.number().describe('The page size requested.'),
    hasMore: z.boolean().describe('True when INSPIRE has a further page of results.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total literature records the query matched.'),
    truncated: z.boolean().describe('True when more results exist beyond this page.'),
    shown: z.number().describe('Number of papers on this page.'),
    cap: z.number().describe('The page size applied.'),
    nextPage: z
      .number()
      .optional()
      .describe(
        'The page number to request next, when one exists within the 10,000-result window.',
      ),
    appliedFilters: z
      .string()
      .describe('Sort and filters applied, e.g. "sort=mostcited; years=2012–2015", or "none".'),
    notice: z.string().optional().describe('Guidance on an empty, very broad, or paged result.'),
  },
  enrichmentTrailer: {
    nextPage: { label: 'Next page' },
    appliedFilters: { label: 'Applied filters' },
  },
  errors: [
    {
      reason: 'beyond_result_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page × size exceeds the 10,000 results INSPIRE serves for one query.',
      recovery:
        'Narrow the query with year_from/year_to, document_types, or tighter terms until it matches under 10,000 records, then page again with cern_inspire_search_literature.',
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
        'Check the query and filters against cern_inspire_list_reference topic search_syntax, then retry cern_inspire_search_literature with corrected values.',
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
        'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_search_literature with the same page and size.',
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
    const appliedFilters = formatAppliedFilters({ sort: input.sort, ...filters });
    ctx.enrich({ truncated: false, shown: 0, cap: input.size, appliedFilters });
    ctx.enrich.total(0);

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
    if (input.page * input.size > RESULT_WINDOW) {
      throw ctx.fail(
        'beyond_result_window',
        `page ${input.page} × size ${input.size} reaches past the first 10,000 results, which is all INSPIRE serves for one query.`,
        { page: input.page, size: input.size },
      );
    }

    const inspire = getInspireService();
    const result = await inspire.searchLiterature(
      { query: input.query, sort: input.sort, page: input.page, size: input.size, ...filters },
      inspire.beginCall(ctx),
    );
    ctx.enrich.total(result.total);
    ctx.enrich({ shown: result.papers.length });
    ctx.log.info('Literature search completed', {
      total: result.total,
      shown: result.papers.length,
      page: input.page,
    });

    const notices: string[] = [];
    if (result.papers.length === 0) {
      notices.push(...zeroHitNotice(input, result.total, filters));
    } else if (result.total > BROAD_MATCH_THRESHOLD) {
      notices.push(
        `This query matched ${result.total.toLocaleString('en-US')} of INSPIRE's ~1.9 M records. INSPIRE does not reject malformed syntax (an unparsed operator widens the match), so check the query against cern_inspire_list_reference topic search_syntax.`,
      );
    }

    if (result.hasMore) {
      const nextPage = input.page + 1;
      const reachable = nextPage * input.size <= RESULT_WINDOW;
      if (reachable) ctx.enrich({ nextPage });
      notices.unshift(
        reachable
          ? `More results: request page ${nextPage} for the next ${input.size}.`
          : 'INSPIRE serves only the first 10,000 results of a query; narrow it with year_from/year_to, document_types, or tighter terms to reach the rest.',
      );
      ctx.enrich.truncated({
        shown: result.papers.length,
        cap: input.size,
        guidance: notices.join(' '),
      });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      papers: result.papers,
      page: input.page,
      size: input.size,
      hasMore: result.hasMore,
    };
  },

  format: (result) => {
    const lines = [
      `## INSPIRE literature, page ${result.page}`,
      `**Page:** ${result.page} · **Size:** ${result.size} · **Papers on this page:** ${result.papers.length} · **More pages:** ${result.hasMore ? 'yes' : 'no'}`,
    ];
    const offset = (result.page - 1) * result.size;
    result.papers.forEach((hit, i) => {
      lines.push('', ...renderHit(hit, offset + i + 1));
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/** The zero-hit notice fragments that hold for this call (design § search_literature). */
function zeroHitNotice(
  input: { page: number; query: string; size: number },
  total: number,
  filters: FacetFilters,
): string[] {
  if (total > 0) {
    return [
      `Page ${input.page} is past the last page (${Math.ceil(total / input.size)}); request a lower page.`,
    ];
  }
  const fragments = [`No INSPIRE literature matched "${callerEcho(input.query)}".`];
  if (hasFacetFilters(filters)) {
    fragments.push(
      `Filters narrowed the set (${formatAppliedFilters(filters)}); drop them to widen — multiple document_types or subjects must all hold.`,
    );
  }
  if (!hasFieldOperator(input.query)) {
    fragments.push(
      'Bare words search all fields; use "t WORDS" for titles or "a NAME" for authors — see cern_inspire_list_reference topic search_syntax.',
    );
  }
  if (AUTHOR_OPERATOR.test(input.query) && BAI_TOKEN.test(input.query)) {
    fragments.push(
      'Author BAIs are exact and case-sensitive, and usually spell out the first name (Jane.Doe.1, not J.Doe.1); resolve the person with cern_inspire_search_authors.',
    );
  }
  return fragments;
}
