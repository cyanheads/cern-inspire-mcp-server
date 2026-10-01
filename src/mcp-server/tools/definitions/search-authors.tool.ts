/**
 * @fileoverview cern_inspire_search_authors — INSPIRE-HEP author profiles by
 * name, BAI, ORCID, INSPIRE ID, or author recid: positions, identifiers,
 * advisors, arXiv categories, and the literature query that selects each
 * person's papers. Returns ranked candidates; never auto-picks among namesakes.
 * @module mcp-server/tools/definitions/search-authors.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { authorQueryInput, blankAsUnset } from '@/mcp-server/tools/inputs.js';
import { inline, printUrl } from '@/mcp-server/tools/render.js';
import type { AuthorMatch } from '@/services/inspire/identifiers.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';

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
      .describe('INSPIRE institution record ID, when the position links one.'),
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
  name: 'Try "Last, First", fewer name parts, or search papers with cern_inspire_search_literature using "a <name>".',
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

/**
 * True when some profile's family name (its `name` before the comma) appears as
 * a run of the query's name parts. The run may sit anywhere in the query, since
 * a free-text name arrives as "Last, First", "First Last", or a bare surname.
 */
function carriesQueriedSurname(query: string, authors: readonly { name: string }[]): boolean {
  const queryParts = nameParts(query).join(' ');
  return authors.some((a) => {
    const family = nameParts(a.name.split(',')[0] ?? '').join(' ');
    return family !== '' && ` ${queryParts} `.includes(` ${family} `);
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
  return `- ${inline(p.institution)}${details.length > 0 ? ` (${details.join(' · ')})` : ''}`;
}

function renderAuthor(a: AuthorProfileOutput, position: number): string[] {
  const heading = a.preferredName
    ? `${inline(a.name)} (preferred: ${inline(a.preferredName)})`
    : inline(a.name);
  const lines = [`### ${position}. ${heading || '(unnamed)'}`];

  const ids = [
    `**recid:** ${a.recid}`,
    a.bai && `**BAI:** ${inline(a.bai)}`,
    a.orcid && `**ORCID:** ${inline(a.orcid)}`,
    a.inspireId && `**INSPIRE ID:** ${inline(a.inspireId)}`,
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
        return `- ${inline(adv.name)}${details.length > 0 ? ` (${details.join(' · ')})` : ''}`;
      }),
    );
  }
  if (a.otherIds.length > 0) {
    lines.push(
      `**Other IDs:** ${a.otherIds.map((id) => `${inline(id.schema)} ${inline(id.value)}`).join('; ')}`,
    );
  }
  if (a.urls.length > 0) {
    lines.push(
      '**URLs:**',
      ...a.urls.map(
        (u) => `- ${printUrl(u.url)}${u.description ? ` — ${inline(u.description)}` : ''}`,
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
    "Find physicist profiles in INSPIRE-HEP by name, INSPIRE BAI, ORCID, INSPIRE ID, or author recid. Each profile carries its recid, BAI, ORCID, current and past positions, advisors, arXiv categories, links, awards, and a literatureQuery that selects the person's papers in cern_inspire_search_literature. A name returns ranked candidates (a bare surname can match tens of thousands of profiles, and a less-cited namesake can rank first), so confirm the person from positions and categories before passing a bai or recid to cern_inspire_get_citation_summary. An identifier matches exactly.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    query: authorQueryInput,
    limit: blankAsUnset(z.number().int().min(1).max(MAX_LIMIT).default(5)).describe(
      `Profiles to return (1–${MAX_LIMIT}, default 5).`,
    ),
  }),
  output: z.object({
    authors: z
      .array(authorProfileSchema)
      .describe('Matching profiles, in INSPIRE relevance order.'),
  }),
  enrichment: {
    totalCount: z.number().describe('Total author profiles the query matched.'),
    truncated: z.boolean().describe('True when more profiles matched than were returned.'),
    shown: z.number().describe('Number of profiles returned.'),
    cap: z.number().describe('The limit applied.'),
    matchedAs: z
      .string()
      .describe(
        'How the query was read: orcid, inspire_id, bai, or recid (exact identifier match), or name (free-text search).',
      ),
    notice: z.string().optional().describe('Guidance on an empty or capped result.'),
  },
  enrichmentTrailer: {
    matchedAs: { label: 'Matched as' },
  },
  errors: [
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
        'Retry this call in a few seconds; if it fails again, retry cern_inspire_search_authors with a smaller limit.',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.limit, matchedAs: 'name' });
    ctx.enrich.total(0);

    const inspire = getInspireService();
    const result = await inspire.searchAuthors(input.query, input.limit, inspire.beginCall(ctx));
    const shown = result.authors.length;
    ctx.enrich({ matchedAs: result.matchedAs, shown });
    ctx.enrich.total(result.total);
    ctx.log.info('Author search completed', {
      matchedAs: result.matchedAs,
      total: result.total,
      shown,
      deletedDropped: result.deletedDropped,
    });

    const notices: string[] = [];
    if (result.total === 0) {
      notices.push(
        `No INSPIRE author profile matched "${inline(input.query)}" as ${result.matchedAs}.`,
        ZERO_HIT_HINTS[result.matchedAs],
      );
    }
    if (result.deletedDropped > 0) {
      notices.push(
        `${result.deletedDropped} matching profile${result.deletedDropped === 1 ? ' is' : 's are'} marked deleted in INSPIRE and ${result.deletedDropped === 1 ? 'was' : 'were'} dropped from this result.`,
      );
    }

    const truncated = result.total > shown + result.deletedDropped;
    if (truncated) {
      notices.unshift(
        input.limit < MAX_LIMIT
          ? `More profiles matched; raise limit (max ${MAX_LIMIT}), add name parts, or search by BAI or ORCID to pin one person.`
          : 'More profiles matched than the 25 returned; add name parts, or search by BAI or ORCID to pin one person.',
      );
    }
    if (
      result.matchedAs === 'name' &&
      shown > 0 &&
      !carriesQueriedSurname(input.query, result.authors)
    ) {
      notices.unshift(
        `No profile on this page has a surname in "${inline(input.query)}"; INSPIRE widened the match by reading name parts as initials, so these may be other people. Check the spelling, or search by BAI or ORCID.`,
      );
    }

    if (truncated) {
      ctx.enrich.truncated({ shown, cap: input.limit, guidance: notices.join(' ') });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    return { authors: result.authors };
  },

  format: (result) => {
    const lines = [`## INSPIRE author profiles (${result.authors.length})`];
    result.authors.forEach((author, i) => {
      lines.push('', ...renderAuthor(author, i + 1));
    });
    return [{ type: 'text', text: lines.join('\n') }];
  },
});
