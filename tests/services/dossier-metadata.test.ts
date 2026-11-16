/**
 * @fileoverview Contributor, supervisor, thesis, publication-link, and attachment
 * metadata through the dossier normalization seam.
 */
import { describe, expect, it } from 'vitest';
import { toPaperLookup } from '@/services/inspire/normalize.js';
import type { RawLiteratureMetadata } from '@/services/inspire/types.js';
import { CONFERENCE_PAPERS, supervisorEntry, THESES } from '../fixtures/inspire-upstream.js';

const lookup = (metadata: RawLiteratureMetadata, cap = 25, offset = 0) =>
  toPaperLookup(
    { control_number: 1500425, ...metadata },
    undefined,
    { resolvedAs: 'recid' },
    { status: 'none' },
    cap,
    offset,
  );

describe('dossier metadata', () => {
  it('preserves multiple ordered roles without inferring an author role', () => {
    const result = lookup({
      authors: [
        { full_name: 'Editor', inspire_roles: ['editor', 'supervisor'] },
        { full_name: 'Unknown' },
      ],
    });
    expect(result.paper.authors).toEqual([
      { name: 'Editor', affiliations: [], roles: ['editor', 'supervisor'] },
      { name: 'Unknown', affiliations: [] },
    ]);
  });

  it('returns only public attachments with supplied metadata and no inferred fulltext', () => {
    const result = lookup({
      documents: [
        { url: 'https://example.org/hidden', hidden: true },
        { filename: 'missing.pdf' },
        { url: '  ' },
        {
          url: 'https://example.org/full',
          filename: 'fulltext.pdf',
          description: 'Proceedings',
          material: 'publication',
          fulltext: true,
          hidden: false,
        },
        { url: 'https://example.org/supplement', fulltext: false },
        { url: 'https://example.org/sparse.pdf' },
      ],
    });
    expect(result.paper.documents).toEqual([
      {
        url: 'https://example.org/full',
        filename: 'fulltext.pdf',
        description: 'Proceedings',
        material: 'publication',
        fulltext: true,
      },
      { url: 'https://example.org/supplement', fulltext: false },
      { url: 'https://example.org/sparse.pdf' },
    ]);
    expect(lookup({}).paper.documents).toEqual([]);
  });
  it('keeps roleless contributor identifiers and normalized paging independent of the upstream count', () => {
    const result = lookup(
      {
        author_count: 99,
        authors: [
          { full_name: '' },
          {
            full_name: 'Editor',
            ids: [{ schema: 'ORCID', value: '0000' }],
            affiliations: [{ value: 'CERN' }],
          },
        ],
      },
      1,
    );
    expect(result.authorsInRecord).toBe(1);
    expect(result.paper.authorCount).toBe(99);
    expect(result.paper.authors).toEqual([
      { name: 'Editor', orcid: '0000', affiliations: ['CERN'] },
    ]);
    expect(result.paper.nextAuthorOffset).toBeUndefined();
  });
});

const INSTITUTIONS = 'https://inspirehep.net/api/institutions';
const linked = (name: string, recid: number) => ({
  name,
  record: { $ref: `${INSTITUTIONS}/${recid}` },
});

describe('supervisors', () => {
  it('lists them apart from the contributors, in the contributor shape and record order', () => {
    const result = lookup({
      author_count: 1,
      authors: [{ full_name: 'Student' }],
      supervisors: [
        supervisorEntry(1, 'CERN'),
        { full_name: 'Unlinked, Sam', inspire_roles: ['supervisor'] },
        { full_name: '  ' },
        supervisorEntry(2),
      ],
    });
    expect(result.paper.supervisors).toEqual([
      {
        name: 'Roe, Richard 1',
        roles: ['supervisor'],
        recid: '3000001',
        bai: 'Richard.Roe.1',
        affiliations: ['CERN'],
      },
      { name: 'Unlinked, Sam', roles: ['supervisor'], affiliations: [] },
      {
        name: 'Roe, Richard 2',
        roles: ['supervisor'],
        recid: '3000002',
        bai: 'Richard.Roe.2',
        affiliations: [],
      },
    ]);
    expect(result.paper.authors).toEqual([{ name: 'Student', affiliations: [] }]);
    expect(result.paper.authorCount).toBe(1);
    expect(result.authorsInRecord).toBe(1);
  });

  it.each([
    [25, 0],
    [0, 0],
    [1, 0],
    [1, 1],
    [1, 2],
    [3, 9],
  ])(
    'lists all six at budget %i offset %i and leaves contributor paging as it was',
    (cap, offset) => {
      const contributors: RawLiteratureMetadata = {
        authors: [{ full_name: 'Student A' }, { full_name: 'Student B' }],
      };
      const supervisors = Array.from({ length: 6 }, (_, i) => supervisorEntry(i + 1));
      const without = lookup(contributors, cap, offset);
      const result = lookup({ ...contributors, supervisors }, cap, offset);
      const { supervisors: listed, ...rest } = result.paper;
      expect(listed?.map((s) => s.name)).toEqual(supervisors.map((s) => s.full_name));
      expect(rest).toEqual(without.paper);
      expect(result.authorsInRecord).toBe(without.authorsInRecord);
    },
  );

  it.each<[string, RawLiteratureMetadata]>([
    ['absent', {}],
    ['an empty list', { supervisors: [] }],
    [
      'only nameless entries',
      { supervisors: [{}, { full_name: '' }, { inspire_roles: ['supervisor'] }] },
    ],
  ])('stays absent, not empty, when supervisors is %s', (_label, metadata) => {
    expect('supervisors' in lookup(metadata).paper).toBe(false);
  });
});

describe('thesis details', () => {
  it.each([
    [
      'a PhD at one linked institution, without a defense date (2680186)',
      THESES.phd,
      { degreeType: 'PhD', institutions: [{ name: 'Calcutta U.', recid: '903457' }], date: '2023' },
    ],
    [
      "a Master's listing its institution unlinked and linked (2859264)",
      THESES.master,
      {
        degreeType: 'Master',
        institutions: [{ name: 'Minas Gerais U.', recid: '908193' }],
        defenseDate: '2024-10-25',
        date: '2024-12-13',
      },
    ],
    [
      'a PhD at two distinct institutions, one unlinked (2866041)',
      THESES.joint,
      {
        degreeType: 'PhD',
        institutions: [
          { name: 'Laboratoire de Physique de Clermont, France' },
          { name: 'Tech. U., Dortmund (main)', recid: '1088595' },
        ],
        date: '2024',
      },
    ],
  ])('reads %s', (_label, metadata, thesis) => {
    expect(lookup(metadata).paper.thesis).toEqual(thesis);
  });

  it.each([
    [
      'a name-only entry after the linked one',
      [linked('X U.', 1), { name: 'X U.' }],
      [{ name: 'X U.', recid: '1' }],
    ],
    [
      'a spelling variant',
      [{ name: 'Minas Gerais U' }, linked('Minas Gerais U.', 908193)],
      [{ name: 'Minas Gerais U' }, { name: 'Minas Gerais U.', recid: '908193' }],
    ],
    [
      'a case variant',
      [{ name: 'minas gerais u.' }, linked('Minas Gerais U.', 908193)],
      [{ name: 'minas gerais u.' }, { name: 'Minas Gerais U.', recid: '908193' }],
    ],
    [
      'two unlinked entries of one name',
      [{ name: 'X U.' }, { name: 'X U.' }],
      [{ name: 'X U.' }, { name: 'X U.' }],
    ],
    [
      'two linked entries of one name',
      [linked('X U.', 1), linked('X U.', 2)],
      [
        { name: 'X U.', recid: '1' },
        { name: 'X U.', recid: '2' },
      ],
    ],
    [
      'interleaved duplicates of two institutions',
      [{ name: 'A U.' }, linked('B U.', 2), linked('A U.', 1), { name: 'B U.' }, { name: 'C U.' }],
      [{ name: 'B U.', recid: '2' }, { name: 'A U.', recid: '1' }, { name: 'C U.' }],
    ],
    [
      'an entry whose record reference names no recid',
      [{ name: 'X U.', record: { $ref: `${INSTITUTIONS}/` } }, { name: 'X U.' }],
      [{ name: 'X U.' }, { name: 'X U.' }],
    ],
    [
      'a nameless linked entry',
      [{ record: { $ref: `${INSTITUTIONS}/7` } }, { name: '' }, { name: 'Y U.' }],
      [{ name: 'Y U.' }],
    ],
  ])('keeps institutions as recorded with %s', (_label, institutions, expected) => {
    expect(lookup({ thesis_info: { degree_type: 'PhD', institutions } }).paper.thesis).toEqual({
      degreeType: 'PhD',
      institutions: expected,
    });
  });

  it.each([
    [
      'only a degree type',
      { degree_type: 'Habilitation' },
      { degreeType: 'Habilitation', institutions: [] },
    ],
    [
      'only a defense date',
      { defense_date: '2020-01-31' },
      { defenseDate: '2020-01-31', institutions: [] },
    ],
    ['only a date', { date: '1999' }, { date: '1999', institutions: [] }],
  ] as const)('keeps thesis_info holding %s', (_label, thesisInfo, thesis) => {
    expect(lookup({ thesis_info: thesisInfo }).paper.thesis).toEqual(thesis);
  });

  it.each<[string, RawLiteratureMetadata]>([
    ['absent', {}],
    ['empty', { thesis_info: {} }],
    [
      'blank and nameless',
      {
        thesis_info: {
          degree_type: ' ',
          date: '',
          institutions: [{ name: '' }, { record: { $ref: `${INSTITUTIONS}/7` } }],
        },
      },
    ],
  ])('leaves thesis absent when thesis_info is %s', (_label, metadata) => {
    expect('thesis' in lookup(metadata).paper).toBe(false);
  });
});

describe('publication links', () => {
  it('makes an entry holding only conference links its own publication (1959589)', () => {
    expect(lookup(CONFERENCE_PAPERS.icm).paper.publications).toEqual([
      { year: 2023 },
      { cnum: 'C22-07-06.1', conferenceRecid: '1915801' },
    ]);
  });

  it('keeps journal, conference, and parent-record entries in record order (18076)', () => {
    expect(lookup(CONFERENCE_PAPERS.proceedings).paper.publications).toEqual([
      { journal: 'Phys.Rev.D', volume: '34', year: 1986, pages: '1642', articleId: '1642' },
      { cnum: 'C86-07-16', conferenceRecid: '965760', parentRecid: '256605' },
      { pages: '235-238', parentRecid: '568498' },
    ]);
  });

  it.each([
    [
      'journal data only',
      { journal_title: 'Phys.Lett.B', journal_volume: '716' },
      [{ journal: 'Phys.Lett.B', volume: '716' }],
    ],
    ['a CNUM only', { cnum: 'C22-07-06.1' }, [{ cnum: 'C22-07-06.1' }]],
    [
      'journal data and a CNUM',
      {
        journal_title: 'Phys.Rev.D',
        journal_volume: '34',
        page_start: '1642',
        cnum: 'C86-07-16',
        conference_record: { $ref: 'https://inspirehep.net/api/conferences/965760' },
      },
      [
        {
          journal: 'Phys.Rev.D',
          volume: '34',
          pages: '1642',
          cnum: 'C86-07-16',
          conferenceRecid: '965760',
        },
      ],
    ],
    [
      'a parent record only',
      { parent_record: { $ref: 'https://inspirehep.net/api/literature/568498' } },
      [{ parentRecid: '568498' }],
    ],
    [
      'a conference record only',
      { conference_record: { $ref: 'https://inspirehep.net/api/conferences/1915801' } },
      [{ conferenceRecid: '1915801' }],
    ],
    [
      'unreadable links and a blank CNUM',
      {
        cnum: ' ',
        conference_record: {},
        parent_record: { $ref: 'https://inspirehep.net/api/literature/' },
      },
      [],
    ],
  ])('reads an entry with %s', (_label, entry, publications) => {
    expect(lookup({ publication_info: [entry] }).paper.publications).toEqual(publications);
  });
});
