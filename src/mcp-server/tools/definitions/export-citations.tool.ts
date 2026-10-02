/**
 * @fileoverview cern_inspire_export_citations — INSPIRE-HEP's own BibTeX or
 * LaTeX (`\bibitem`, EU or US style) citation entries for the papers a
 * literature query selects, verbatim and keyed by INSPIRE texkeys.
 * @module mcp-server/tools/definitions/export-citations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset } from '@/mcp-server/tools/inputs.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';
import { callerEcho, fenced, identifier } from '@/utils/render.js';

const FORMATS = ['bibtex', 'latex-eu', 'latex-us'] as const;
const SORTS = ['relevance', 'mostrecent', 'mostcited'] as const;

/** Upper bound on `size`. */
const MAX_ENTRIES = 50;

/** INSPIRE serves at most this many results of one query (`page × size`). */
const RESULT_WINDOW = 10_000;

export const exportCitationsTool = tool('cern_inspire_export_citations', {
  title: 'Export INSPIRE citations',
  description:
    'Export INSPIRE-HEP\'s citation entries for the papers a literature query selects, as BibTeX or LaTeX \\bibitem entries (EU or US style), keyed by INSPIRE texkeys and ready to paste into a bibliography. Name specific papers with "recid:451647 or arxiv:1207.7214 or doi:10.1016/…", or export a topic, author, or citing set with any query cern_inspire_search_literature accepts. Up to 50 entries per page; page through larger sets (only the first 10,000 matches are reachable). Entries are INSPIRE\'s verbatim text (long author lists arrive abbreviated as "First, Name and others").',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .describe(
        'Literature query selecting the papers to cite. Named papers: "recid:451647 or arxiv:1207.7214 or doi:10.1016/j.physletb.2012.08.020". Or any INSPIRE query: a topic ("t higgs and topcite 500+"), an author ("a Edward.Witten.1"), or the papers citing a record ("refersto:recid:451647"). See cern_inspire_list_reference topic search_syntax.',
      ),
    format: blankAsUnset(z.enum(FORMATS).default('bibtex')).describe(
      'Entry format: bibtex (default), latex-eu, or latex-us (\\bibitem entries in European or US style).',
    ),
    sort: blankAsUnset(z.enum(SORTS).default('relevance')).describe(
      'Entry order: relevance (default), mostrecent, or mostcited.',
    ),
    page: blankAsUnset(z.number().int().min(1).default(1)).describe(
      'Page number, starting at 1. page × size may not exceed 10,000.',
    ),
    size: blankAsUnset(z.number().int().min(1).max(MAX_ENTRIES).default(10)).describe(
      'Entries per page (1–50, default 10).',
    ),
  }),
  // The sibling top-N tools (search_authors, search_experiments) call their cap `limit`.
  inputAliases: { limit: 'size' },
  output: z.object({
    format: z.enum(FORMATS).describe('The entry format returned.'),
    page: z.number().describe('The page returned.'),
    entries: z
      .array(
        z
          .object({
            texkey: z
              .string()
              .describe(
                'INSPIRE texkey (the \\cite key), e.g. Maldacena:1997re; empty when INSPIRE gives none.',
              ),
            text: z.string().describe('The entry, verbatim as INSPIRE serves it.'),
          })
          .describe('One citation entry.'),
      )
      .describe('Citation entries, in the requested order.'),
  }),
  enrichment: {
    truncated: z.boolean().describe('True when more matched papers follow this page.'),
    shown: z.number().describe('Number of entries on this page.'),
    cap: z.number().describe('The page size applied.'),
    nextPage: z
      .number()
      .optional()
      .describe(
        'The page number to request next, when more papers follow within the 10,000-result window.',
      ),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when nothing matched, the page is past the last or came back empty inside the match count, more papers follow, or the page could not be checked against the match count.',
      ),
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
        'Narrow the query with tighter terms, such as a date range ("and date > 2015") or a collaboration, until it matches under 10,000 papers, then page again with cern_inspire_export_citations.',
      severity: 'notice',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'INSPIRE answered 400 to a parameter value it refuses.',
      recovery:
        'Check the query against cern_inspire_list_reference topic search_syntax, then retry cern_inspire_export_citations with the corrected query.',
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
      when: 'The INSPIRE body exceeded the byte ceiling, or was JSON or HTML where citation text was expected.',
      recovery:
        'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_export_citations with the same page and size.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.size });

    if (input.page * input.size > RESULT_WINDOW) {
      throw ctx.fail(
        'beyond_result_window',
        `page ${input.page} × size ${input.size} reaches past the first 10,000 results, which is all INSPIRE serves for one query.`,
        { page: input.page, size: input.size },
      );
    }

    const inspire = getInspireService();
    const result = await inspire.exportCitations(
      {
        query: input.query,
        format: input.format,
        sort: input.sort,
        page: input.page,
        size: input.size,
      },
      inspire.beginCall(ctx),
    );
    const shown = result.entries.length;
    ctx.enrich({ shown });
    ctx.log.info('Citation export completed', {
      format: input.format,
      page: input.page,
      shown,
      total: result.total,
      truncated: result.truncated,
    });

    const unchecked = input.page > 1 && result.total === undefined;
    const notices: string[] = [];
    if (shown === 0) {
      notices.push(emptyPageNotice(input, result.total));
    } else if (unchecked) {
      notices.push(
        "INSPIRE's match count could not be read, so this page is unchecked against it: past the last page, INSPIRE can return an entry from an earlier page again (it does for OR queries).",
      );
    }

    if (result.truncated) {
      const nextPage = input.page + 1;
      const reachable = nextPage * input.size <= RESULT_WINDOW;
      if (reachable) ctx.enrich({ nextPage });
      notices.unshift(
        !reachable
          ? 'INSPIRE serves only the first 10,000 results of a query; narrow it with tighter terms, such as a date range or a collaboration, to export the rest.'
          : unchecked
            ? `This page came back full; request page ${nextPage} for any further entries.`
            : `More papers matched; request page ${nextPage} for the next ${input.size}${
                input.page === 1 && input.size < MAX_ENTRIES
                  ? `, or raise size (up to ${MAX_ENTRIES}) to export more per call`
                  : ''
              }.`,
      );
      ctx.enrich.truncated({ shown, cap: input.size, guidance: notices.join(' ') });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }
    return { format: input.format, page: input.page, entries: result.entries };
  },

  format: (result) => {
    const count = result.entries.length;
    const lines = [
      `## INSPIRE citations, page ${result.page} (${result.format}, ${count} ${count === 1 ? 'entry' : 'entries'})`,
    ];
    if (result.entries.length > 0) {
      const keys = result.entries.map((e) => (e.texkey ? identifier(e.texkey) : '(no texkey)'));
      lines.push(
        `**Texkeys:** ${keys.join(', ')}`,
        '',
        fenced(
          result.entries.map((e) => e.text).join('\n\n'),
          result.format === 'bibtex' ? 'bibtex' : 'latex',
        ),
      );
    }
    return [{ type: 'text', text: lines.join('\n') }];
  },
});

/**
 * Why a page holds no entries: nothing matched, the page is past the last, INSPIRE
 * sent nothing for a page inside its own count, or no total was read to tell.
 */
function emptyPageNotice(
  input: { page: number; query: string; size: number },
  total: number | undefined,
): string {
  if (input.page > 1 && total === undefined) {
    return `Page ${input.page} came back empty and INSPIRE's match count could not be read, so either it is past the last page or nothing matched; request page 1 to tell which.`;
  }
  if (total === undefined || total === 0) {
    return `No INSPIRE literature matched "${callerEcho(input.query)}"; find the papers with cern_inspire_search_literature, then export by recid ("recid:N or recid:M").`;
  }
  const lastPage = Math.ceil(total / input.size);
  if ((input.page - 1) * input.size >= total) {
    return `Page ${input.page} is past the last page (${lastPage}); request a lower page.`;
  }
  return `Page ${input.page} came back empty although INSPIRE counts ${total} matches (${lastPage} pages at this size); retry this call in a few seconds.`;
}
