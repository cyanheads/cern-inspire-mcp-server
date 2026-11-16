/**
 * @fileoverview cern_inspire_search_authors — one page of INSPIRE-HEP author
 * profiles by name, BAI, ORCID, INSPIRE ID, or author recid: positions,
 * identifiers, advisors, arXiv categories, and the literature query that
 * selects each person's papers. Returns ranked candidates; never auto-picks
 * among namesakes.
 * @module mcp-server/tools/definitions/search-authors.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import {
  authorQueryInput,
  blankAsUnset,
  moreResultsNotice,
  pastLastPageNotice,
  RESULT_WINDOW,
} from '@/mcp-server/tools/inputs.js';
import type { AuthorMatch } from '@/services/inspire/identifiers.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';
import { atLineStart, callerEcho, identifier, inline, printUrl } from '@/utils/render.js';

const MAX_LIMIT = 25;

const positionSchema = z
  .object({
    institution: z.string().describe('Institution name as INSPIRE records it.'),
    rank: z
      .string()
      .optional()
      .describe('Rank or role (e.g. SENIOR, PHD, POSTDOC), when recorded.'),
    startDate: z.string().optional().describe('Start date (YYYY or YYYY-MM), when recorded.'),
    endDate: z.string().optional().describe('End date (YYYY or YYYY-MM), when recorded.'),
    institutionRecid: z
      .string()
      .optional()
      .describe(
        "INSPIRE institution record ID, when the position links one; pass affid:N, N being this ID, as the query of cern_inspire_search_literature or cern_inspire_get_citation_summary for the institution's papers.",
      ),
  })
  .describe('One position held.');

const authorProfileSchema = z
  .object({
    recid: z
      .string()
      .describe('INSPIRE author record ID; pass to cern_inspire_get_citation_summary.'),
    name: z.string().describe('Name as INSPIRE records it, "Last, First".'),
    preferredName: z.string().optional().describe('Preferred display name, when recorded.'),
    bai: z
      .string()
      .optional()
      .describe(
        'INSPIRE BAI (exact, case-sensitive); use in literature queries as "a <BAI>" or pass as author to cern_inspire_get_citation_summary.',
      ),
    orcid: z.string().optional().describe('ORCID iD, when the profile links one.'),
    inspireId: z
      .string()
      .optional()
      .describe('INSPIRE ID (INSPIRE- plus 8 digits), when recorded.'),
    otherIds: z
      .array(
        z
          .object({
            schema: z.string().describe('Identifier scheme (e.g. WIKIPEDIA, TWITTER, SPIRES).'),
            value: z.string().describe('Identifier value in that scheme.'),
          })
          .describe('One further identifier.'),
      )
      .describe('Identifiers beyond BAI, ORCID, and INSPIRE ID.'),
    status: z.string().optional().describe('Career status INSPIRE records (e.g. active, retired).'),
    stub: z
      .boolean()
      .optional()
      .describe('True when the profile is an unclaimed stub generated from paper metadata.'),
    currentPositions: z.array(positionSchema).describe('Positions marked current.'),
    pastPositions: z.array(positionSchema).describe('Earlier positions.'),
    arxivCategories: z
      .array(z.string().describe('arXiv category.'))
      .describe('arXiv categories the person publishes in.'),
    advisors: z
      .array(
        z
          .object({
            name: z.string().describe('Advisor name.'),
            degreeType: z
              .string()
              .optional()
              .describe('Degree supervised (e.g. phd, master), when recorded.'),
            recid: z.string().optional().describe('Advisor author record ID, when linked.'),
          })
          .describe('One advisor.'),
      )
      .describe('Advisors INSPIRE records.'),
    urls: z
      .array(
        z
          .object({
            url: z.string().describe('URL.'),
            description: z.string().optional().describe('Label INSPIRE gives the URL, when any.'),
          })
          .describe('One web link.'),
      )
      .describe('Web links on the profile.'),
    awards: z
      .array(
        z
          .object({
            name: z.string().describe('Award name.'),
            year: z.number().optional().describe('Year awarded, when recorded.'),
          })
          .describe('One award.'),
      )
      .describe('Awards INSPIRE records.'),
    literatureQuery: z
      .string()
      .describe(
        "Literature query selecting this person's papers; pass to cern_inspire_search_literature.",
      ),
  })
  .describe('One matching author profile.');

type AuthorProfileOutput = z.infer<typeof authorProfileSchema>;
type PositionOutput = z.infer<typeof positionSchema>;

/** The route-specific zero-hit fragment (design § search_authors). */
const ZERO_HIT_HINTS: Record<AuthorMatch, string> = {
  name: 'Try "Last, First", fewer name parts, or search papers with cern_inspire_search_literature using "a NAME".',
  bai: "BAIs are exact and case-sensitive, and usually spell out the first name (Jane.Doe.1); search by name to find the profile's BAI.",
  inspire_id: 'INSPIRE IDs are INSPIRE- plus 8 digits; search by name instead.',
  orcid: 'The profile may not have an ORCID linked; search by name instead.',
  recid:
    'Author and literature records are numbered separately, so a paper recid matches no profile; search by name instead.',
};

/** Name parts folded for comparison: accents and case dropped, punctuation splits parts. */
const nameParts = (text: string): string[] =>
  text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Family-name parts shorter than this (`'t`, `de`) don't identify a surname on their own. */
const MIN_SURNAME_PART = 3;

/**
 * True when some profile's family name (its `name` before the comma) appears in
 * the query: as a whole run of the query's name parts, or through any one of its
 * parts at least {@link MIN_SURNAME_PART} long, so `Hooft` finds `'t Hooft` and a
 * two-letter surname still needs the whole run. The match may sit anywhere in the
 * query, since a free-text name arrives as "Last, First", "First Last", or a bare surname.
 */
function carriesQueriedSurname(query: string, authors: readonly { name: string }[]): boolean {
  const queryParts = nameParts(query);
  const queryRun = ` ${queryParts.join(' ')} `;
  return authors.some((a) => {
    const family = nameParts(a.name.split(',')[0] ?? '');
    if (family.length === 0) return false;
    return (
      queryRun.includes(` ${family.join(' ')} `) ||
      family.some((part) => part.length >= MIN_SURNAME_PART && queryParts.includes(part))
    );
  });
}

function renderPosition(p: PositionOutput): string {
  const span =
    p.startDate || p.endDate
      ? `${p.startDate ? inline(p.startDate) : '?'}–${p.endDate ? inline(p.endDate) : ''}`
      : undefined;
  const details = [
    p.rank && inline(p.rank),
    span,
    p.institutionRecid && `institution recid ${p.institutionRecid}`,
  ].filter(Boolean);
  return `- ${atLineStart(inline(p.institution))}${details.length > 0 ? ` (${details.join(' · ')})` : ''}`;
}

function renderAuthor(a: AuthorProfileOutput, position: number): string[] {
  const heading = a.preferredName
    ? `${inline(a.name)} (preferred: ${inline(a.preferredName)})`
    : inline(a.name);
  const lines = [`### ${position}. ${heading || '(unnamed)'}`];

  const ids = [
    `**recid:** ${a.recid}`,
    a.bai && `**BAI:** ${identifier(a.bai)}`,
    a.orcid && `**ORCID:** ${identifier(a.orcid)}`,
    a.inspireId && `**INSPIRE ID:** ${identifier(a.inspireId)}`,
  ].filter(Boolean);
  lines.push(ids.join(' · '));

  const profile = [
    a.status && `**Status:** ${inline(a.status)}`,
    a.stub !== undefined &&
      `**Stub:** ${a.stub ? 'yes (unclaimed profile built from paper metadata)' : 'no'}`,
  ].filter(Boolean);
  if (profile.length > 0) lines.push(profile.join(' · '));
  lines.push(`**Literature query:** \`${a.literatureQuery}\``);

  if (a.currentPositions.length > 0) {
    lines.push('**Current positions:**', ...a.currentPositions.map(renderPosition));
  }
  if (a.pastPositions.length > 0) {
    lines.push('**Past positions:**', ...a.pastPositions.map(renderPosition));
  }
  if (a.arxivCategories.length > 0) {
    lines.push(`**arXiv categories:** ${a.arxivCategories.map(inline).join(', ')}`);
  }
  if (a.advisors.length > 0) {
    lines.push(
      '**Advisors:**',
      ...a.advisors.map((adv) => {
        const details = [
          adv.degreeType && `degree ${inline(adv.degreeType)}`,
          adv.recid && `author recid ${adv.recid}`,
        ].filter(Boolean);
        return `- ${atLineStart(inline(adv.name))}${details.length > 0 ? ` (${details.join(' · ')})` : ''}`;
      }),
    );
  }
  if (a.otherIds.length > 0) {
    lines.push(
      `**Other IDs:** ${a.otherIds.map((id) => `${inline(id.schema)} ${identifier(id.value)}`).join('; ')}`,
    );
  }
  if (a.urls.length > 0) {
    lines.push(
      '**URLs:**',
      ...a.urls.map(
        (u) =>
          `- ${atLineStart(printUrl(u.url))}${u.description ? ` — ${inline(u.description)}` : ''}`,
      ),
    );
  }
  if (a.awards.length > 0) {
    lines.push(
      `**Awards:** ${a.awards.map((aw) => `${inline(aw.name)}${aw.year === undefined ? '' : ` (${aw.year})`}`).join('; ')}`,
    );
  }
  return lines;
}

export const searchAuthorsTool = tool('cern_inspire_search_authors', {
  title: 'Search INSPIRE authors',
  description:
    "Find physicist profiles in INSPIRE-HEP by name, INSPIRE BAI, ORCID, INSPIRE ID, or author recid. Each profile carries its recid, BAI, ORCID, current and past positions, advisors, arXiv categories, links, awards, and a literatureQuery that selects the person's papers in cern_inspire_search_literature. A name returns one page of ranked candidates (a bare surname can match tens of thousands of profiles, and a less-cited namesake can rank first), so confirm the person from positions and categories before passing a bai or recid to cern_inspire_get_citation_summary, and request further pages with page before concluding the person is absent. An identifier matches exactly. Only the first 10,000 results of a query are reachable.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: authorQueryInput,
    page: blankAsUnset(z.number().int().min(1).default(1)).describe(
      'Page number, starting at 1. page × effective limit (after clamping) may not exceed 10,000.',
    ),
    limit: blankAsUnset(z.number().int().min(1).default(5)).describe(
      'Profiles per page (positive integer, default 5; above 25 uses 25).',
    ),
  }),
  output: z.object({
    authors: z
      .array(authorProfileSchema)
      .describe('The profiles on this page, in INSPIRE relevance order.'),
    page: z.number().describe('The page returned.'),
    limit: z.number().describe('The effective limit after clamping: profiles per page.'),
    hasMore: z.boolean().describe('True when INSPIRE has a further page of results.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total author profiles the query matched.'),
    truncated: z.boolean().describe('True when more results exist beyond this page.'),
    shown: z.number().describe('Number of profiles on this page.'),
    cap: z.number().describe('The limit applied.'),
    nextPage: z
      .number()
      .optional()
      .describe(
        'The page number to request next, with the same limit, when one exists within the 10,000-result window.',
      ),
    matchedAs: z
      .string()
      .describe(
        'How the query was read: orcid, inspire_id, bai, or recid (exact identifier match), or name (free-text search).',
      ),
    notice: z.string().optional().describe('Guidance on an empty or paged result.'),
  },
  enrichmentTrailer: {
    nextPage: { label: 'Next page' },
    matchedAs: { label: 'Matched as' },
  },
  errors: [
    {
      reason: 'beyond_result_window',
      code: JsonRpcErrorCode.ValidationError,
      when: 'page × effective limit (after clamping) exceeds the 10,000 results INSPIRE serves for one query.',
      recovery:
        "Pin the person with a BAI, ORCID, or INSPIRE ID (cern_inspire_get_paper lists them for a paper's authors), then retry cern_inspire_search_authors; extra name parts widen a name search, since INSPIRE reads them as initials.",
      severity: 'notice',
    },
    {
      reason: 'invalid_query',
      code: JsonRpcErrorCode.ValidationError,
      when: 'INSPIRE answered 400 to a parameter value it refuses.',
      recovery:
        'Check the name or identifier form against cern_inspire_list_reference topic identifiers, then retry cern_inspire_search_authors.',
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
        'Retry this call in a few seconds; if it fails again, INSPIRE is likely serving an error page, so wait a minute before retrying cern_inspire_search_authors with the same page and limit.',
      thrownBy: 'service',
    },
  ],

  async handler(requested, ctx) {
    const input = { ...requested, limit: Math.min(requested.limit, MAX_LIMIT) };
    const reduction =
      requested.limit > input.limit
        ? `limit ${requested.limit} reduced to ${input.limit}.`
        : undefined;
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit, matchedAs: 'name' });
    ctx.enrich.total(0);

    if (input.page * input.limit > RESULT_WINDOW) {
      throw ctx.fail(
        'beyond_result_window',
        `page ${input.page} × limit ${input.limit} reaches past the first 10,000 results, which is all INSPIRE serves for one query.`,
        { page: input.page, limit: input.limit },
      );
    }

    const inspire = getInspireService();
    const result = await inspire.searchAuthors(
      { query: input.query, page: input.page, size: input.limit },
      inspire.beginCall(ctx),
    );
    const shown = result.authors.length;
    ctx.enrich({ matchedAs: result.matchedAs, shown });
    ctx.enrich.total(result.total);
    ctx.log.info('Author search completed', {
      matchedAs: result.matchedAs,
      total: result.total,
      shown,
      deletedDropped: result.deletedDropped,
      page: input.page,
    });

    const notices: string[] = reduction ? [reduction] : [];
    if (
      result.matchedAs === 'name' &&
      shown > 0 &&
      !carriesQueriedSurname(input.query, result.authors)
    ) {
      // Past page 1 the surname matches may simply have ended, so a miss is no proof of a misspelling.
      notices.push(
        input.page === 1
          ? `No profile on this page has a surname in "${callerEcho(input.query)}"; INSPIRE widened the match by reading name parts as initials, so these may be other people. Check the spelling, or search by BAI or ORCID.`
          : `No profile on this page has a surname in "${callerEcho(input.query)}"; past the profiles that carry the surname, INSPIRE lists ones matched only through name parts read as initials, so these may be other people. If no earlier page listed the surname, check the spelling; to pin one person, search by BAI or ORCID.`,
      );
    }
    if (result.hasMore) {
      const nextPage = input.page + 1;
      const reachable = nextPage * input.limit <= RESULT_WINDOW;
      if (reachable) ctx.enrich({ nextPage });
      notices.push(
        reachable
          ? `${moreResultsNotice(nextPage, 'limit', input.limit)} To pin one person, search by BAI or ORCID.`
          : 'INSPIRE serves only the first 10,000 results of a query; to pin one person, search by BAI or ORCID.',
      );
    }
    if (result.total === 0) {
      notices.push(
        `No INSPIRE author profile matched "${callerEcho(input.query)}" as ${result.matchedAs}.`,
        ZERO_HIT_HINTS[result.matchedAs],
      );
    } else if (shown + result.deletedDropped === 0) {
      // The raw page is empty, deleted profiles included: the page is past the end.
      notices.push(pastLastPageNotice(input.page, result.total, input.limit));
    }
    if (result.deletedDropped > 0) {
      notices.push(
        `${result.deletedDropped} matching profile${result.deletedDropped === 1 ? ' is' : 's are'} marked deleted in INSPIRE and ${result.deletedDropped === 1 ? 'was' : 'were'} dropped from this result.`,
      );
    }

    if (result.hasMore) {
      ctx.enrich.truncated({ shown, cap: input.limit, guidance: notices.join(' ') });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      authors: result.authors,
      page: input.page,
      limit: input.limit,
      hasMore: result.hasMore,
    };
  },

  format: (result) => {
    const lines = [
      `## INSPIRE author profiles, page ${result.page}`,
      `**Page:** ${result.page} · **Limit:** ${result.limit} · **Profiles on this page:** ${result.authors.length} · **More pages:** ${result.hasMore ? 'yes' : 'no'}`,
    ];
    const offset = (result.page - 1) * result.limit;
    result.authors.forEach((author, i) => {
      lines.push('', ...renderAuthor(author, offset + i + 1));
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
