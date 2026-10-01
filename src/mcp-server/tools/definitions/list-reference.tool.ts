/**
 * @fileoverview cern_inspire_list_reference — static decoder for the vocabulary
 * the other tools take: INSPIRE query syntax, identifier forms, the document-type
 * and subject facet values, citation-summary buckets, and HEPData versioning and
 * DOIs. Zero upstream calls.
 * @module mcp-server/tools/definitions/list-reference.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import {
  DOCUMENT_TYPES,
  type DocumentType,
  SUBJECTS,
  type Subject,
} from '@/services/inspire/vocabulary.js';

const TOPICS = [
  'search_syntax',
  'identifiers',
  'document_types',
  'subjects',
  'citation_buckets',
  'hepdata',
] as const;

type Topic = (typeof TOPICS)[number];

interface Entry {
  example?: string;
  meaning: string;
  term: string;
}

const DOCUMENT_TYPE_MEANINGS: Record<DocumentType, string> = {
  article: 'A research article, preprint or journal version.',
  published:
    'Published in a refereed journal. Combine with another type to keep only its published works (published + review = published reviews).',
  'conference paper': 'A contribution to a conference.',
  thesis: "A PhD, master's, or other thesis.",
  review: 'A review article.',
  note: 'A note, such as an experiment or collaboration note.',
  proceedings: 'A conference proceedings volume.',
  lectures: 'Lecture notes.',
  'book chapter': 'A chapter in a book.',
  book: 'A book.',
  introductory: 'Introductory or pedagogical material.',
  'activity report': 'An activity report of an institution, experiment, or collaboration.',
  report: 'A technical or other report.',
};

const SUBJECT_MEANINGS: Record<Subject, string> = {
  Astrophysics: 'Astrophysics; arXiv astro-ph papers are filed here.',
  'Phenomenology-HEP': 'High-energy phenomenology; arXiv hep-ph.',
  'Theory-HEP': 'High-energy theory; arXiv hep-th.',
  'Quantum Physics': 'Quantum physics; arXiv quant-ph.',
  Unknown: 'Not yet assigned a subject.',
  'Gravitation and Cosmology': 'General relativity and quantum cosmology; arXiv gr-qc.',
  'Experiment-HEP': 'High-energy experiment; arXiv hep-ex.',
  'Theory-Nucl': 'Nuclear theory; arXiv nucl-th.',
  Accelerators: 'Accelerator physics; arXiv physics.acc-ph.',
  Instrumentation: 'Instrumentation and detectors; arXiv physics.ins-det.',
  'General Physics': 'General physics.',
  'Experiment-Nucl': 'Nuclear experiment; arXiv nucl-ex.',
  'Math and Math Physics': 'Mathematics and mathematical physics; arXiv math and math-ph.',
  'Condensed Matter': 'Condensed matter; arXiv cond-mat.',
  Computing: 'Computing and computer science; arXiv cs.',
  Lattice: 'Lattice field theory; arXiv hep-lat.',
  Other: 'Other fields.',
  'Data Analysis and Statistics': 'Data analysis and statistics; arXiv physics.data-an.',
};

const REFERENCE: Record<Topic, Entry[]> = {
  search_syntax: [
    {
      term: 'free text',
      meaning:
        'Bare words search every field, which matches broadly; prefer a field operator below for titles, authors, or collaborations.',
      example: 'higgs boson discovery',
    },
    {
      term: 'a NAME or BAI',
      meaning:
        'Author. A name matches its spelling variants; a BAI matches exactly that profile (exact and case-sensitive, usually with the full first name).',
      example: 'a Edward.Witten.1',
    },
    {
      term: 'exactauthor:BAI',
      meaning: 'Papers signed by exactly this author BAI.',
      example: 'exactauthor:Edward.Witten.1',
    },
    {
      term: 'authors.recid:N',
      meaning:
        'Papers by the author profile with recid N — the literatureQuery cern_inspire_search_authors returns.',
      example: 'authors.recid:983328',
    },
    { term: 't WORDS', meaning: 'Title words.', example: 't higgs boson' },
    {
      term: 'cn NAME / collaboration:NAME',
      meaning: 'Collaboration name, case-insensitive.',
      example: 'cn atlas and t higgs',
    },
    {
      term: 'date YEAR / date > YEAR',
      meaning:
        'Publication date: one year, or an open range with a comparison (after or before a year).',
      example: 'date > 2025',
    },
    {
      term: 'topcite N+',
      meaning: 'Papers with at least N citations.',
      example: 't higgs and topcite 500+',
    },
    {
      term: 'refersto:recid:N',
      meaning: 'Papers that cite record N (its citations).',
      example: 'refersto:recid:1124337',
    },
    {
      term: 'citedby:recid:N',
      meaning: 'Papers that record N cites (its references).',
      example: 'citedby:recid:1124337',
    },
    {
      term: 'j JOURNAL,VOLUME,PAGE',
      meaning: 'Journal publication; the volume and page are optional.',
      example: 'j Phys.Lett.B,716,1',
    },
    { term: 'eprint ID', meaning: 'arXiv eprint number.', example: 'eprint 1207.7214' },
    {
      term: 'arxiv:ID',
      meaning: 'arXiv ID, new or old style, without a version suffix (v2 matches nothing).',
      example: 'arxiv:hep-th/9711200',
    },
    {
      term: 'doi:DOI',
      meaning: 'DOI, matched case-insensitively.',
      example: 'doi:10.1016/j.physletb.2012.08.020',
    },
    {
      term: 'recid:N',
      meaning: 'One record by INSPIRE recid; join several with or to select a set of papers.',
      example: 'recid:451647 or recid:1124337',
    },
    {
      term: 'accelerator_experiments.legacy_name:"NAME"',
      meaning:
        'Papers linked to an experiment — the literatureQuery cern_inspire_search_experiments returns. The legacy name is exact and case-sensitive.',
      example: 'accelerator_experiments.legacy_name:"CERN-LHC-ATLAS"',
    },
    {
      term: 'and / or / not',
      meaning: 'Combine terms; parentheses group them.',
      example: 'a Edward.Witten.1 and not t string',
    },
    {
      term: 'sort',
      meaning:
        'relevance (the default with a query), mostrecent, or mostcited. cern_inspire_search_hepdata takes relevance or mostrecent.',
    },
    {
      term: '10,000-result window',
      meaning:
        'INSPIRE serves at most the first 10,000 results of a query (page × size ≤ 10,000); narrow the query to reach further.',
    },
    {
      term: 'document_types / subjects filters',
      meaning:
        'Exact facet filters. Several values must ALL hold (published + review = published reviews); there is no OR across them.',
    },
    {
      term: 'malformed syntax',
      meaning:
        'INSPIRE never rejects a query string: an unparsed operator widens or empties the match instead (a stray "a:" matched 1.5 M records). A very large total, or zero hits, usually means a syntax slip.',
    },
  ],
  identifiers: [
    {
      term: 'recid',
      meaning:
        'INSPIRE record ID, an integer. Literature, authors, experiments, and institutions each number their own records.',
      example: '1124337',
    },
    {
      term: 'arXiv ID',
      meaning:
        "New style NNNN.NNNNN or old style archive/NNNNNNN. INSPIRE stores it without a version suffix: the paper input of cern_inspire_get_paper strips 'arXiv:', vN, and arxiv.org URLs, but a literature query needs the bare ID (arxiv:1207.7214, not 1207.7214v2).",
      example: '1207.7214',
    },
    {
      term: 'DOI',
      meaning:
        "Publisher DOI, matched case-insensitively. The paper input of cern_inspire_get_paper strips 'doi:' and doi.org prefixes; a literature query takes doi:DOI.",
      example: '10.1016/j.physletb.2012.08.020',
    },
    {
      term: 'INSPIRE BAI',
      meaning:
        'Author identifier: exact and case-sensitive, usually with the full first name (Jane.Doe.1, not J.Doe.1). Find it with cern_inspire_search_authors.',
      example: 'Edward.Witten.1',
    },
    {
      term: 'ORCID',
      meaning:
        'Author ORCID iD. Accepted by cern_inspire_search_authors and the author input of cern_inspire_get_citation_summary; literature queries do not match ORCIDs.',
      example: '0000-0002-7752-6073',
    },
    {
      term: 'INSPIRE ID',
      meaning: 'Author identifier: INSPIRE- plus 8 digits.',
      example: 'INSPIRE-00136372',
    },
    {
      term: 'author recid',
      meaning: "An author profile's recid; select its papers with authors.recid:N.",
      example: '983328',
    },
    {
      term: 'experiment legacy name',
      meaning:
        'An experiment\'s canonical name, exact and case-sensitive; select its papers with accelerator_experiments.legacy_name:"NAME".',
      example: 'CERN-LHC-ATLAS',
    },
    {
      term: 'texkey',
      meaning:
        "INSPIRE's citation key, used by the BibTeX and LaTeX entries of cern_inspire_export_citations.",
      example: 'ATLAS:2012yve',
    },
    {
      term: 'HEPData ins<recid>',
      meaning:
        'HEPData addresses a paper by its INSPIRE literature recid with an ins prefix; the paper input of cern_inspire_get_paper accepts it, and a literature query takes recid:N.',
      example: 'ins3182500',
    },
    {
      term: 'HEPData record DOI',
      meaning: 'The DOI of a HEPData record (all versions); cite it when reusing the data.',
      example: '10.17182/hepdata.182706',
    },
    {
      term: 'HEPData version DOI',
      meaning: 'The DOI of one version of a HEPData record.',
      example: '10.17182/hepdata.182706.v1',
    },
    {
      term: 'HEPData table DOI',
      meaning: 'The DOI of one table within a version.',
      example: '10.17182/hepdata.182706.v1/t1',
    },
  ],
  document_types: DOCUMENT_TYPES.map((term) => ({ term, meaning: DOCUMENT_TYPE_MEANINGS[term] })),
  subjects: SUBJECTS.map((term) => ({ term, meaning: SUBJECT_MEANINGS[term] })),
  citation_buckets: [
    {
      term: '0, 1–9, 10–49, 50–99, 100–249, 250–499, 500+',
      meaning:
        "Citation ranges; each bucket counts the papers whose citation count falls in it. INSPIRE's web tier labels are not in the API.",
    },
    {
      term: 'all (citeable)',
      meaning:
        'Papers INSPIRE flags as citeable — records with enough publication information to be cited reliably.',
    },
    {
      term: 'published',
      meaning: 'The citeable papers that are also published in a refereed journal.',
    },
    {
      term: 'h-index',
      meaning:
        'The largest h such that h papers have at least h citations each, for all citeable and for published papers.',
    },
    {
      term: 'matchedRecords vs citeablePapers',
      meaning:
        'Every record the query matched, versus the citeable subset the summary is computed over.',
    },
    {
      term: 'exclude_self_citations',
      meaning:
        'Drops citations from papers sharing an author with the cited paper. For papers with over 20 authors and no collaboration name, only the first 20 authors count.',
    },
  ],
  hepdata: [
    {
      term: 'HEPData record',
      meaning:
        'The numerical tables behind one paper, on hepdata.net at /record/ins followed by the INSPIRE literature recid.',
      example: 'https://www.hepdata.net/record/ins3182500',
    },
    {
      term: 'versions',
      meaning:
        'A record holds one or more versions, each with its own DOI and tables. latestVersion and tableCount describe the newest version.',
    },
    {
      term: 'DOIs',
      meaning:
        'Record DOI 10.17182/hepdata.N; version DOI adds .vK; table DOI adds /tJ to the version DOI.',
      example: '10.17182/hepdata.182706.v1/t1',
    },
    {
      term: 'table values',
      meaning:
        'Live on hepdata.net. This server does not read them: send the user to the hepdataUrl or the record DOI that cern_inspire_get_paper and cern_inspire_search_hepdata return.',
    },
    {
      term: 'search',
      meaning:
        "cern_inspire_search_hepdata searches INSPIRE's index of HEPData submissions: titles, abstracts, collaborations, and keywords such as reactions, observables, and centre-of-mass energies.",
      example: 'P P --> TOP TOPBAR X',
    },
    {
      term: 'licence and citation',
      meaning:
        'HEPData tables are CC0. Cite the HEPData record DOI when reusing its data, and credit INSPIRE for its metadata.',
    },
  ],
};

/** A static string in a table cell: pipes escaped so the row keeps its columns. */
const cellText = (text: string) => text.replace(/\|/g, '\\|');

export const listReferenceTool = tool('cern_inspire_list_reference', {
  title: 'INSPIRE reference vocabulary',
  description:
    'Decode the vocabulary the other cern_inspire tools take: INSPIRE search syntax (field operators, boolean logic, sort orders, the 10,000-result window, and how malformed queries behave), identifier forms (recid, arXiv, DOI, BAI, ORCID, INSPIRE ID, texkey, HEPData DOIs), the document_types and subjects filter values, citation-summary buckets, and HEPData record versions and DOIs. Static content with no upstream call; use it to build a query or to recover from an empty or unexpectedly broad result.',
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    topic: z
      .enum(TOPICS)
      .describe(
        'Which vocabulary to decode: search_syntax (query operators and rules), identifiers (paper, author, experiment, and HEPData identifier forms), document_types, subjects, citation_buckets (citation-summary ranges and terms), or hepdata (record versions, DOIs, and licence).',
      ),
  }),
  output: z.object({
    topic: z.enum(TOPICS).describe('The topic decoded.'),
    entries: z
      .array(
        z
          .object({
            term: z.string().describe('The operator, identifier form, value, or concept.'),
            meaning: z.string().describe('What it means and how the tools use it.'),
            example: z.string().optional().describe('A working example, when one applies.'),
          })
          .describe('One vocabulary entry.'),
      )
      .describe('The entries for the topic.'),
  }),

  handler(input) {
    return { topic: input.topic, entries: REFERENCE[input.topic] };
  },

  format: (result) => {
    const rows = result.entries.map(
      (entry) =>
        `| \`${cellText(entry.term)}\` | ${cellText(entry.meaning)} | ${entry.example ? `\`${cellText(entry.example)}\`` : '—'} |`,
    );
    const text = [
      `## INSPIRE reference: ${result.topic}`,
      '',
      '| Term | Meaning | Example |',
      '|:-----|:--------|:--------|',
      ...rows,
    ].join('\n');
    return [{ type: 'text', text }];
  },
});
