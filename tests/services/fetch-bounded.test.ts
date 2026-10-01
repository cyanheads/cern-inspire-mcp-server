/**
 * @fileoverview Tests for `fetchBounded`: the accept-list, the byte ceiling on
 * declared and streamed bodies, header and redirect pass-through, the per-attempt
 * timeout, transport failures classified as `ServiceUnavailable`, and the
 * caller's abort rethrown unchanged.
 * @module tests/services/fetch-bounded.test
 */

import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type FetchBoundedOptions, fetchBounded } from '@/services/http/fetch-bounded.js';
import { capture } from '../fixtures/service-harness.js';

const URL_UNDER_TEST = 'https://api.example.org/items?q=secret-token';

const options = (overrides: Partial<FetchBoundedOptions> = {}): FetchBoundedOptions => ({
  accept: [200],
  maxBytes: 1024,
  service: 'Example',
  timeoutMs: 1_000,
  ...overrides,
});

const bytes = (text: string) => new TextEncoder().encode(text);

/** A body stream that emits `chunks` and records whether the consumer cancelled it. */
function trackedStream(chunks: Uint8Array[]) {
  const state = { cancelled: false };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[i++];
      if (next) controller.enqueue(next);
      else controller.close();
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

/** A fetch whose response body stalls until the request signal aborts, then errors with the reason. */
const stallingBodyFetch =
  (firstChunk = 'partial'): typeof fetch =>
  (_input, init) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(firstChunk));
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  };

const answer = (
  body: ConstructorParameters<typeof Response>[0],
  init?: ResponseInit,
): typeof fetch =>
  vi.fn(() => Promise.resolve(new Response(body, init))) as unknown as typeof fetch;

afterEach(() => {
  vi.useRealTimers();
});

describe('fetchBounded accept-list', () => {
  it('returns status, headers, and the body text for an accepted status', async () => {
    const result = await fetchBounded(
      URL_UNDER_TEST,
      options({
        fetch: answer('{"ok":true}', { status: 200, headers: { 'x-trace': 'abc' } }),
      }),
    );

    expect(result.status).toBe(200);
    expect(result.text).toBe('{"ok":true}');
    expect(result.headers.get('x-trace')).toBe('abc');
  });

  it('returns a non-200 status that is on the accept-list instead of throwing', async () => {
    const result = await fetchBounded(
      URL_UNDER_TEST,
      options({ accept: [200, 400], fetch: answer('{"message":"bad"}', { status: 400 }) }),
    );

    expect(result).toMatchObject({ status: 400, text: '{"message":"bad"}' });
  });

  it.each([
    [404, JsonRpcErrorCode.NotFound],
    [403, JsonRpcErrorCode.Forbidden],
    [429, JsonRpcErrorCode.RateLimited],
    [500, JsonRpcErrorCode.ServiceUnavailable],
    [503, JsonRpcErrorCode.ServiceUnavailable],
    [504, JsonRpcErrorCode.Timeout],
  ])('throws the classified McpError for unlisted status %i', async (status, code) => {
    const error = await fetchBounded(
      URL_UNDER_TEST,
      options({ fetch: answer('upstream said no', { status }) }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(McpError);
    expect(error).toMatchObject({ code, data: { status } });
  });

  it('names the service, captures the body, and leaves the request URL out of the error', async () => {
    const error = (await fetchBounded(
      URL_UNDER_TEST,
      options({ fetch: answer('upstream said no', { status: 500 }) }),
    ).catch((e: unknown) => e)) as McpError;

    expect(error.message).toContain('Example');
    expect(error.data).toMatchObject({ body: 'upstream said no' });
    expect(JSON.stringify(error.data)).not.toContain('secret-token');
    expect(error.message).not.toContain('secret-token');
  });

  it('carries the Retry-After header of an unlisted 429 in the error data', async () => {
    const error = (await fetchBounded(
      URL_UNDER_TEST,
      options({ fetch: answer('', { status: 429, headers: { 'retry-after': '12' } }) }),
    ).catch((e: unknown) => e)) as McpError;

    expect(error.data).toMatchObject({ retryAfter: '12' });
  });
});

describe('fetchBounded request shape', () => {
  it('sends the headers, follows redirects by default, and passes a signal', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok')));

    await fetchBounded(
      URL_UNDER_TEST,
      options({ fetch: fetchImpl, headers: { 'User-Agent': 'test-agent/1' } }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(URL_UNDER_TEST);
    expect(init?.headers).toEqual({ 'User-Agent': 'test-agent/1' });
    expect(init?.redirect).toBe('follow');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('honors an explicit redirect mode and omits headers when none are given', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok')));

    await fetchBounded(URL_UNDER_TEST, options({ fetch: fetchImpl, redirect: 'manual' }));

    const init = fetchImpl.mock.calls[0]?.[1];
    expect(init?.redirect).toBe('manual');
    expect(init).not.toHaveProperty('headers');
  });

  it('uses the global fetch when no implementation is injected', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn<typeof fetch>(() => Promise.resolve(new Response('from global')));
    globalThis.fetch = spy;
    try {
      const result = await fetchBounded(URL_UNDER_TEST, options());
      expect(result.text).toBe('from global');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('fetchBounded byte ceiling', () => {
  const tooLarge = {
    code: JsonRpcErrorCode.ServiceUnavailable,
    data: { reason: 'upstream_unreadable' },
  };

  it('reads a body of exactly maxBytes', async () => {
    const body = 'x'.repeat(1024);
    const result = await fetchBounded(URL_UNDER_TEST, options({ fetch: answer(body) }));
    expect(result.text).toBe(body);
  });

  it('rejects a body one byte over maxBytes as upstream_unreadable', async () => {
    await expect(
      fetchBounded(URL_UNDER_TEST, options({ fetch: answer('x'.repeat(1025)) })),
    ).rejects.toMatchObject(tooLarge);
  });

  it('rejects on Content-Length alone and cancels the stream without reading it', async () => {
    const { stream, state } = trackedStream([bytes('x'.repeat(10))]);
    const fetchImpl = answer(stream, { headers: { 'content-length': '5000' } });

    await expect(fetchBounded(URL_UNDER_TEST, options({ fetch: fetchImpl }))).rejects.toMatchObject(
      tooLarge,
    );
    await vi.waitFor(() => expect(state.cancelled).toBe(true));
  });

  it('abandons a streamed body mid-read once it passes the ceiling', async () => {
    const { stream, state } = trackedStream([
      bytes('x'.repeat(600)),
      bytes('x'.repeat(600)),
      bytes('never read'),
    ]);

    await expect(
      fetchBounded(URL_UNDER_TEST, options({ fetch: answer(stream) })),
    ).rejects.toMatchObject(tooLarge);
    await vi.waitFor(() => expect(state.cancelled).toBe(true));
  });

  it('names the ceiling in the error data', async () => {
    const error = await fetchBounded(
      URL_UNDER_TEST,
      options({ maxBytes: 10, fetch: answer('x'.repeat(11)) }),
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({ data: { maxBytes: 10 } });
  });

  it('ignores a Content-Length that is not a number and counts the stream instead', async () => {
    const small = await fetchBounded(
      URL_UNDER_TEST,
      options({ fetch: answer('tiny', { headers: { 'content-length': 'unknown' } }) }),
    );
    expect(small.text).toBe('tiny');
  });

  it('returns an empty string for a response with no body', async () => {
    const result = await fetchBounded(
      URL_UNDER_TEST,
      options({ accept: [204], fetch: answer(null, { status: 204 }) }),
    );
    expect(result).toMatchObject({ status: 204, text: '' });
  });

  it('decodes a multi-byte character split across chunks', async () => {
    const euro = bytes('€');
    const { stream } = trackedStream([euro.slice(0, 1), euro.slice(1)]);

    const result = await fetchBounded(URL_UNDER_TEST, options({ fetch: answer(stream) }));

    expect(result.text).toBe('€');
  });

  it('counts bytes, not characters, against the ceiling', async () => {
    const body = '€'.repeat(5);
    await expect(
      fetchBounded(URL_UNDER_TEST, options({ maxBytes: 14, fetch: answer(body) })),
    ).rejects.toMatchObject(tooLarge);
    const ok = await fetchBounded(URL_UNDER_TEST, options({ maxBytes: 15, fetch: answer(body) }));
    expect(ok.text).toBe(body);
  });
});

describe('fetchBounded transport failures', () => {
  it('classifies a network TypeError as ServiceUnavailable with the service and detail', async () => {
    const cause = new TypeError('fetch failed');
    const error = (await fetchBounded(
      URL_UNDER_TEST,
      options({ fetch: () => Promise.reject(cause) }),
    ).catch((e: unknown) => e)) as McpError;

    expect(error).toBeInstanceOf(McpError);
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toContain('Example could not be reached: fetch failed');
    expect(error.cause).toBe(cause);
    expect(error.data).not.toHaveProperty('reason');
  });

  it('describes a non-Error rejection by its string form', async () => {
    const error = await fetchBounded(
      URL_UNDER_TEST,
      options({ fetch: () => Promise.reject('ECONNRESET') }),
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('ECONNRESET'),
    });
  });

  it('classifies a body stream that errors mid-read as ServiceUnavailable', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes('partial'));
        controller.error(new Error('socket hang up'));
      },
    });

    const error = await fetchBounded(URL_UNDER_TEST, options({ fetch: answer(body) })).catch(
      (e: unknown) => e,
    );

    expect(error).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      message: expect.stringContaining('socket hang up'),
    });
  });
});

describe('fetchBounded per-attempt timeout', () => {
  it('throws Timeout carrying timeoutMs when the request never answers', async () => {
    vi.useFakeTimers();
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      });

    const outcome = capture(fetchBounded(URL_UNDER_TEST, options({ fetch: hang, timeoutMs: 250 })));
    await vi.advanceTimersByTimeAsync(249);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    const result = await outcome;
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      message: expect.stringContaining('Example did not respond within 250 ms'),
      data: { timeoutMs: 250 },
    });
  });

  it('also covers the body read: a stalled stream times out', async () => {
    vi.useFakeTimers();

    const outcome = capture(
      fetchBounded(URL_UNDER_TEST, options({ fetch: stallingBodyFetch(), timeoutMs: 500 })),
    );
    await vi.advanceTimersByTimeAsync(500);

    const result = await outcome;
    expect(!result.ok && result.error).toMatchObject({ code: JsonRpcErrorCode.Timeout });
  });

  it('clears its timer after a successful read', async () => {
    vi.useFakeTimers();

    await fetchBounded(URL_UNDER_TEST, options({ fetch: answer('ok') }));

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears its timer after a failure', async () => {
    vi.useFakeTimers();

    await fetchBounded(
      URL_UNDER_TEST,
      options({ fetch: () => Promise.reject(new TypeError('fetch failed')) }),
    ).catch(() => undefined);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fetchBounded caller cancellation', () => {
  it('rethrows the signal reason unchanged when aborted before the request answers', async () => {
    const reason = new Error('client cancelled');
    const controller = new AbortController();
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new DOMException('aborted', 'AbortError')),
          {
            once: true,
          },
        );
      });

    const pending = fetchBounded(
      URL_UNDER_TEST,
      options({ fetch: hang, signal: controller.signal }),
    );
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('rethrows the reason when the signal was already aborted', async () => {
    const reason = new Error('already cancelled');
    const controller = new AbortController();
    controller.abort(reason);
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
      });

    await expect(
      fetchBounded(URL_UNDER_TEST, options({ fetch: hang, signal: controller.signal })),
    ).rejects.toBe(reason);
  });

  it('rethrows the reason when the abort lands during the body read', async () => {
    const reason = new Error('cancelled mid-body');
    const controller = new AbortController();

    const pending = fetchBounded(
      URL_UNDER_TEST,
      options({ fetch: stallingBodyFetch(), signal: controller.signal }),
    );
    await Promise.resolve();
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
  });

  it('does not report a caller abort as a timeout', async () => {
    const controller = new AbortController();
    controller.abort('stop');

    const error = await fetchBounded(
      URL_UNDER_TEST,
      options({
        fetch: () => Promise.reject(new DOMException('aborted', 'AbortError')),
        signal: controller.signal,
      }),
    ).catch((e: unknown) => e);

    expect(error).toBe('stop');
  });
});
