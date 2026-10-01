/**
 * @fileoverview Tests for cern_inspire_list_reference: topic validation, the
 * static entries per topic (and their agreement with the vocabulary and the
 * input validators the tools use), `format()` carrying the same data as
 * `structuredContent`, table integrity, and zero upstream calls. The tool
 * declares no error contract and no enrichment, so there is no zero-result or
 * under-cap enrichment case to run.
 * @module tests/tools/list-reference.tool.test
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { listReferenceTool } from '@/mcp-server/tools/definitions/list-reference.tool.js';
import { paperInput } from '@/mcp-server/tools/inputs.js';
import {
  classifyPaperId,
  normalizePaperId,
  routeAuthorQuery,
} from '@/services/inspire/identifiers.js';
import { DOCUMENT_TYPES, SUBJECTS } from '@/services/inspire/vocabulary.js';

const TOPICS = [
  'search_syntax',
  'identifiers',
  'document_types',
  'subjects',
  'citation_buckets',
  'hepdata',
] as const;

/** The tool's table-cell escaping: backslashes, then pipes. */
const cellText = (text: string) => text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');

interface Entry {
  example?: string;
  meaning: string;
  term: string;
}

type Topic = (typeof TOPICS)[number];

const run = async (topic: Topic) => {
  const result = await runToolContract(listReferenceTool, { topic });
  expect(result.isError).toBeFalsy();
  const output = result.structuredContent as { entries: Entry[]; topic: Topic };
  const text = (result.content[0] as { text: string }).text;
  return { result, output, text };
};

/** Splits a markdown table row on its unescaped pipes, dropping the empty edge cells. */
const cells = (row: string) => row.split(/(?<!\\)\|/).slice(1, -1);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('input', () => {
  it.each(TOPICS)('accepts topic %s', (topic) => {
    expect(listReferenceTool.input.safeParse({ topic }).success).toBe(true);
  });

  it.each([
    [{}],
    [{ topic: '' }],
    [{ topic: 'Search_Syntax' }],
    [{ topic: 'syntax' }],
    [{ topic: ' hepdata' }],
    [{ topic: null }],
    [{ topic: 3 }],
    [{ topic: ['hepdata'] }],
  ])('rejects %j', (input) => {
    expect(listReferenceTool.input.safeParse(input).success).toBe(false);
  });

  it('answers a missing or blank topic with InvalidParams and no entries', async () => {
    const blank = await runToolContract(listReferenceTool, { topic: '' as Topic });
    const missing = await runToolContract(listReferenceTool, {} as { topic: Topic });

    for (const result of [blank, missing]) {
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: { code: JsonRpcErrorCode.InvalidParams },
      });
    }
  });

  it('is annotated read-only, idempotent, and closed-world', () => {
    expect(listReferenceTool.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('declares no error contract and no enrichment', () => {
    expect(listReferenceTool.errors ?? []).toEqual([]);
    expect(listReferenceTool.enrichment).toBeUndefined();
  });
});

describe.each(TOPICS)('topic %s', (topic) => {
  it('returns the topic and a non-empty, well-formed entry list', async () => {
    const { output } = await run(topic);

    expect(output.topic).toBe(topic);
    expect(output.entries.length).toBeGreaterThan(0);
    for (const entry of output.entries) {
      expect(entry.term.trim()).not.toBe('');
      expect(entry.meaning.trim()).not.toBe('');
      if (entry.example !== undefined) expect(entry.example.trim()).not.toBe('');
    }
  });

  it('has unique terms', async () => {
    const { output } = await run(topic);
    const terms = output.entries.map((e) => e.term);

    expect(new Set(terms).size).toBe(terms.length);
  });

  it('validates against its own output schema', async () => {
    const { output } = await run(topic);

    expect(output).toEqual(expect.schemaMatching(listReferenceTool.output));
  });

  it('renders every term, meaning, and example into content[] as a three-column table', async () => {
    const { output, text } = await run(topic);

    const lines = text.split('\n');
    expect(lines[0]).toBe(`## INSPIRE reference: ${topic}`);
    expect(lines[2]).toBe('| Term | Meaning | Example |');
    const rows = lines.slice(4);
    expect(rows).toHaveLength(output.entries.length);
    rows.forEach((row, i) => {
      const entry = output.entries[i];
      expect(cells(row)).toHaveLength(3);
      expect(row).toContain(cellText(entry?.term ?? ''));
      expect(row).toContain(cellText(entry?.meaning ?? ''));
      expect(row).toContain(entry?.example ? cellText(entry.example) : '—');
    });
  });

  it('returns identical data on every call', async () => {
    const first = (await run(topic)).output;
    const second = (await run(topic)).output;

    expect(second).toEqual(first);
  });

  it('makes no upstream request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await run(topic);
    await listReferenceTool.handler(listReferenceTool.input.parse({ topic }), createMockContext());

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('vocabulary topics', () => {
  it('lists the 13 document types in the vocabulary order', async () => {
    const { output } = await run('document_types');

    expect(output.entries.map((e) => e.term)).toEqual([...DOCUMENT_TYPES]);
    expect(output.entries).toHaveLength(13);
  });

  it('lists the 18 subjects in the vocabulary order', async () => {
    const { output } = await run('subjects');

    expect(output.entries.map((e) => e.term)).toEqual([...SUBJECTS]);
    expect(output.entries).toHaveLength(18);
  });

  it('says that document types and subjects combine with AND, not OR', async () => {
    const types = (await run('document_types')).output.entries.find((e) => e.term === 'published');
    const syntax = (await run('search_syntax')).output.entries.find((e) => /filters/.test(e.term));

    expect(types?.meaning).toContain('published + review = published reviews');
    expect(syntax?.meaning).toMatch(/ALL hold/);
  });

  it('lists the seven citation-bucket ranges the summary tool reports', async () => {
    const { output } = await run('citation_buckets');

    const ranges = output.entries[0]?.term ?? '';
    for (const range of ['0', '1–9', '10–49', '50–99', '100–249', '250–499', '500+']) {
      expect(ranges).toContain(range);
    }
  });
});

describe('examples agree with the validators the tools use', () => {
  const example = async (topic: Topic, term: string) => {
    const entry = (await run(topic)).output.entries.find((e) => e.term === term);
    if (!entry?.example) throw new Error(`no example for ${topic}/${term}`);
    return entry.example;
  };

  it('gives a recid, arXiv ID, and DOI example that the paper input accepts as that kind', async () => {
    const recid = await example('identifiers', 'recid');
    const arxiv = await example('identifiers', 'arXiv ID');
    const doi = await example('identifiers', 'DOI');

    expect(classifyPaperId(normalizePaperId(recid))).toBe('recid');
    expect(classifyPaperId(normalizePaperId(arxiv))).toBe('arxiv');
    expect(classifyPaperId(normalizePaperId(doi))).toBe('doi');
    for (const id of [recid, arxiv, doi]) {
      expect(paperInput.safeParse(id).success).toBe(true);
    }
  });

  it('gives a HEPData ins<recid> example the paper input reduces to a recid', async () => {
    const ins = await example('identifiers', 'HEPData ins<recid>');

    expect(ins).toMatch(/^ins\d+$/);
    expect(classifyPaperId(normalizePaperId(ins))).toBe('recid');
  });

  it.each([
    ['INSPIRE BAI', 'bai'],
    ['ORCID', 'orcid'],
    ['INSPIRE ID', 'inspire_id'],
    ['author recid', 'recid'],
  ] as const)('gives a %s example that author routing reads as %s', async (term, matchedAs) => {
    expect(routeAuthorQuery(await example('identifiers', term)).matchedAs).toBe(matchedAs);
  });

  it('keeps the arXiv example free of a version suffix', async () => {
    expect(await example('search_syntax', 'arxiv:ID')).not.toMatch(/v\d+$/);
  });
});

describe('format', () => {
  const render = (output: Parameters<NonNullable<typeof listReferenceTool.format>>[0]): string => {
    const block = listReferenceTool.format?.(output)[0];
    return block?.type === 'text' ? block.text : '';
  };

  it('escapes a pipe in a term, meaning, or example so the row keeps three columns', () => {
    const text = render({
      topic: 'search_syntax',
      entries: [{ term: 'a | b', meaning: 'x|y', example: '|V_{cb}|' }],
    });

    const row = text.split('\n').at(-1) ?? '';
    expect(row).toBe('| `a \\| b` | x\\|y | `\\|V_{cb}\\|` |');
    expect(cells(row)).toHaveLength(3);
  });

  it('renders "—" for an entry without an example', () => {
    const text = render({
      topic: 'hepdata',
      entries: [{ term: 'versions', meaning: 'one or more' }],
    });

    expect(text.split('\n').at(-1)).toBe('| `versions` | one or more | — |');
  });

  it('renders an empty entry list as just the heading and table header', () => {
    expect(render({ topic: 'hepdata', entries: [] })).toBe(
      '## INSPIRE reference: hepdata\n\n| Term | Meaning | Example |\n|:-----|:--------|:--------|',
    );
  });
});
