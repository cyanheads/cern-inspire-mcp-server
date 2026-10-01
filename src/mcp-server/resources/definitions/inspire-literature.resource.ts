/**
 * @fileoverview `inspire://literature/{recid}` — the cern_inspire_get_paper
 * dossier for one INSPIRE-HEP literature record, as JSON, with the default
 * author cap.
 * @module mcp-server/resources/definitions/inspire-literature.resource
 */

import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { paperDossierSchema } from '@/mcp-server/tools/definitions/get-paper.tool.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';

/** The author cap the resource applies: cern_inspire_get_paper's default. */
const RESOURCE_MAX_AUTHORS = 25;

export const inspireLiteratureResource = resource('inspire://literature/{recid}', {
  name: 'inspire_literature',
  title: 'INSPIRE literature record',
  description:
    'One INSPIRE-HEP literature record by recid, as the cern_inspire_get_paper dossier in JSON: title, abstract, authors with affiliations (first 25; authorCount gives the total), publication, identifiers, citation counts, linked experiments, texkeys, and HEPData availability. Use cern_inspire_get_paper to raise the author cap or to look a paper up by arXiv ID or DOI.',
  mimeType: 'application/json',
  params: z.object({
    recid: z
      .string()
      .regex(/^\d{1,9}$/)
      .describe('INSPIRE literature record ID (recid), e.g. 451647.'),
  }),
  output: paperDossierSchema,
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  errors: [
    {
      reason: 'paper_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The recid matches no INSPIRE literature record.',
      recovery:
        'Find the record with cern_inspire_search_literature using title words, an author, or the arXiv number, then call cern_inspire_get_paper with its recid.',
    },
    {
      reason: 'inspire_rate_limited',
      code: JsonRpcErrorCode.RateLimited,
      when: 'INSPIRE returned 429 after the pacer and retries.',
      recovery:
        'Wait the retry-after seconds this error states (at least 5), then read the resource again; INSPIRE allows 15 requests per 5 seconds from one address.',
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'pacer_shed',
      code: JsonRpcErrorCode.RateLimited,
      when: "The server's outbound INSPIRE queue could not start the request within the read's remaining budget.",
      recovery:
        "This server's INSPIRE request queue is saturated; wait the seconds in this error's retryAfter field (about 5 when it is not shown), then read the resource again with fewer cern_inspire calls running in parallel.",
      retryable: true,
      thrownBy: 'service',
    },
    {
      reason: 'upstream_unreadable',
      code: JsonRpcErrorCode.ServiceUnavailable,
      when: 'The INSPIRE body exceeded the byte ceiling, was HTML where JSON was expected, or was invalid JSON.',
      recovery:
        'Read the resource again in a few seconds; if it fails again, read the summary record with cern_inspire_search_literature using query "recid:N".',
      thrownBy: 'service',
    },
  ],

  async handler(params, ctx) {
    const inspire = getInspireService();
    // A body is cached publicly for an hour, so a failed HEPData lookup fails the read instead.
    const lookup = await inspire.getPaper(
      params.recid,
      RESOURCE_MAX_AUTHORS,
      inspire.beginCall(ctx),
      { requireHepdata: true },
    );
    if (!lookup) {
      throw ctx.fail('paper_not_found', `No INSPIRE literature record has recid ${params.recid}.`, {
        recid: params.recid,
      });
    }
    return lookup.paper;
  },
});
