/** @fileoverview Selected public metadata of INSPIRE proceedings 1500425, captured during validation. */
import type { RawLiteratureMetadata } from '@/services/inspire/types.js';

/** Recorded editors and attached full text; no attachment contents. */
export const PROCEEDINGS_METADATA = {
  control_number: 1500425,
  author_count: 3,
  authors: [
    { full_name: 'Dahmke, Stefan K.G.', inspire_roles: ['editor'] },
    { full_name: 'Meyer, Mikko', inspire_roles: ['editor'] },
    { full_name: 'Vanhoefer, Laura', inspire_roles: ['editor'] },
  ],
  documents: [
    {
      filename: 'fulltext.pdf',
      fulltext: true,
      url: 'https://inspirehep.net/files/357195b6adc92a693a72ec7c49bb90df',
    },
  ],
} satisfies RawLiteratureMetadata;
