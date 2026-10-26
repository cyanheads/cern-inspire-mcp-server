/** @fileoverview Contributor and attachment metadata through the dossier normalization seam. */
import { describe, expect, it } from 'vitest';
import { toPaperLookup } from '@/services/inspire/normalize.js';
import type { RawLiteratureMetadata } from '@/services/inspire/types.js';

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
