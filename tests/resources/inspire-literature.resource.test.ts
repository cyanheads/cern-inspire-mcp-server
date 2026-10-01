/**
 * @fileoverview Tests for the `inspire://literature/{recid}` resource: param
 * validation, the dossier it returns (same data as `cern_inspire_get_paper` with
 * the default author cap), the declared `paper_not_found` contract with the
 * recid in its data, a failed HEPData availability lookup failing the read with
 * its own error, and the upstream failure classes the resource declares. The
 * handler runs on an `InspireService` over a
 * fake fetch; no live network.
 * @module tests/resources/inspire-literature.resource.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createMockContext, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allResourceDefinitions } from '@/mcp-server/resources/definitions/index.js';
import { inspireLiteratureResource } from '@/mcp-server/resources/definitions/inspire-literature.resource.js';
import { getPaperTool } from '@/mcp-server/tools/definitions/get-paper.tool.js';
import {
  dataPage,
  dossierMetadata,
  emptyBody,
  HIGGS,
  htmlResponse,
  jsonResponse,
  literaturePage,
  rateLimitResponse,
} from '../fixtures/inspire-upstream.js';
import {
  type ServiceHarness,
  settleWithFakeTimers,
  startHarness,
  stopHarness,
} from '../fixtures/service-harness.js';

vi.mock('@/services/inspire/inspire-service.js', async (importOriginal) =>
  (await import('../fixtures/active-service.js')).withActiveService(await importOriginal()),
);

let h: ServiceHarness;

/** The resource's params schema, which a `resource()` definition may leave undefined. */
function paramsSchema() {
  const schema = inspireLiteratureResource.params;
  if (!schema) throw new Error('the resource declares no params schema');
  return schema;
}

beforeEach(() => {
  h = startHarness();
});

afterEach(() => {
  stopHarness();
  vi.useRealTimers();
});

const routeRecord = (metadata = dossierMetadata(3)) =>
  h.route('/literature', jsonResponse(literaturePage([metadata])));
const routeData = (body: unknown = dataPage()) => h.route('/data', jsonResponse(body));

const read = async (recid: string) =>
  await inspireLiteratureResource.handler(
    paramsSchema().parse({ recid }),
    createMockContext({
      errors: inspireLiteratureResource.errors,
      uri: new URL(`inspire://literature/${recid}`),
    }),
  );

/** Rejection of `read`, run on fake timers so a retry ladder settles instantly. */
const readFailure = async (recid: string): Promise<McpError> => {
  const outcome = await settleWithFakeTimers(() => read(recid));
  if (outcome.ok) throw new Error('expected the read to fail');
  expect(outcome.error).toBeInstanceOf(McpError);
  return outcome.error as McpError;
};

describe('definition', () => {
  it('is registered under its URI template with the JSON mime type and a one-hour public cache hint', () => {
    expect(allResourceDefinitions).toContain(inspireLiteratureResource);
    expect(inspireLiteratureResource.name).toBe('inspire_literature');
    expect(inspireLiteratureResource.mimeType).toBe('application/json');
    expect(inspireLiteratureResource.cacheHint).toEqual({ ttlMs: 3_600_000, cacheScope: 'public' });
  });

  it('has no list(), since the corpus is 1.9 M records', () => {
    expect(inspireLiteratureResource.list).toBeUndefined();
  });

  it('validates its body against the get_paper dossier schema', () => {
    expect(inspireLiteratureResource.output).toBe(getPaperTool.output);
  });

  it('declares paper_not_found, then the three shared INSPIRE reasons, with codes and read-worded hints', () => {
    const errors = inspireLiteratureResource.errors ?? [];

    expect(errors.map((e) => [e.reason, e.code])).toEqual([
      ['paper_not_found', JsonRpcErrorCode.NotFound],
      ['inspire_rate_limited', JsonRpcErrorCode.RateLimited],
      ['pacer_shed', JsonRpcErrorCode.RateLimited],
      ['upstream_unreadable', JsonRpcErrorCode.ServiceUnavailable],
    ]);
    expect(errors[0]?.recovery).toBe(
      'Find the record with cern_inspire_search_literature using title words, an author, or the arXiv number, then call cern_inspire_get_paper with its recid.',
    );
    expect(errors[1]?.recovery).toContain('read the resource again');
    expect(errors[2]?.recovery).toContain('read the resource again');
    expect(errors[3]?.recovery).toContain('cern_inspire_search_literature using query "recid:N"');
  });
});

describe('params', () => {
  it.each(['1', '451647', '1124337', '123456789', '0000001'])('accepts recid %s', (recid) => {
    expect(paramsSchema().safeParse({ recid }).success).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['text', 'abc'],
    ['an arXiv ID', '1207.7214'],
    ['an ins-prefixed id', 'ins1124337'],
    ['ten digits', '1234567890'],
    ['a negative number', '-1'],
    ['padded with a space', ' 12'],
    ['a trailing newline', '12\n'],
    ['two ids', '1,2'],
  ])('rejects a recid that is %s', (_label, recid) => {
    expect(paramsSchema().safeParse({ recid }).success).toBe(false);
  });

  it('rejects a missing recid and a non-string recid', () => {
    expect(paramsSchema().safeParse({}).success).toBe(false);
    expect(paramsSchema().safeParse({ recid: 451647 }).success).toBe(false);
  });
});

describe('handler', () => {
  it('reads the record and its HEPData availability in two requests, with no resolve step', async () => {
    routeRecord(dossierMetadata(3));
    routeData();

    const paper = await read(HIGGS.recid);

    expect(paper).toEqual(expect.schemaMatching(inspireLiteratureResource.output));
    expect(paper).toMatchObject({ recid: HIGGS.recid, resolvedAs: 'recid', authorCount: 3 });
    expect(paper.hepdata).toMatchObject({ status: 'available', latestVersion: 2, tableCount: 3 });
    expect(h.requests.map((r) => r.path).sort()).toEqual(['/api/data', '/api/literature']);
    expect(h.requests.find((r) => r.path === '/api/literature')?.params.get('q')).toBe(
      `recid:${HIGGS.recid}`,
    );
    expect(h.requests.find((r) => r.path === '/api/data')?.params.get('q')).toBe(
      `literature.control_number:${HIGGS.recid}`,
    );
  });

  it('caps the authors at 25 and keeps the full count in authorCount', async () => {
    routeRecord(dossierMetadata(2_932));
    routeData();

    const paper = await read(HIGGS.recid);

    expect(paper.authors).toHaveLength(25);
    expect(paper.authorCount).toBe(2_932);
    expect(paper.authors[24]?.name).toBe('Doe, Jane 25');
  });

  it('returns the same dossier cern_inspire_get_paper returns for the same record', async () => {
    routeRecord(dossierMetadata(40));
    routeData();
    const paper = await read(HIGGS.recid);
    h = startHarness();
    routeRecord(dossierMetadata(40));
    routeData();

    const result = await runToolContract(getPaperTool, { paper: HIGGS.recid });

    const { truncated, shown, cap, notice, ...tool } = result.structuredContent as Record<
      string,
      unknown
    >;
    expect({ truncated, shown, cap, notice }).toEqual({
      truncated: true,
      shown: 25,
      cap: 25,
      notice: 'Showing 25 of 40 authors; raise max_authors (up to 500) to list more.',
    });
    expect(paper).toEqual(tool);
  });

  it('returns a record without HEPData tables as hepdata none', async () => {
    routeRecord(dossierMetadata(1));
    routeData(emptyBody());

    expect((await read(HIGGS.recid)).hepdata).toEqual({ status: 'none' });
  });

  it("fails the read with the availability lookup's own error instead of serving a degraded body", async () => {
    routeRecord(dossierMetadata(1));
    h.route('/data', new Response('down', { status: 503 }));

    const error = await readFailure(HIGGS.recid);

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ status: 503 });
  });

  it.each([
    [
      'a 429',
      () => rateLimitResponse('7'),
      JsonRpcErrorCode.RateLimited,
      { reason: 'inspire_rate_limited', retryAfter: 7 },
    ],
    [
      'an HTML page',
      () => htmlResponse(),
      JsonRpcErrorCode.ServiceUnavailable,
      { reason: 'upstream_unreadable' },
    ],
  ])('fails the read when the availability lookup gets %s', async (_label, reply, code, data) => {
    routeRecord(dossierMetadata(1));
    h.route('/data', reply);

    const error = await readFailure(HIGGS.recid);

    expect(error.code).toBe(code);
    expect(error.data).toMatchObject(data);
  });

  it('keeps upstream strings verbatim: it returns JSON data and renders nothing', async () => {
    routeRecord(dossierMetadata(1, { titles: [{ title: 'Title\r\nwith [brackets] <tags>' }] }));
    routeData();

    const paper = await read(HIGGS.recid);

    expect(paper.title).toBe('Title\r\nwith [brackets] <tags>');
  });
});

describe('paper_not_found', () => {
  it('fails an empty record read with the declared reason, NotFound, and the recid in its data', async () => {
    h.route('/literature', jsonResponse(emptyBody()));
    routeData(emptyBody());

    const error = await read('99999999').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      message: 'No INSPIRE literature record has recid 99999999.',
      data: { reason: 'paper_not_found', recid: '99999999' },
    });
  });

  it('fails a literature hit that carries no metadata', async () => {
    h.route('/literature', jsonResponse({ hits: { total: 1, hits: [{ id: '5' }] } }));
    routeData(emptyBody());

    await expect(read('5')).rejects.toMatchObject({ data: { reason: 'paper_not_found' } });
  });

  it('reports not found, not the lookup failure, when the record is missing and the availability lookup failed', async () => {
    h.route('/literature', jsonResponse(emptyBody()));
    h.route('/data', new Response('down', { status: 503 }));

    const error = await readFailure('99999999');

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'paper_not_found' },
    });
  });
});

describe('upstream failures', () => {
  it('reports a 429 as inspire_rate_limited with the wait INSPIRE asked for', async () => {
    h.route('/literature', rateLimitResponse('120'));
    routeData();

    const error = await readFailure(HIGGS.recid);

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'inspire_rate_limited', retryAfter: 120 });
  });

  it.each([
    ['an HTML page', () => htmlResponse()],
    ['truncated JSON', () => new Response('{"hits":', { status: 200 })],
    ['JSON without the search envelope', () => jsonResponse({ hits: {} })],
  ])('reports %s as upstream_unreadable', async (_label, reply) => {
    h.route('/literature', reply);
    routeData();

    const error = await readFailure(HIGGS.recid);

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unreadable' });
  });

  it('reports a full outbound queue as pacer_shed with a retryAfter', async () => {
    h = startHarness({
      pacer: createPacer({ name: 'test', limits: [{ requests: 1, perMs: 60_000 }] }),
    });
    await h.pacer.run(async () => undefined);

    const error = await readFailure(HIGGS.recid);

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'pacer_shed' });
    expect((error.data as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
  });

  it.each([
    [503, JsonRpcErrorCode.ServiceUnavailable],
    [504, JsonRpcErrorCode.Timeout],
  ])('reports a persistent HTTP %i with its classified code', async (status, code) => {
    h.route('/literature', new Response('upstream trouble', { status }));
    routeData();

    const error = await readFailure(HIGGS.recid);

    expect(error.code).toBe(code);
    expect(error.data).toMatchObject({ status });
  });

  it('reports a cancelled read as the signal reason, not as a missing paper', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = createMockContext({
      errors: inspireLiteratureResource.errors,
      signal: controller.signal,
    });

    const error = await Promise.resolve(
      inspireLiteratureResource.handler(paramsSchema().parse({ recid: HIGGS.recid }), ctx),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toMatchObject({ data: { reason: 'paper_not_found' } });
    expect(h.requests).toHaveLength(0);
  });
});
