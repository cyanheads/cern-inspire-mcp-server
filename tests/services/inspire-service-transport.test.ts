/**
 * @fileoverview Tests for `InspireService` transport behavior: the accept-list
 * (400 and 429 mapped onto the shared contract reasons), the retry ladder and its
 * predicate, the pacer and its `pacer_shed` mapping, the per-attempt timeout, the
 * shared 55 s call budget, unreadable bodies, network failures, and caller aborts.
 * All timing runs on fake timers; no live network.
 * @module tests/services/inspire-service-transport.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CALL_BUDGET_MS } from '@/services/inspire/inspire-service.js';
import type { LiteratureSearchParams } from '@/services/inspire/types.js';
import {
  authorPage,
  badRequestBody,
  dataPage,
  dossierMetadata,
  HIGGS,
  htmlResponse,
  jsonResponse,
  literaturePage,
  notFoundBody,
  rateLimitResponse,
} from '../fixtures/inspire-upstream.js';
import {
  capture,
  createServiceHarness,
  hangingFetch,
  type Outcome,
  type ServiceHarness,
  settle,
} from '../fixtures/service-harness.js';

const MIB = 1024 * 1024;

let h: ServiceHarness;

beforeEach(() => {
  vi.useFakeTimers();
  h = createServiceHarness();
});

afterEach(() => {
  h.dispose();
  vi.useRealTimers();
});

const search = (call = h.call()) =>
  h.service.searchLiterature(
    { query: 't higgs', sort: 'relevance', page: 1, size: 10 } satisfies LiteratureSearchParams,
    call,
  );

const okPage = () => jsonResponse(literaturePage());

/** Scripts one reply per request, in order: each reply is consumed by one fetch. */
function script(path: string, ...replies: (Response | (() => Response | Promise<Response>))[]) {
  for (const reply of replies) h.route(path, reply, { once: true });
}

const errorOf = (outcome: Outcome<unknown>): McpError => {
  if (outcome.ok) throw new Error('expected a rejection');
  expect(outcome.error).toBeInstanceOf(McpError);
  return outcome.error as McpError;
};

const networkFailure = () => {
  throw new TypeError('fetch failed');
};

describe('400 and 429 mapping', () => {
  it("maps a 400 to ValidationError invalid_query with INSPIRE's message, and does not retry", async () => {
    h.route(
      '/literature',
      jsonResponse(badRequestBody('Maximum search page size of `1000` results exceeded.'), {
        status: 400,
      }),
    );

    const outcome = await settle(() => search());

    const error = errorOf(outcome);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_query',
      upstreamMessage: 'Maximum search page size of `1000` results exceeded.',
    });
    expect(error.message).toContain('Maximum search page size');
    expect(h.requests).toHaveLength(1);
  });

  it('falls back to the first 300 characters of a non-JSON 400 body', async () => {
    h.route('/literature', new Response(`  ${'x'.repeat(500)}  `, { status: 400 }));

    const error = errorOf(await settle(() => search()));

    expect((error.data as { upstreamMessage: string }).upstreamMessage).toBe('x'.repeat(300));
  });

  it('keeps a multi-line non-JSON 400 body raw in data, and flattens it to one line in the message', async () => {
    const NEL = String.fromCharCode(0x85);
    const LS = String.fromCharCode(0x2028);
    const body = `<html>\r\n<head>\r\n<title>Bad request</title>\r\n</head>${NEL}<body>${LS}x</body>\n</html>`;
    h.route('/literature', new Response(`\n  ${body}  \n`, { status: 400 }));

    const error = errorOf(await settle(() => search()));

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({ reason: 'invalid_query', upstreamMessage: body });
    expect(error.message).toBe(
      'INSPIRE rejected the request: &lt;html&gt; &lt;head&gt; &lt;title&gt;Bad request&lt;/title&gt; &lt;/head&gt; &lt;body&gt; x&lt;/body&gt; &lt;/html&gt;',
    );
    expect(error.message).not.toMatch(new RegExp(`[\\r\\n${NEL}${LS}]`));
  });

  it('uses the raw text when a JSON 400 body carries no message string', async () => {
    h.route('/literature', jsonResponse({ status: 400, errors: [] }, { status: 400 }));

    const error = errorOf(await settle(() => search()));

    expect((error.data as { upstreamMessage: string }).upstreamMessage).toBe(
      '{"status":400,"errors":[]}',
    );
  });

  it('cuts a long JSON 400 message to 300 characters and escapes its markup in the error text', async () => {
    const message = `[x](https://e) <b>bold</b> ${'y'.repeat(10_000)}`;
    h.route('/literature', jsonResponse(badRequestBody(message), { status: 400 }));

    const error = errorOf(await settle(() => search()));

    expect((error.data as { upstreamMessage: string }).upstreamMessage).toBe(message.slice(0, 300));
    expect(error.message.length).toBeLessThan(350);
    expect(error.message).toMatch(
      /^INSPIRE rejected the request: \\\[x\\\]\(https:\/\/e\) &lt;b&gt;bold&lt;\/b&gt; y+$/,
    );
  });

  it('flattens a JSON 400 message to one line, and drops tag and other format characters', async () => {
    const tags = [...'hidden'].map((c) => String.fromCodePoint(0xe0000 + c.charCodeAt(0))).join('');
    const ZWSP = String.fromCharCode(0x200b);
    h.route(
      '/literature',
      jsonResponse(badRequestBody(`Bad${tags} size\n# Heading${ZWSP}`), { status: 400 }),
    );

    const error = errorOf(await settle(() => search()));

    expect((error.data as { upstreamMessage: string }).upstreamMessage).toBe(
      `Bad size\n# Heading${ZWSP}`,
    );
    expect(error.message).toBe('INSPIRE rejected the request: Bad size # Heading');
  });

  it('maps a 429 with Retry-After to RateLimited inspire_rate_limited carrying that wait', async () => {
    h.route('/literature', rateLimitResponse('120'));

    const outcome = await settle(() => search());

    const error = errorOf(outcome);
    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'inspire_rate_limited', retryAfter: 120 });
    expect(error.message).toContain('retry after 120 s');
  });

  it('fails fast, without retrying, when Retry-After exceeds the retry delay cap', async () => {
    h.route('/literature', rateLimitResponse('120'));

    await settle(() => search());

    expect(h.requests).toHaveLength(1);
  });

  it.each([
    ['no Retry-After header', undefined],
    ['an unparseable Retry-After', 'soon'],
  ])("uses INSPIRE's documented 5 s for %s", async (_label, header) => {
    h.route('/literature', rateLimitResponse(header));

    const error = errorOf(await settle(() => search()));

    expect(error.data).toMatchObject({ reason: 'inspire_rate_limited', retryAfter: 5 });
  });

  it('reads an HTTP-date Retry-After as seconds from now', async () => {
    h.route('/literature', () => rateLimitResponse(new Date(Date.now() + 3_000).toUTCString()));

    const error = errorOf(await settle(() => search()));

    const { retryAfter } = error.data as { retryAfter: number };
    expect(retryAfter).toBeGreaterThanOrEqual(2);
    expect(retryAfter).toBeLessThanOrEqual(3);
  });

  it('honors a short Retry-After: waits at least that long, then retries and succeeds', async () => {
    script('/literature', rateLimitResponse('7'), okPage);

    const outcome = capture(search());
    await vi.advanceTimersByTimeAsync(6_000);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);

    const result = await outcome;
    expect(result.ok).toBe(true);
    expect(h.requests).toHaveLength(2);
  });

  it('gives up after three 429s and reports the attempt count', async () => {
    h.route('/literature', rateLimitResponse('2'));

    const error = errorOf(await settle(() => search()));

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({
      reason: 'inspire_rate_limited',
      retryAfter: 2,
      retryAttempts: 3,
    });
    expect(h.requests).toHaveLength(3);
  });
});

describe('retry ladder and predicate', () => {
  it.each([
    [404, JsonRpcErrorCode.NotFound],
    [403, JsonRpcErrorCode.Forbidden],
    [422, JsonRpcErrorCode.ValidationError],
    [501, JsonRpcErrorCode.ServiceUnavailable],
  ])('does not retry HTTP %i', async (status, code) => {
    h.route('/literature', jsonResponse(notFoundBody(), { status }));

    const error = errorOf(await settle(() => search()));

    expect(error.code).toBe(code);
    expect(h.requests).toHaveLength(1);
  });

  it.each([
    [500, JsonRpcErrorCode.ServiceUnavailable],
    [502, JsonRpcErrorCode.ServiceUnavailable],
    [503, JsonRpcErrorCode.ServiceUnavailable],
    [504, JsonRpcErrorCode.Timeout],
  ])(
    'retries HTTP %i to three attempts, then fails with the classified error',
    async (status, code) => {
      h.route('/literature', new Response('upstream trouble', { status }));

      const error = errorOf(await settle(() => search()));

      expect(error.code).toBe(code);
      expect(error.data).toMatchObject({ status, retryAttempts: 3 });
      expect(h.requests).toHaveLength(3);
    },
  );

  it('recovers when a retry succeeds', async () => {
    script(
      '/literature',
      new Response('down', { status: 503 }),
      new Response('down', { status: 502 }),
      okPage,
    );

    const outcome = await settle(() => search());

    expect(outcome.ok && outcome.value.papers).toHaveLength(1);
    expect(h.requests).toHaveLength(3);
  });

  it('backs off between attempts instead of retrying at once', async () => {
    script('/literature', new Response('down', { status: 503 }), okPage);

    const outcome = capture(search());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await outcome).ok).toBe(true);
    expect(h.requests).toHaveLength(2);
  });

  it('does not retry a pacer shed, and reports it as RateLimited pacer_shed', async () => {
    h.dispose();
    const pacer = createPacer({ name: 'test', limits: [{ requests: 1, perMs: 60_000 }] });
    h = createServiceHarness({ pacer });
    script('/literature', okPage);
    await search();

    const error = errorOf(await settle(() => search()));

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'pacer_shed', shedKind: 'wait_projected' });
    expect((error.data as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
    expect(h.requests).toHaveLength(1);
  });
});

describe('unreadable bodies', () => {
  const unreadable = {
    code: JsonRpcErrorCode.ServiceUnavailable,
    data: { reason: 'upstream_unreadable' },
  };

  it.each([
    ['an HTML page', () => htmlResponse()],
    [
      'an HTML page with leading whitespace',
      () => new Response('\n  <html></html>', { status: 200 }),
    ],
    ['truncated JSON', () => new Response('{"hits":{"total":', { status: 200 })],
    ['an empty body', () => new Response('', { status: 200 })],
    ['JSON null', () => jsonResponse(null)],
    ['a JSON array', () => jsonResponse([1, 2, 3])],
    ['JSON without hits', () => jsonResponse({ aggregations: {} })],
    ['hits.total as an object', () => jsonResponse({ hits: { total: { value: 3 }, hits: [] } })],
    ['hits.hits as an object', () => jsonResponse({ hits: { total: 1, hits: {} } })],
    ['a string total', () => jsonResponse({ hits: { total: '3', hits: [] } })],
  ])('rejects %s on a JSON route as upstream_unreadable', async (_label, reply) => {
    h.route('/literature', reply);

    const error = errorOf(await settle(() => search()));

    expect(error).toMatchObject(unreadable);
  });

  it('retries an unreadable body like a failed fetch, and recovers on a good one', async () => {
    script('/literature', htmlResponse(), okPage);

    const outcome = await settle(() => search());

    expect(outcome.ok).toBe(true);
    expect(h.requests).toHaveLength(2);
  });

  it('retries an unreadable body to three attempts before giving up', async () => {
    h.route('/literature', htmlResponse());

    const error = errorOf(await settle(() => search()));

    expect(error.data).toMatchObject({ reason: 'upstream_unreadable', retryAttempts: 3 });
    expect(h.requests).toHaveLength(3);
  });

  it('rejects a body declared over the 8 MiB ceiling by Content-Length', async () => {
    h.route(
      '/literature',
      () => new Response('{}', { headers: { 'content-length': String(8 * MIB + 1) } }),
    );

    const error = errorOf(await settle(() => search()));

    expect(error).toMatchObject(unreadable);
  });

  it('rejects a streamed body that crosses 8 MiB without declaring a length', async () => {
    h.route('/literature', () => {
      const chunk = new Uint8Array(MIB).fill(0x20);
      let sent = 0;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += 1;
            if (sent <= 9) controller.enqueue(chunk);
            else controller.close();
          },
        }),
      );
    });

    const error = errorOf(await settle(() => search()));

    expect(error).toMatchObject(unreadable);
  });

  it('accepts a body of exactly 8 MiB', async () => {
    const head = '{"hits":{"total":0,"hits":[]},"pad":"';
    const tail = '"}';
    const body = `${head}${'x'.repeat(8 * MIB - head.length - tail.length)}${tail}`;
    expect(new TextEncoder().encode(body).byteLength).toBe(8 * MIB);
    h.route('/literature', () => new Response(body));

    const outcome = await settle(() => search());

    expect(outcome.ok && outcome.value).toEqual({ total: 0, hasMore: false, papers: [] });
  });
});

describe('network failures', () => {
  it('maps a thrown network error to ServiceUnavailable, retried to three attempts', async () => {
    h.route('/literature', networkFailure);

    const error = errorOf(await settle(() => search()));

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('INSPIRE could not be reached');
    expect(error.data).not.toHaveProperty('reason', 'upstream_unreadable');
    expect(h.requests).toHaveLength(3);
  });

  it('recovers when the network comes back', async () => {
    script('/literature', networkFailure, okPage);

    const outcome = await settle(() => search());

    expect(outcome.ok).toBe(true);
    expect(h.requests).toHaveLength(2);
  });
});

describe('per-attempt timeout and the call budget', () => {
  it('times each attempt out at 15 s, retries, and stays inside the 55 s budget', async () => {
    h.dispose();
    h = createServiceHarness({ fetch: hangingFetch() });
    const started = Date.now();

    const error = errorOf(await settle(() => search()));

    const elapsed = Date.now() - started;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(h.requests).toHaveLength(3);
    expect(elapsed).toBeGreaterThanOrEqual(3 * 15_000);
    expect(elapsed).toBeLessThan(CALL_BUDGET_MS);
    expect(h.requests.map((r) => r.signal?.aborted)).toEqual([true, true, true]);
  });

  it('shrinks the attempt timeout to the budget that is left', async () => {
    h.dispose();
    h = createServiceHarness({ fetch: hangingFetch() });
    const started = Date.now();

    const error = errorOf(await settle(() => search(h.call(5_000))));

    const elapsed = Date.now() - started;
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(h.requests).toHaveLength(1);
    expect(elapsed).toBeGreaterThanOrEqual(5_000);
    expect(elapsed).toBeLessThan(6_000);
  });

  it('stops the retry ladder when the next backoff would outlast the budget', async () => {
    h.route('/literature', new Response('down', { status: 503 }));
    const started = Date.now();

    const error = errorOf(await settle(() => search(h.call(1_500))));

    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'retry_deadline_exceeded' });
    expect(h.requests.length).toBeLessThanOrEqual(2);
    expect(Date.now() - started).toBeLessThanOrEqual(1_500);
  });

  it.each([0, -1])('refuses to start a request on an exhausted budget (%i ms)', async (budget) => {
    const error = errorOf(await settle(() => search(h.call(budget))));

    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.message).toContain('budget ran out');
    expect(error.data).toMatchObject({ operation: 'searchLiterature' });
    expect(h.requests).toHaveLength(0);
  });

  it('shares one budget across every request of a call', async () => {
    let calls = 0;
    h.dispose();
    h = createServiceHarness({
      fetch: ((input, init) => {
        calls += 1;
        if (calls > 1) return hangingFetch()(input, init);
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(okPage()), 14_000);
        });
      }) as typeof fetch,
    });
    const call = h.call(20_000);

    const first = capture(search(call));
    await vi.advanceTimersByTimeAsync(14_000);
    expect((await first).ok).toBe(true);

    const startedSecond = Date.now();
    const second = capture(search(call));
    await vi.advanceTimersByTimeAsync(5_900);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(200);

    const error = errorOf(await second);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(Date.now() - startedSecond).toBeLessThan(7_000);
    expect(calls).toBe(2);
  });

  it('fails the whole getPaper when the shared budget is spent', async () => {
    const error = errorOf(await settle(() => h.service.getPaper(HIGGS.recid, 25, h.call(0))));

    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(h.requests).toHaveLength(0);
  });

  it('degrades the HEPData lookup to lookup_failed after its retries are exhausted', async () => {
    h.route('/literature', jsonResponse(literaturePage([dossierMetadata(2)])));
    h.route('/data', new Response('down', { status: 503 }));

    const outcome = await settle(() => h.service.getPaper(HIGGS.recid, 25, h.call()));

    expect(outcome.ok && outcome.value?.paper.hepdata).toEqual({ status: 'lookup_failed' });
    expect(h.requests.filter((r) => r.path === '/api/data')).toHaveLength(3);
  });
});

describe('the pacer', () => {
  it("hands the pacer the call's remaining budget as maxWaitMs and an abort signal", async () => {
    const pacer = createPacer({ name: 'test' });
    const run = vi.spyOn(pacer, 'run');
    h.dispose();
    h = createServiceHarness({ pacer });
    h.route('/literature', okPage());

    await search(h.call(10_000));

    expect(run).toHaveBeenCalledTimes(1);
    const options = run.mock.calls[0]?.[1];
    expect(options?.maxWaitMs).toBe(10_000);
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('routes every request, resolution included, through the pacer', async () => {
    const pacer = createPacer({ name: 'test' });
    const run = vi.spyOn(pacer, 'run');
    h.dispose();
    h = createServiceHarness({ pacer });
    h.route('/literature', jsonResponse(literaturePage()), { once: true });
    h.route('/literature', jsonResponse(literaturePage([dossierMetadata(1)])));
    h.route('/data', jsonResponse(dataPage()));

    await h.service.getPaper('1207.7214', 25, h.call());

    expect(run).toHaveBeenCalledTimes(3);
  });

  it('queues a second request behind the rate window and charges the wait to the call', async () => {
    h.dispose();
    h = createServiceHarness({
      pacer: createPacer({ name: 'test', limits: [{ requests: 1, perMs: 10_000 }] }),
    });
    h.route('/literature', okPage());
    await search();

    const second = capture(search());
    await vi.advanceTimersByTimeAsync(9_000);
    expect(h.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);

    expect((await second).ok).toBe(true);
    expect(h.requests).toHaveLength(2);
  });

  it('sheds a request whose queue wait cannot fit in the remaining budget', async () => {
    h.dispose();
    h = createServiceHarness({
      pacer: createPacer({ name: 'test', limits: [{ requests: 1, perMs: 30_000 }] }),
    });
    h.route('/literature', okPage());
    await search(h.call(20_000));

    const error = errorOf(await settle(() => search(h.call(20_000))));

    expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
    expect(error.data).toMatchObject({ reason: 'pacer_shed', shedKind: 'wait_projected' });
    expect(h.requests).toHaveLength(1);
  });

  it('sheds at once with queue_full when the pacer has no free slot and no queue room', async () => {
    let release: (response: Response) => void = () => undefined;
    h.dispose();
    h = createServiceHarness({
      pacer: createPacer({ name: 'test', maxConcurrent: 1, maxQueueDepth: 0 }),
      fetch: (() =>
        new Promise<Response>((resolve) => {
          release = resolve;
        })) as typeof fetch,
    });

    const first = capture(search());
    await vi.advanceTimersByTimeAsync(0);
    const shed = await settle(() => search());
    release(okPage());
    await vi.advanceTimersByTimeAsync(0);

    expect(errorOf(shed).data).toMatchObject({ reason: 'pacer_shed', shedKind: 'queue_full' });
    expect((await first).ok).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it('disposes the pacer when the service is disposed', () => {
    const pacer = createPacer({ name: 'test' });
    const dispose = vi.spyOn(pacer, 'dispose');
    h.dispose();
    h = createServiceHarness({ pacer });

    h.service.dispose();

    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

describe('caller cancellation', () => {
  it('rethrows the abort reason unchanged and does not retry', async () => {
    const reason = new Error('client cancelled');
    const controller = new AbortController();
    h.dispose();
    h = createServiceHarness({ fetch: hangingFetch(), signal: controller.signal });

    const outcome = capture(search());
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(reason);
    await vi.runAllTimersAsync();

    const result = await outcome;
    expect(!result.ok && result.error).toBe(reason);
    expect(h.requests).toHaveLength(1);
  });

  it('rethrows the reason when the signal was aborted before the call', async () => {
    const reason = new Error('cancelled early');
    const controller = new AbortController();
    controller.abort(reason);
    h.dispose();
    h = createServiceHarness({ fetch: hangingFetch(), signal: controller.signal });

    const outcome = await settle(() => search());

    expect(!outcome.ok && outcome.error).toBe(reason);
    expect(h.requests.length).toBeLessThanOrEqual(1);
  });

  it('rethrows the reason when the abort lands during a retry backoff', async () => {
    const reason = new Error('cancelled while waiting');
    const controller = new AbortController();
    h.dispose();
    h = createServiceHarness({ signal: controller.signal });
    h.route('/literature', new Response('down', { status: 503 }));

    const outcome = capture(search());
    await vi.advanceTimersByTimeAsync(10);
    expect(h.requests).toHaveLength(1);
    controller.abort(reason);
    await vi.runAllTimersAsync();

    const result = await outcome;
    expect(!result.ok && result.error).toBe(reason);
    expect(h.requests).toHaveLength(1);
  });

  it('does not degrade a cancelled availability lookup to lookup_failed', async () => {
    const reason = new Error('client cancelled');
    const controller = new AbortController();
    h.dispose();
    h = createServiceHarness({ signal: controller.signal });
    h.route('/literature', jsonResponse(literaturePage([dossierMetadata(1)])));
    h.route('/data', () => {
      controller.abort(reason);
      throw new TypeError('fetch failed');
    });

    const outcome = await settle(() => h.service.getPaper(HIGGS.recid, 25, h.call()));

    expect(!outcome.ok && outcome.error).toBe(reason);
  });

  it('keeps authors lookups on the same ladder: a 503 then success', async () => {
    script('/authors', new Response('down', { status: 503 }), jsonResponse(authorPage()));

    const outcome = await settle(() => h.service.searchAuthors('Jane.Doe.1', 5, h.call()));

    expect(outcome.ok && outcome.value.authors).toHaveLength(1);
  });
});
