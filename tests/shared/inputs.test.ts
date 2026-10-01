/**
 * @fileoverview Tests for the shared tool input schemas and echo helpers: the
 * `paper` preprocess, `blankAsUnset` (form clients send `""` for an unset
 * optional), the enum-array inputs and their max + 1 cut, year bounds, author
 * identifier normalization, and the `appliedFilters` echo string.
 * @module tests/shared/inputs.test
 */

import { z } from '@cyanheads/mcp-ts-core';
import { describe, expect, it } from 'vitest';
import {
  authorIdInput,
  authorQueryInput,
  blankAsUnset,
  documentTypesInput,
  formatAppliedFilters,
  hasFacetFilters,
  paperInput,
  subjectsInput,
  yearFromInput,
  yearRangeLabel,
  yearToInput,
} from '@/mcp-server/tools/inputs.js';
import { DOCUMENT_TYPES, SUBJECTS } from '@/services/inspire/vocabulary.js';

/** Parses `{ v: value }` through a one-field object, as a tool's input schema would. */
const field = <T extends z.ZodType>(schema: T, value?: unknown) =>
  z.object({ v: schema }).safeParse(value === undefined ? {} : { v: value });

const parsed = <T extends z.ZodType>(schema: T, value?: unknown): unknown => {
  const result = field(schema, value);
  if (!result.success) throw new Error(`rejected: ${result.error.message}`);
  return (result.data as { v?: unknown }).v;
};

describe('paperInput', () => {
  it.each([
    ['451647', '451647'],
    [' 451647 ', '451647'],
    ['1207.7214', '1207.7214'],
    ['arXiv:1207.7214v2', '1207.7214'],
    ['https://arxiv.org/abs/1207.7214', '1207.7214'],
    ['https://arxiv.org/pdf/1207.7214v2.pdf', '1207.7214'],
    ['hep-th/9711200', 'hep-th/9711200'],
    ['arXiv:hep-th/9711200', 'hep-th/9711200'],
    ['https://arxiv.org/abs/hep-th/9711200v1', 'hep-th/9711200'],
    ['math.AG/0601001', 'math.AG/0601001'],
    ['HEP-TH/9711200', 'hep-th/9711200'],
    ['MATH.AG/0601001', 'math.AG/0601001'],
    ['10.1016/j.physletb.2012.08.020', '10.1016/j.physletb.2012.08.020'],
    ['doi:10.1016/j.physletb.2012.08.020', '10.1016/j.physletb.2012.08.020'],
    ['https://doi.org/10.1016/j.physletb.2012.08.020', '10.1016/j.physletb.2012.08.020'],
    ['http://dx.doi.org/10.1016/j.physletb.2012.08.020', '10.1016/j.physletb.2012.08.020'],
    ['https://inspirehep.net/literature/451647', '451647'],
    ['https://inspirehep.net/api/literature/451647', '451647'],
    ['https://www.hepdata.net/record/ins1124337', '1124337'],
    ['ins1124337', '1124337'],
  ])('accepts %j and hands the handler %j', (input, expected) => {
    expect(parsed(paperInput, input)).toBe(expected);
  });

  it.each([
    '',
    '   ',
    'hello',
    '1207.72',
    '1234567890',
    'math.ag/0601001',
    '10.1016/',
    'https://example.org/1207.7214',
    'https://inspirehep.net/authors/983328',
    'doi:',
    'ins',
  ])('rejects %j with the pattern message', (input) => {
    const result = field(paperInput, input);

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues[0]?.message).toContain(
      'Expected an INSPIRE recid',
    );
  });

  it.each([123, null, true, ['451647'], {}])('rejects the non-string %j', (value) => {
    expect(field(paperInput, value).success).toBe(false);
  });

  it('is required: a missing paper is rejected', () => {
    expect(field(paperInput).success).toBe(false);
  });

  it('describes every accepted form in its JSON Schema', () => {
    const schema = z.toJSONSchema(z.object({ paper: paperInput }), { io: 'input' });

    expect(schema.required).toEqual(['paper']);
    const properties = (schema.properties ?? {}) as Record<string, { description?: string }>;
    const description = properties.paper?.description ?? '';
    for (const form of ['recid', 'arXiv', 'DOI', 'doi.org', 'inspirehep.net']) {
      expect(description).toContain(form);
    }
  });
});

describe('blankAsUnset', () => {
  const optionalText = blankAsUnset(z.string().optional());
  const sort = blankAsUnset(z.enum(['relevance', 'mostcited']).default('relevance'));

  it('reads "" on an optional string as unset', () => {
    expect(parsed(optionalText, '')).toBeUndefined();
    expect(z.object({ v: optionalText }).parse({ v: '' })).toEqual({});
  });

  it('passes a real value and an omitted key through', () => {
    expect(parsed(optionalText, 'x')).toBe('x');
    expect(z.object({ v: optionalText }).parse({})).toEqual({});
  });

  it('takes the default for "", for undefined, and for an omitted key', () => {
    expect(parsed(sort, '')).toBe('relevance');
    expect(parsed(sort, undefined)).toBe('relevance');
    expect(z.object({ v: sort }).parse({})).toEqual({ v: 'relevance' });
  });

  it('still validates a non-blank value against the enum', () => {
    expect(parsed(sort, 'mostcited')).toBe('mostcited');
    expect(field(sort, 'bogus').success).toBe(false);
    expect(field(sort, 'MOSTCITED').success).toBe(false);
  });

  it('treats only the empty string as blank: whitespace and null are not', () => {
    expect(parsed(optionalText, ' ')).toBe(' ');
    expect(field(optionalText, null).success).toBe(false);
    expect(field(sort, ' ').success).toBe(false);
  });

  it('keeps an optional field out of the JSON Schema required list', () => {
    const schema = z.toJSONSchema(z.object({ q: optionalText, sort }), { io: 'input' });

    expect(schema.required ?? []).toEqual([]);
  });
});

describe.each([
  ['documentTypesInput', documentTypesInput, DOCUMENT_TYPES],
  ['subjectsInput', subjectsInput, SUBJECTS],
] as const)('%s', (_name, schema, vocabulary) => {
  const [first, second, third, fourth, fifth] = vocabulary;

  it.each([[undefined], [''], [[]], [','], [' , , '], [[' ', '']]])(
    'reads %j as unset',
    (value) => {
      expect(parsed(schema, value)).toBeUndefined();
      expect(z.object({ v: schema }).parse(value === undefined ? {} : { v: value })).toEqual({});
    },
  );

  it('accepts an array', () => {
    expect(parsed(schema, [first, second])).toEqual([first, second]);
  });

  it('accepts a comma-joined string, trimming each entry', () => {
    expect(parsed(schema, `${first}, ${second} ,${third}`)).toEqual([first, second, third]);
  });

  it('accepts a single value as a string', () => {
    expect(parsed(schema, first)).toEqual([first]);
  });

  it('folds case to the canonical spelling, in arrays and strings', () => {
    expect(parsed(schema, [first.toUpperCase(), second.toLowerCase()])).toEqual([first, second]);
    expect(parsed(schema, `${first.toUpperCase()},${second.toLowerCase()}`)).toEqual([
      first,
      second,
    ]);
  });

  it('de-duplicates after folding, keeping first-seen order', () => {
    expect(parsed(schema, [second, first, second.toUpperCase(), first])).toEqual([second, first]);
  });

  it('drops empty entries between commas', () => {
    expect(parsed(schema, `${first},,${second},`)).toEqual([first, second]);
  });

  it('accepts exactly four distinct values', () => {
    expect(parsed(schema, [first, second, third, fourth])).toEqual([first, second, third, fourth]);
  });

  it('accepts five entries that de-duplicate to four', () => {
    expect(parsed(schema, [first, second, third, fourth, first])).toEqual([
      first,
      second,
      third,
      fourth,
    ]);
  });

  it('rejects five distinct values with exactly one bounded issue', () => {
    const result = field(schema, [first, second, third, fourth, fifth]);

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues).toHaveLength(1);
    expect(!result.success && result.error.issues[0]).toMatchObject({
      code: 'too_big',
      path: ['v'],
    });
  });

  it('cuts an oversized list before validation: one too_big issue, not one per element', () => {
    const result = field(schema, vocabulary);

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues).toHaveLength(1);
    expect(!result.success && result.error.issues[0]?.code).toBe('too_big');
  });

  it('bounds the issues for an oversized list of invalid values to the first max + 1', () => {
    const junk = Array.from({ length: 200 }, (_, i) => `bogus-${i}`);

    const result = field(schema, junk);

    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.length).toBeLessThanOrEqual(6);
    expect(issues.length).toBeGreaterThan(0);
  });

  it('rejects an unknown value and names its position', () => {
    const result = field(schema, `${first},not-a-value`);

    expect(result.success).toBe(false);
    expect(!result.success && result.error.issues).toEqual([
      expect.objectContaining({ code: 'invalid_value', path: ['v', 1] }),
    ]);
  });

  it.each([[null], [7], [{ a: 1 }], [true]])('rejects the non-list %j', (value) => {
    expect(field(schema, value).success).toBe(false);
  });

  it('rejects non-string array entries', () => {
    expect(field(schema, [first, 5]).success).toBe(false);
  });

  it('declares itself an optional array of at most four enum values in JSON Schema', () => {
    const json = z.toJSONSchema(z.object({ v: schema }), { io: 'input' });
    const property = json.properties?.v as {
      description?: string;
      items?: { enum?: string[] };
      maxItems?: number;
      type?: string;
    };

    expect(json.required ?? []).toEqual([]);
    expect(property.type).toBe('array');
    expect(property.maxItems).toBe(4);
    expect(property.items?.enum).toEqual([...vocabulary]);
    expect(property.description).toMatch(/ALL hold/);
  });
});

describe('year inputs', () => {
  describe.each([
    ['yearFromInput', yearFromInput],
    ['yearToInput', yearToInput],
  ])('%s', (_name, schema) => {
    it.each([1900, 2012, 2100])('accepts %i', (value) => {
      expect(parsed(schema, value)).toBe(value);
    });

    it.each([[1899], [2101], [0], [-1], [2012.5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
      'rejects %j',
      (value) => {
        expect(field(schema, value).success).toBe(false);
      },
    );

    it('reads "" and an omitted key as unset', () => {
      expect(parsed(schema, '')).toBeUndefined();
      expect(z.object({ v: schema }).parse({})).toEqual({});
      expect(z.object({ v: schema }).parse({ v: '' })).toEqual({});
    });

    it.each([['2012'], [' '], [null], [true]])('rejects the non-number %j', (value) => {
      expect(field(schema, value).success).toBe(false);
    });

    it('is a bounded integer in JSON Schema and not required', () => {
      const json = z.toJSONSchema(z.object({ v: schema }), { io: 'input' });

      expect(json.required ?? []).toEqual([]);
      expect(json.properties?.v).toMatchObject({ type: 'integer', minimum: 1900, maximum: 2100 });
    });
  });
});

describe('authorQueryInput', () => {
  it.each([
    ['Doe, Jane', 'Doe, Jane'],
    ['  Doe, Jane  ', 'Doe, Jane'],
    ['Jane.Doe.1', 'Jane.Doe.1'],
    ['https://orcid.org/0000-0002-7752-6073', '0000-0002-7752-6073'],
    ['0000-0002-1694-233x', '0000-0002-1694-233X'],
    ['inspire-00136372', 'INSPIRE-00136372'],
    ['983328', '983328'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(parsed(authorQueryInput, input)).toBe(expected);
  });

  it.each(['', '   ', 'x'.repeat(201)])('rejects %j', (input) => {
    expect(field(authorQueryInput, input).success).toBe(false);
  });

  it('accepts exactly 200 characters', () => {
    expect(field(authorQueryInput, 'x'.repeat(200)).success).toBe(true);
  });

  it('is required', () => {
    expect(field(authorQueryInput).success).toBe(false);
  });
});

describe('authorIdInput', () => {
  it.each([
    ['Jane.Doe.1', 'Jane.Doe.1'],
    ['https://orcid.org/0000-0002-7752-6073', '0000-0002-7752-6073'],
    ['inspire-00136372', 'INSPIRE-00136372'],
    ['983328', '983328'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(parsed(authorIdInput, input)).toBe(expected);
  });

  it.each([[''], ['   '], [undefined]])('reads %j as unset', (value) => {
    expect(parsed(authorIdInput, value)).toBeUndefined();
    expect(z.object({ v: authorIdInput }).parse(value === undefined ? {} : { v: value })).toEqual(
      {},
    );
  });

  it('passes a name through for the handler to refuse with author_not_identifier', () => {
    expect(parsed(authorIdInput, 'Doe, Jane')).toBe('Doe, Jane');
  });

  it('rejects over 200 characters and non-strings', () => {
    expect(field(authorIdInput, 'x'.repeat(201)).success).toBe(false);
    expect(field(authorIdInput, 5).success).toBe(false);
    expect(field(authorIdInput, null).success).toBe(false);
  });

  it('is not required in JSON Schema', () => {
    expect(z.toJSONSchema(z.object({ v: authorIdInput }), { io: 'input' }).required ?? []).toEqual(
      [],
    );
  });
});

describe('yearRangeLabel', () => {
  it.each([
    [2012, 2015, '2012–2015'],
    [2012, undefined, '2012–'],
    [undefined, 1990, '–1990'],
    [2012, 2012, '2012–2012'],
    [undefined, undefined, undefined],
  ])('(%j, %j) → %j', (from, to, expected) => {
    expect(yearRangeLabel(from, to)).toBe(expected);
  });
});

describe('formatAppliedFilters', () => {
  it('is "none" when nothing narrows or reorders the result', () => {
    expect(formatAppliedFilters({})).toBe('none');
    expect(formatAppliedFilters({ sort: 'relevance' })).toBe('none');
    expect(formatAppliedFilters({ sort: '' })).toBe('none');
    expect(
      formatAppliedFilters({ documentTypes: [], subjects: [], excludeSelfCitations: false }),
    ).toBe('none');
  });

  it('echoes a non-default sort', () => {
    expect(formatAppliedFilters({ sort: 'mostcited' })).toBe('sort=mostcited');
  });

  it('joins every applied filter with "; " in a fixed order', () => {
    expect(
      formatAppliedFilters({
        sort: 'mostcited',
        documentTypes: ['published'],
        yearFrom: 2012,
        yearTo: 2015,
      }),
    ).toBe('sort=mostcited; document_types=published; years=2012–2015');

    expect(
      formatAppliedFilters({
        sort: 'mostrecent',
        documentTypes: ['published', 'review'],
        subjects: ['Theory-HEP', 'Lattice'],
        yearFrom: 2012,
        excludeSelfCitations: true,
      }),
    ).toBe(
      'sort=mostrecent; document_types=published,review; subjects=Theory-HEP,Lattice; years=2012–; exclude_self_citations=true',
    );
  });

  it('echoes an open-start year range', () => {
    expect(formatAppliedFilters({ yearTo: 1990 })).toBe('years=–1990');
  });

  it('echoes self-citation exclusion alone', () => {
    expect(formatAppliedFilters({ excludeSelfCitations: true })).toBe(
      'exclude_self_citations=true',
    );
  });
});

describe('hasFacetFilters', () => {
  it.each([
    [{}, false],
    [{ documentTypes: [], subjects: [] }, false],
    [{ documentTypes: ['published'] }, true],
    [{ subjects: ['Lattice'] }, true],
    [{ yearFrom: 2012 }, true],
    [{ yearTo: 1990 }, true],
  ] as const)('%j → %s', (filters, expected) => {
    expect(hasFacetFilters(filters)).toBe(expected);
  });
});
