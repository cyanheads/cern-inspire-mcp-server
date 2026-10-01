/**
 * @fileoverview cern_inspire_get_paper — one INSPIRE-HEP paper's full record by
 * recid, arXiv ID, or DOI: authors with affiliations, abstract, publication,
 * identifiers, citation counts, linked experiments, and whether HEPData holds
 * its numerical tables. Also exports the dossier schema the
 * `inspire://literature/{recid}` resource validates against.
 * @module mcp-server/tools/definitions/get-paper.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset, paperInput } from '@/mcp-server/tools/inputs.js';
import { inline, printUrl, quote } from '@/mcp-server/tools/render.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';

/** Upper bound on `max_authors`; the full count is always in `authorCount`. */
const MAX_AUTHORS_LIMIT = 500;

/** The `get_paper` dossier — the tool's output and the literature resource's body. */
export const paperDossierSchema = z.object({
  recid: z.string().describe('INSPIRE literature record ID.'),
  resolvedAs: z
    .enum(['recid', 'arxiv', 'doi'])
    .describe('Which identifier form the paper input was resolved from.'),
  title: z.string().describe('Title as INSPIRE records it (LaTeX left as published).'),
  alternateTitles: z
    .array(z.string().describe('An alternate title.'))
    .describe('Other titles INSPIRE records (translations, preprint titles).'),
  abstract: z.string().optional().describe('Full abstract (arXiv-sourced when available).'),
  abstractSource: z
    .string()
    .optional()
    .describe('Who supplied the abstract (e.g. arXiv, a publisher).'),
  authorCount: z.number().describe('Total number of authors on the paper.'),
  authors: z
    .array(
      z
        .object({
          name: z.string().describe('Author name, "Surname, Given names".'),
          recid: z
            .string()
            .optional()
            .describe(
              'INSPIRE author record ID, when linked; pass as query to cern_inspire_search_authors for the profile.',
            ),
          bai: z
            .string()
            .optional()
            .describe(
              'INSPIRE BAI (e.g. Edward.Witten.1), when known; pass as author to cern_inspire_get_citation_summary.',
            ),
          orcid: z.string().optional().describe('ORCID, when known.'),
          affiliations: z
            .array(z.string().describe('Affiliation name.'))
            .describe('Affiliations listed for this author on this paper.'),
        })
        .describe('One author.'),
    )
    .describe('Authors in record order, capped at max_authors.'),
  collaborations: z
    .array(z.string().describe('Collaboration name.'))
    .describe('Collaborations credited on the paper; empty for most non-collaboration papers.'),
  experiments: z
    .array(
      z
        .object({
          name: z.string().describe('Experiment legacy name (e.g. CERN-LHC-ATLAS).'),
          recid: z.string().optional().describe('INSPIRE experiment record ID, when linked.'),
        })
        .describe('One linked experiment.'),
    )
    .describe('Accelerator experiments linked to the paper.'),
  date: z
    .string()
    .optional()
    .describe('Earliest date INSPIRE records for the paper: YYYY, YYYY-MM, or YYYY-MM-DD.'),
  preprintDate: z.string().optional().describe('Preprint date, when recorded.'),
  publicationDate: z.string().optional().describe('Publication (imprint) date, when recorded.'),
  publications: z
    .array(
      z
        .object({
          journal: z.string().optional().describe('Journal title (abbreviated).'),
          volume: z.string().optional().describe('Journal volume.'),
          year: z.number().optional().describe('Publication year.'),
          pages: z.string().optional().describe('Page range or start page.'),
          articleId: z
            .string()
            .optional()
            .describe('Article ID, for journals that number articles.'),
          freetext: z.string().optional().describe('Free-text publication reference.'),
        })
        .describe('One publication reference.'),
    )
    .describe('Publication references (journal, volume, year, pages).'),
  arxivId: z.string().optional().describe('arXiv identifier, when the paper has one.'),
  arxivCategories: z
    .array(z.string().describe('arXiv category.'))
    .describe('arXiv categories of the e-print.'),
  dois: z.array(z.string().describe('A DOI.')).describe('DOIs of the paper.'),
  reportNumbers: z.array(z.string().describe('A report number.')).describe('Report numbers.'),
  keywords: z.array(z.string().describe('A keyword.')).describe('Keywords, de-duplicated.'),
  subjects: z
    .array(z.string().describe('INSPIRE subject.'))
    .describe('INSPIRE subject categories.'),
  documentTypes: z
    .array(z.string().describe('INSPIRE document type.'))
    .describe('INSPIRE document types.'),
  refereed: z
    .boolean()
    .optional()
    .describe('True when published in a refereed venue, when recorded.'),
  citeable: z.boolean().optional().describe('INSPIRE citeable flag, when recorded.'),
  core: z
    .boolean()
    .optional()
    .describe('True when INSPIRE classes the paper as core HEP, when recorded.'),
  numberOfPages: z.number().optional().describe('Page count, when recorded.'),
  citationCount: z.number().describe('Citations INSPIRE counts for the paper.'),
  citationCountWithoutSelf: z
    .number()
    .optional()
    .describe('Citations excluding self-citations, when INSPIRE reports it.'),
  texkeys: z
    .array(z.string().describe('A texkey.'))
    .describe('INSPIRE texkeys (BibTeX citation keys), current first.'),
  urls: z
    .array(
      z
        .object({
          url: z.string().describe('Link URL.'),
          description: z.string().optional().describe('Link description, when given.'),
        })
        .describe('One external link.'),
    )
    .describe('External links INSPIRE records for the paper.'),
  licenses: z
    .array(
      z
        .object({
          url: z.string().describe('Licence URL.'),
          material: z
            .string()
            .optional()
            .describe(
              'Which version of the paper the licence covers (e.g. preprint, publication), when recorded.',
            ),
          imposing: z.string().optional().describe('Who imposes the licence, when recorded.'),
        })
        .describe('One licence.'),
    )
    .describe('Licences recorded for the paper.'),
  inspireUrl: z.string().describe('The paper on inspirehep.net.'),
  citingQuery: z
    .string()
    .describe(
      'Literature query for papers citing this one; pass to cern_inspire_search_literature.',
    ),
  referencesQuery: z
    .string()
    .describe(
      "Literature query for this paper's references; pass to cern_inspire_search_literature.",
    ),
  hepdata: z
    .object({
      status: z
        .enum(['available', 'none', 'lookup_failed'])
        .describe(
          'available: HEPData holds tables; none: it does not; lookup_failed: could not check.',
        ),
      inspireDataRecid: z
        .string()
        .optional()
        .describe("Record ID of the HEPData entry in INSPIRE's data collection."),
      recordDoi: z
        .string()
        .optional()
        .describe('HEPData record DOI; cite it when reusing the data.'),
      latestVersion: z.number().optional().describe('Latest HEPData record version.'),
      tableCount: z.number().optional().describe('Number of tables in the latest version.'),
      hepdataUrl: z
        .string()
        .optional()
        .describe('The HEPData record page on hepdata.net, where the table values are read.'),
    })
    .describe("HEPData availability for the paper's numerical tables."),
});

export type PaperDossierOutput = z.infer<typeof paperDossierSchema>;

const yesNo = (value: boolean) => (value ? 'yes' : 'no');

function renderPublication(p: PaperDossierOutput['publications'][number]): string {
  const parts = [
    p.journal && inline(p.journal),
    p.volume && inline(p.volume),
    p.year !== undefined && `(${p.year})`,
    p.pages && inline(p.pages),
    p.articleId && `article ${inline(p.articleId)}`,
  ].filter(Boolean);
  if (p.freetext) parts.push(`${parts.length > 0 ? '— ' : ''}${inline(p.freetext)}`);
  return `- ${parts.join(' ')}`;
}

function renderAuthor(a: PaperDossierOutput['authors'][number]): string {
  const ids = [
    a.recid && `author recid ${a.recid}`,
    a.bai && `BAI ${inline(a.bai)}`,
    a.orcid && `ORCID ${inline(a.orcid)}`,
  ].filter(Boolean);
  const affiliations =
    a.affiliations.length > 0 ? ` — ${a.affiliations.map(inline).join('; ')}` : '';
  return `- **${inline(a.name)}**${ids.length > 0 ? ` (${ids.join(' · ')})` : ''}${affiliations}`;
}

function renderHepdata(h: PaperDossierOutput['hepdata']): string[] {
  const lines = ['### HEPData'];
  const status = {
    available: 'available — HEPData holds numerical tables for this paper',
    none: 'none — HEPData holds no record for this paper',
    lookup_failed: 'lookup_failed — availability could not be checked',
  }[h.status];
  lines.push(`**Status:** ${status}`);
  const facts = [
    h.recordDoi && `**Record DOI:** ${inline(h.recordDoi)}`,
    h.latestVersion !== undefined && `**Latest version:** ${h.latestVersion}`,
    h.tableCount !== undefined && `**Tables:** ${h.tableCount}`,
    h.inspireDataRecid && `**INSPIRE data recid:** ${h.inspireDataRecid}`,
  ].filter(Boolean);
  if (facts.length > 0) lines.push(facts.join(' · '));
  if (h.hepdataUrl) lines.push(`**Record page:** ${printUrl(h.hepdataUrl)}`);
  return lines;
}

/** Markdown for one dossier. */
function renderPaperDossier(paper: PaperDossierOutput): string {
  const lines = [`## ${inline(paper.title) || '(untitled)'}`];
  lines.push(
    `**recid:** ${paper.recid} (resolved from ${paper.resolvedAs}) · **INSPIRE:** ${printUrl(paper.inspireUrl)}`,
  );
  const dates = [
    paper.date && `**Date:** ${inline(paper.date)}`,
    paper.preprintDate && `**Preprint date:** ${inline(paper.preprintDate)}`,
    paper.publicationDate && `**Publication date:** ${inline(paper.publicationDate)}`,
  ].filter(Boolean);
  if (dates.length > 0) lines.push(dates.join(' · '));
  lines.push(
    `**Citations:** ${paper.citationCount}${
      paper.citationCountWithoutSelf === undefined
        ? ''
        : ` (${paper.citationCountWithoutSelf} without self-citations)`
    }`,
  );

  const flags = [
    paper.documentTypes.length > 0 &&
      `**Document types:** ${paper.documentTypes.map(inline).join(', ')}`,
    paper.refereed !== undefined && `**Refereed:** ${yesNo(paper.refereed)}`,
    paper.citeable !== undefined && `**Citeable:** ${yesNo(paper.citeable)}`,
    paper.core !== undefined && `**Core:** ${yesNo(paper.core)}`,
    paper.numberOfPages !== undefined && `**Pages:** ${paper.numberOfPages}`,
  ].filter(Boolean);
  if (flags.length > 0) lines.push(flags.join(' · '));

  const ids = [
    paper.arxivId &&
      `**arXiv:** ${inline(paper.arxivId)}${
        paper.arxivCategories.length > 0 ? ` (${paper.arxivCategories.map(inline).join(', ')})` : ''
      }`,
    paper.dois.length > 0 && `**DOIs:** ${paper.dois.map(inline).join(', ')}`,
    paper.reportNumbers.length > 0 &&
      `**Report numbers:** ${paper.reportNumbers.map(inline).join(', ')}`,
  ].filter(Boolean);
  if (ids.length > 0) lines.push(ids.join(' · '));
  if (paper.subjects.length > 0)
    lines.push(`**Subjects:** ${paper.subjects.map(inline).join(', ')}`);
  if (paper.collaborations.length > 0) {
    lines.push(`**Collaborations:** ${paper.collaborations.map(inline).join(', ')}`);
  }
  if (paper.experiments.length > 0) {
    const experiments = paper.experiments.map(
      (e) => `${inline(e.name)}${e.recid ? ` (experiment recid ${e.recid})` : ''}`,
    );
    lines.push(`**Experiments:** ${experiments.join(', ')}`);
  }
  if (paper.alternateTitles.length > 0) {
    lines.push(`**Alternate titles:** ${paper.alternateTitles.map(inline).join(' / ')}`);
  }

  if (paper.publications.length > 0) {
    lines.push('', '### Publication', ...paper.publications.map(renderPublication));
  }
  if (paper.abstract) {
    lines.push(
      '',
      `### Abstract${paper.abstractSource ? ` (source: ${inline(paper.abstractSource)})` : ''}`,
      quote(paper.abstract),
    );
  }

  lines.push(
    '',
    `### Authors (${paper.authors.length} shown of ${paper.authorCount})`,
    ...paper.authors.map(renderAuthor),
  );
  if (paper.keywords.length > 0) {
    lines.push('', '### Keywords', paper.keywords.map(inline).join('; '));
  }
  if (paper.texkeys.length > 0) {
    lines.push('', `**Texkeys:** ${paper.texkeys.map(inline).join(', ')}`);
  }
  if (paper.urls.length > 0) {
    lines.push(
      '',
      '### Links',
      ...paper.urls.map(
        (u) => `- ${printUrl(u.url)}${u.description ? ` — ${inline(u.description)}` : ''}`,
      ),
    );
  }
  if (paper.licenses.length > 0) {
    lines.push(
      '',
      '### Licenses',
      ...paper.licenses.map((l) => {
        const details = [
          l.material && `for the ${inline(l.material)}`,
          l.imposing && `imposed by ${inline(l.imposing)}`,
        ].filter(Boolean);
        return `- ${printUrl(l.url)}${details.length > 0 ? ` (${details.join(' · ')})` : ''}`;
      }),
    );
  }

  lines.push('', ...renderHepdata(paper.hepdata));
  lines.push(
    '',
    '### Follow-up queries',
    `**Citing papers:** \`${paper.citingQuery}\` · **References:** \`${paper.referencesQuery}\` (pass to cern_inspire_search_literature)`,
  );
  return lines.join('\n');
}

export const getPaperTool = tool('cern_inspire_get_paper', {
  title: 'Get INSPIRE paper',
  description:
    "Fetch one paper's full INSPIRE-HEP record by recid, arXiv ID, or DOI: authors with affiliations and identifiers, abstract, publication references, arXiv and DOI identifiers, keywords, subjects, citation counts, linked experiments, texkeys, and whether HEPData holds its numerical tables (record DOI, latest version, table count, hepdata.net link). Also returns ready-made literature queries for the papers citing it and for its references. Large collaboration papers can list thousands of authors; max_authors caps the list while authorCount gives the full number.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    paper: paperInput,
    max_authors: blankAsUnset(z.number().int().min(0).max(MAX_AUTHORS_LIMIT).default(25)).describe(
      'Most authors to list (0–500, default 25). The full count is always in authorCount.',
    ),
  }),
  output: paperDossierSchema,
  enrichment: {
    truncated: z.boolean().describe('True when the author list was capped at max_authors.'),
    shown: z.number().describe('Number of authors listed.'),
    cap: z.number().describe('The max_authors cap applied.'),
    notice: z
      .string()
      .optional()
      .describe(
        'Guidance when the author list was capped or HEPData availability could not be checked.',
      ),
  },
  errors: [
    {
      reason: 'paper_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The recid, arXiv ID, or DOI matches no INSPIRE literature record.',
      recovery:
        'Find the record with cern_inspire_search_literature using title words, an author, or the arXiv number, then call cern_inspire_get_paper with its recid.',
      severity: 'notice',
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
        'Retry this call in a few seconds; if it fails again, read the paper\'s summary record with cern_inspire_search_literature (query "recid:N", "arxiv:ID", or "doi:DOI").',
      thrownBy: 'service',
    },
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.max_authors });

    const inspire = getInspireService();
    const lookup = await inspire.getPaper(input.paper, input.max_authors, inspire.beginCall(ctx));
    if (!lookup) {
      throw ctx.fail(
        'paper_not_found',
        `No INSPIRE literature record matches "${inline(input.paper)}".`,
        { paper: input.paper },
      );
    }
    const { paper, authorsInRecord } = lookup;
    const shown = paper.authors.length;
    ctx.enrich({ shown });

    const notices: string[] = [];
    if (paper.hepdata.status === 'lookup_failed') {
      notices.push(
        `HEPData availability could not be checked; retry cern_inspire_get_paper, or call cern_inspire_search_hepdata with query "literature.control_number:${paper.recid}".`,
      );
    }
    if (authorsInRecord > input.max_authors) {
      notices.unshift(
        input.max_authors < MAX_AUTHORS_LIMIT
          ? `Showing ${shown} of ${authorsInRecord} authors; raise max_authors (up to ${MAX_AUTHORS_LIMIT}) to list more.`
          : `Showing ${shown} of ${authorsInRecord} authors, the max_authors maximum; the other ${authorsInRecord - shown} are not listed. To check whether someone is on this paper, call cern_inspire_search_literature with query "recid:${paper.recid} and a <BAI or name>", which returns the paper when they are a listed author.`,
      );
      ctx.enrich.truncated({ shown, cap: input.max_authors, guidance: notices.join(' ') });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }
    return paper;
  },

  format: (paper) => [{ type: 'text', text: renderPaperDossier(paper) }],
});
