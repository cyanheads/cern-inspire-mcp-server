/**
 * @fileoverview Test harness for `InspireService`: an `InspireService` wired to a
 * strict fetch fake (`createFetchMock`) or a caller-supplied fetch, a permissive
 * pacer, and a mock context, with every outbound request recorded as a parsed
 * URL. Later tool tests reuse it to put fixture bodies behind the service.
 * @module tests/fixtures/service-harness
 */

import {
  createFetchMock,
  createMockContext,
  type MockContextLogger,
} from '@cyanheads/mcp-ts-core/testing';
import { createPacer, type Pacer } from '@cyanheads/mcp-ts-core/utils';
import { vi } from 'vitest';
import { type InspireCall, InspireService } from '@/services/inspire/inspire-service.js';
import { setActiveService } from './active-service.js';
import { INSPIRE_ORIGIN } from './inspire-upstream.js';

export const TEST_VERSION = '9.9.9';

/** The exact User-Agent `InspireService` sends for {@link TEST_VERSION}. */
export const TEST_USER_AGENT = `cern-inspire-mcp-server/${TEST_VERSION} (+https://github.com/cyanheads/cern-inspire-mcp-server)`;

/** A pacer with no limits: every task starts at once. */
export const permissivePacer = (): Pacer => createPacer({ name: 'test' });

/** One outbound request the service made. */
export interface RecordedRequest {
  headers: Record<string, string>;
  /** Query parameter names in the order sent. */
  names: string[];
  params: URLSearchParams;
  /** The URL path below the origin, e.g. `/api/literature`. */
  path: string;
  signal: AbortSignal | undefined;
  url: URL;
}

export type Responder = (request: Request) => Response | Promise<Response>;

export interface ServiceHarnessOptions {
  /** Replaces the strict fetch fake, e.g. to hang until aborted or to stream a body. */
  fetch?: typeof fetch;
  pacer?: Pacer;
  /** Aborts the mock context's signal, for cancellation tests. */
  signal?: AbortSignal;
}

export interface ServiceHarness {
  /** Opens a call budget on the harness context; defaults to the production 55 s. */
  call(budgetMs?: number): InspireCall;
  readonly ctx: ReturnType<typeof createMockContext>;
  dispose(): void;
  /** Logger calls the service made on the context. */
  readonly log: MockContextLogger;
  readonly pacer: Pacer;
  /** Every request made, in order. */
  readonly requests: readonly RecordedRequest[];
  /**
   * Routes `GET <origin>/api<path>` (exact path) to `respond`. Routes match in
   * registration order; `once` consumes the route, so a sequence of one-shot
   * routes scripts a sequence of replies. A thrown error rejects the fetch.
   */
  route(path: string, respond: Responder | Response, options?: { once?: boolean }): void;
  readonly service: InspireService;
}

/** Builds an `InspireService` over a strict fetch fake and a permissive pacer. */
export function createServiceHarness(options: ServiceHarnessOptions = {}): ServiceHarness {
  const http = createFetchMock();
  const requests: RecordedRequest[] = [];
  const inner = options.fetch ?? http.fetch;

  /** Async like the real `fetch`, which reports every failure as a rejection, never a sync throw. */
  const recordingFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requests.push({
      url,
      path: url.pathname,
      params: url.searchParams,
      names: [...url.searchParams.keys()],
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      signal: init?.signal ?? undefined,
    });
    return inner(input, init);
  };

  const pacer = options.pacer ?? permissivePacer();
  const service = new InspireService({ version: TEST_VERSION, fetch: recordingFetch, pacer });
  const ctx = createMockContext(options.signal ? { signal: options.signal } : undefined);

  return {
    service,
    ctx,
    pacer,
    requests,
    get log() {
      return ctx.log as MockContextLogger;
    },
    call: (budgetMs) => service.beginCall(ctx, budgetMs),
    route: (path, respond, routeOptions) => {
      http.route({
        method: 'GET',
        match: (request) => {
          const url = new URL(request.url);
          return url.origin === INSPIRE_ORIGIN && url.pathname === `/api${path}`;
        },
        respond,
        ...(routeOptions?.once && { once: true }),
      });
    },
    dispose: () => service.dispose(),
  };
}

let started: ServiceHarness | undefined;

/**
 * Builds a harness and makes its service the one `getInspireService()` returns,
 * for tool and resource tests (the test file mocks the accessor with
 * `withActiveService`). Disposes the previous harness, so a test can start a
 * second one with different options; pair with {@link stopHarness} in `afterEach`.
 */
export function startHarness(options: ServiceHarnessOptions = {}): ServiceHarness {
  stopHarness();
  started = createServiceHarness(options);
  setActiveService(started.service);
  return started;
}

/** Disposes the harness {@link startHarness} made and clears the active service. */
export function stopHarness(): void {
  started?.dispose();
  started = undefined;
  setActiveService(undefined);
}

/** The outcome of a promise, captured so a fake-timer test never leaves it unhandled. */
export type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Starts observing `promise` now; read the result later with `await outcome`. */
export const capture = <T>(promise: Promise<T>): Promise<Outcome<T>> =>
  promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * Starts `start()` and fires every pending timer (retry backoff, the per-attempt
 * timeout) until it settles, then returns the outcome. Fake timers must already be
 * installed; the retry ladder then runs instantly.
 */
export async function settle<T>(start: () => Promise<T>): Promise<Outcome<T>> {
  const outcome = capture(start());
  await vi.runAllTimersAsync();
  return await outcome;
}

/** {@link settle} for a test that has not installed fake timers: installs them for the run only. */
export async function settleWithFakeTimers<T>(start: () => Promise<T>): Promise<Outcome<T>> {
  vi.useFakeTimers();
  try {
    return await settle(start);
  } finally {
    vi.useRealTimers();
  }
}

/** A fetch that never answers; it rejects with the signal's reason once aborted. */
export const hangingFetch = (): typeof fetch => (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (signal?.aborted) reject(signal.reason);
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
