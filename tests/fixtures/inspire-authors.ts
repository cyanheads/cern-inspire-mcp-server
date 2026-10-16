/**
 * @fileoverview INSPIRE record 1124337 author positions 500–502, captured 2026-10-16.
 * @module tests/fixtures/inspire-authors
 */

/** Captured neighboring authors straddling the first 500-author page. */
export const AUTHOR_PAGE_BOUNDARY = [
  {
    full_name: 'Clarke, Robert',
    record: { $ref: 'https://inspirehep.net/api/authors/1074109' },
    affiliations: [{ value: 'LBL, Berkeley' }],
    ids: [{ schema: 'INSPIRE BAI', value: 'R.Clarke.1' }],
  },
  {
    full_name: 'Cleland, Bill',
    record: { $ref: 'https://inspirehep.net/api/authors/1013385' },
    affiliations: [{ value: 'Pittsburgh U.' }],
    ids: [{ schema: 'INSPIRE BAI', value: 'B.Cleland.1' }],
  },
  {
    full_name: 'Clemens, Jean-Claude',
    record: { $ref: 'https://inspirehep.net/api/authors/1013382' },
    affiliations: [{ value: 'Marseille, CPPM' }],
    ids: [{ schema: 'INSPIRE BAI', value: 'J.C.Clemens.1' }],
  },
];
