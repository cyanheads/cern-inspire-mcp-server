/**
 * @fileoverview Tests for the paper and author identifier helpers: every URL and
 * prefix form `normalizePaperId` reduces, what `classifyPaperId` accepts and
 * refuses, the author normalizations, and the author query routing.
 * @module tests/shared/identifiers.test
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  classifyPaperId,
  containsOrcid,
  normalizeAuthorId,
  normalizePaperId,
  PAPER_ID_PATTERN,
  routeAuthorQuery,
} from '@/services/inspire/identifiers.js';

const DOI = '10.1016/j.physletb.2012.08.020';

describe('normalizePaperId', () => {
  it.each([
    // recid and whitespace
    ['451647', '451647'],
    ['  451647 ', '451647'],
    ['\t451647\n', '451647'],
    // arXiv prefixes and version suffixes
    ['1207.7214', '1207.7214'],
    ['arXiv:1207.7214', '1207.7214'],
    ['ARXIV:1207.7214', '1207.7214'],
    ['arxiv:1207.7214v2', '1207.7214'],
    ['1207.7214v12', '1207.7214'],
    ['hep-th/9711200', 'hep-th/9711200'],
    ['arXiv:hep-th/9711200', 'hep-th/9711200'],
    ['hep-th/9711200v3', 'hep-th/9711200'],
    ['math.AG/0601001v2', 'math.AG/0601001'],
    // arxiv.org URLs
    ['https://arxiv.org/abs/1207.7214', '1207.7214'],
    ['http://arxiv.org/abs/1207.7214', '1207.7214'],
    ['https://www.arxiv.org/abs/1207.7214', '1207.7214'],
    ['https://export.arxiv.org/abs/1207.7214', '1207.7214'],
    ['https://arxiv.org/abs/1207.7214v3', '1207.7214'],
    ['https://arxiv.org/abs/1207.7214/', '1207.7214'],
    ['https://arxiv.org/pdf/1207.7214', '1207.7214'],
    ['https://arxiv.org/pdf/1207.7214.pdf', '1207.7214'],
    ['https://arxiv.org/pdf/1207.7214v2.pdf', '1207.7214'],
    ['https://arxiv.org/abs/hep-th/9711200', 'hep-th/9711200'],
    ['https://arxiv.org/pdf/hep-th/9711200v2.pdf', 'hep-th/9711200'],
    ['HTTPS://ARXIV.ORG/ABS/1207.7214', '1207.7214'],
    // DOI prefixes and URLs
    [DOI, DOI],
    [`doi:${DOI}`, DOI],
    [`DOI:${DOI}`, DOI],
    [`https://doi.org/${DOI}`, DOI],
    [`http://doi.org/${DOI}`, DOI],
    [`https://dx.doi.org/${DOI}`, DOI],
    [`http://dx.doi.org/${DOI}`, DOI],
    [`HTTPS://DOI.ORG/${DOI}`, DOI],
    [`doi:https://doi.org/${DOI}`, DOI],
    ['https://doi.org/10.1016/S0370-2693(98)00377-3', '10.1016/S0370-2693(98)00377-3'],
    // INSPIRE URLs
    ['https://inspirehep.net/literature/451647', '451647'],
    ['https://inspirehep.net/literature/451647/', '451647'],
    ['https://www.inspirehep.net/literature/451647', '451647'],
    ['https://inspirehep.net/api/literature/451647', '451647'],
    ['https://inspirehep.net/literature/451647?ui-citation-summary=true', '451647'],
    ['https://inspirehep.net/literature/451647#abstract', '451647'],
    // HEPData keys and URLs
    ['ins1124337', '1124337'],
    ['INS1124337', '1124337'],
    ['https://www.hepdata.net/record/ins1124337', '1124337'],
    ['https://hepdata.net/record/ins1124337/', '1124337'],
    ['https://www.hepdata.net/record/ins1124337?version=2', '1124337'],
  ])('reduces %j to %j', (input, expected) => {
    expect(normalizePaperId(input)).toBe(expected);
  });

  it.each([
    'hello',
    '',
    'ins',
    'ins1207.7214',
    'https://inspirehep.net/authors/983328',
    'https://inspirehep.net/literature/451647/references',
    'https://www.hepdata.net/record/1124337',
    'https://example.org/abs/1207.7214',
    'arxiv.org/abs/1207.7214',
  ])('passes %j through unmapped for the pattern check to reject', (input) => {
    expect(classifyPaperId(normalizePaperId(input))).toBeUndefined();
  });

  it('keeps an upper-case V as part of the string (only a lower-case vN suffix is a version)', () => {
    expect(normalizePaperId('1207.7214V2')).toBe('1207.7214V2');
  });

  it('is idempotent on every normalized form', () => {
    for (const input of [
      '1207.7214v2',
      'https://arxiv.org/pdf/hep-th/9711200v2.pdf',
      `doi:https://doi.org/${DOI}`,
      'https://www.hepdata.net/record/ins1124337',
      '451647',
    ]) {
      const once = normalizePaperId(input);
      expect(normalizePaperId(once)).toBe(once);
    }
  });
});

describe('classifyPaperId', () => {
  it.each([
    ['1', 'recid'],
    ['451647', 'recid'],
    ['123456789', 'recid'],
    ['0704.0001', 'arxiv'],
    ['2401.12345', 'arxiv'],
    ['hep-th/9711200', 'arxiv'],
    ['math.AG/0601001', 'arxiv'],
    ['astro-ph/0001001', 'arxiv'],
    ['solv-int/9701001', 'arxiv'],
    [DOI, 'doi'],
    ['10.1234/x', 'doi'],
    ['10.123456789/x', 'doi'],
    ['10.1016/S0370-2693(98)00377-3', 'doi'],
  ])('classifies %j as %s', (id, kind) => {
    expect(classifyPaperId(id)).toBe(kind);
  });

  it.each([
    '',
    '1234567890',
    '2401.123',
    '24011.2345',
    '2401.123456',
    'hep-th/971120',
    'hep-th/97112000',
    'HEP-TH/9711200',
    'math.ag/0601001',
    'hep_th/9711200',
    '10.12/x',
    '10.1016/',
    '10.1016/a b',
    '10.1234567890/x',
    '11.1016/x',
    ' 451647',
    '451647 ',
    '-1',
    '1e5',
  ])('classifies %j as nothing', (id) => {
    expect(classifyPaperId(id)).toBeUndefined();
  });

  it('agrees with PAPER_ID_PATTERN on arbitrary identifier-shaped strings', () => {
    const alphabet = fc.constantFrom(...'0123456789.-/vabhepthAGMdoi10 ');
    fc.assert(
      fc.property(fc.string({ unit: alphabet, maxLength: 24 }), (text) => {
        expect(PAPER_ID_PATTERN.test(text)).toBe(classifyPaperId(text) !== undefined);
      }),
      { numRuns: 2_000 },
    );
  });
});

describe('normalizeAuthorId', () => {
  it.each([
    ['0000-0002-7752-6073', '0000-0002-7752-6073'],
    ['  0000-0002-7752-6073 ', '0000-0002-7752-6073'],
    ['https://orcid.org/0000-0002-7752-6073', '0000-0002-7752-6073'],
    ['http://orcid.org/0000-0002-7752-6073', '0000-0002-7752-6073'],
    ['https://www.orcid.org/0000-0002-7752-6073', '0000-0002-7752-6073'],
    ['https://orcid.org/0000-0002-7752-6073/', '0000-0002-7752-6073'],
    ['HTTPS://ORCID.ORG/0000-0002-7752-6073', '0000-0002-7752-6073'],
    ['0000-0002-1694-233x', '0000-0002-1694-233X'],
    ['https://orcid.org/0000-0002-1694-233x', '0000-0002-1694-233X'],
    ['inspire-00136372', 'INSPIRE-00136372'],
    ['Inspire-00136372', 'INSPIRE-00136372'],
    ['INSPIRE-00136372', 'INSPIRE-00136372'],
    ['inspire-0013637', 'inspire-0013637'],
    ['Edward.Witten.1', 'Edward.Witten.1'],
    ['edward.witten.1', 'edward.witten.1'],
    ['J.Doe.1', 'J.Doe.1'],
    ['  Doe, Jane ', 'Doe, Jane'],
    ['983328', '983328'],
    [
      'https://sandbox.orcid.org/0000-0002-7752-6073',
      'https://sandbox.orcid.org/0000-0002-7752-6073',
    ],
  ])('reduces %j to %j', (input, expected) => {
    expect(normalizeAuthorId(input)).toBe(expected);
  });
});

describe('routeAuthorQuery', () => {
  it.each([
    ['0000-0002-7752-6073', 'orcid', 'ids.value:0000-0002-7752-6073'],
    ['0000-0002-1694-233X', 'orcid', 'ids.value:0000-0002-1694-233X'],
    ['INSPIRE-00136372', 'inspire_id', 'ids.value:INSPIRE-00136372'],
    ['Edward.Witten.1', 'bai', 'ids.value:Edward.Witten.1'],
    ['J.Doe.1', 'bai', 'ids.value:J.Doe.1'],
    ["J.O'Neil.2", 'bai', "ids.value:J.O'Neil.2"],
    ['Jean-Luc.Doe.12', 'bai', 'ids.value:Jean-Luc.Doe.12'],
    ['Doe.1', 'bai', 'ids.value:Doe.1'],
    ['983328', 'recid', 'control_number:983328'],
    ['1', 'recid', 'control_number:1'],
    ['Doe, Jane', 'name', 'Doe, Jane'],
    ['Jane Doe', 'name', 'Jane Doe'],
    ['Doe', 'name', 'Doe'],
    ['0000-0002-1694-233x', 'name', '0000-0002-1694-233x'],
    ['inspire-00136372', 'name', 'inspire-00136372'],
    ['INSPIRE-0013637', 'name', 'INSPIRE-0013637'],
    ['1234567890', 'name', '1234567890'],
    ['Jane.Doe', 'name', 'Jane.Doe'],
  ])('routes %j as %s (q=%s)', (query, matchedAs, q) => {
    expect(routeAuthorQuery(query)).toEqual({ matchedAs, q });
  });

  it('sends a name as written, without field syntax', () => {
    expect(routeAuthorQuery('a Doe, Jane').q).toBe('a Doe, Jane');
  });
});

describe('containsOrcid', () => {
  it.each([
    ['0000-0002-7752-6073', true],
    ['a 0000-0002-7752-6073', true],
    ['a 0000-0002-7752-6073 and t higgs', true],
    ['0000-0002-1694-233X', true],
    ['0000-0002-1694-233x', true],
    ['author:0000-0002-7752-6073', true],
    ['(0000-0002-7752-6073)', true],
    ['10000-0002-7752-6073', false],
    ['0000-0002-7752-60731', false],
    ['0000-0002-7752', false],
    ['t higgs boson', false],
    ['', false],
  ])('%j → %s', (text, expected) => {
    expect(containsOrcid(text)).toBe(expected);
  });
});
