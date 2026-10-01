/**
 * @fileoverview cern_inspire_export_citations — INSPIRE-HEP's own BibTeX or
 * LaTeX (`\bibitem`, EU or US style) citation entries for the papers a
 * literature query selects, verbatim and keyed by INSPIRE texkeys.
 * @module mcp-server/tools/definitions/export-citations.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset } from '@/mcp-server/tools/inputs.js';
import { fenced, inline } from '@/mcp-server/tools/render.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';

const FORMATS = ['bibtex', 'latex-eu', 'latex-us'] as const;
const SORTS = ['relevance', 'mostrecent', 'mostcited'] as const;

/** Upper bound on `size`. */
const MAX_ENTRIES = 50;

export const exportCitationsTool = tool('cern_inspire_export_citations', {
  title: 'Export INSPIRE citations',
  description:
    'Export INSPIRE-HEP\'s citation entries for the papers a literature query selects, as BibTeX or LaTeX \\bibitem entries (EU or US style), keyed by INSPIRE texkeys and ready to paste into a bibliography. Name specific papers with "recid:451647 or arxiv:1207.7214 or doi:10.1016/…", or export a topic, author, or citing set with any query cern_inspire_search_literature accepts. Entries are INSPIRE\'s verbatim text (long author lists arrive abbreviated as "First, Name and others").',
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
    size: blankAsUnset(z.number().int().min(1).max(MAX_ENTRIES).default(10)).describe(
      'Most entries to return (1–50, default 10).',
    ),
  }),
  // The sibling top-N tools (search_authors, search_experiments) call their cap `limit`.
  inputAliases: { limit: 'size' },
  output: z.object({
    format: z.enum(FORMATS).describe('The entry format returned.'),
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
    truncated: z.boolean().describe('True when more papers matched than size.'),
    shown: z.number().describe('Number of entries returned.'),
    cap: z.number().describe('The size cap applied.'),
    notice: z
      .string()
      .optional()
      .describe('Guidance when nothing matched or the export was capped.'),
  },
  errors: [
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
        'Retry this call in a few seconds; if it fails again, retry cern_inspire_export_citations with a smaller size.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.size });

    const inspire = getInspireService();
    const result = await inspire.exportCitations(
      { query: input.query, format: input.format, sort: input.sort, size: input.size },
      inspire.beginCall(ctx),
    );
    const shown = result.entries.length;
    ctx.enrich({ shown });
    ctx.log.info('Citation export completed', {
      format: input.format,
      shown,
      truncated: result.truncated,
    });

    if (shown === 0) {
      ctx.enrich.notice(
        `No INSPIRE literature matched "${inline(input.query)}"; find the papers with cern_inspire_search_literature, then export by recid ("recid:N or recid:M").`,
      );
    } else if (result.truncated) {
      ctx.enrich.truncated({
        shown,
        cap: input.size,
        guidance: `More papers matched than size; raise size (max ${MAX_ENTRIES}), narrow the query, or export by recid.`,
      });
    }
    return { format: input.format, entries: result.entries };
  },

  format: (result) => {
    const lines = [`## INSPIRE citations (${result.format}, ${result.entries.length} entries)`];
    if (result.entries.length > 0) {
      const keys = result.entries.map((e) => (e.texkey ? inline(e.texkey) : '(no texkey)'));
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
