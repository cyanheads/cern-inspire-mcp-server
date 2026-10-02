/**
 * @fileoverview The upstream-failure cases every INSPIRE tool shares, run through
 * `runToolContract` so the assertions land on the wire envelope a client sees:
 * `code`, `data.reason`, `data.recovery.hint` (the contract's `recovery` text),
 * and the `reason …` line closing `content[]`. A tool test file calls
 * {@link describeFailureClasses} once with its definition's contract and a way to
 * run the tool and to install an upstream reply on the request the tool makes.
 * @module tests/fixtures/failure-suite
 */

import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import type { RunToolContractOptions } from '@cyanheads/mcp-ts-core/testing';
import { createPacer } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { badRequestBody, jsonResponse, rateLimitResponse } from './inspire-upstream.js';
import {
  hangingFetch,
  type RecordedRequest,
  type Responder,
  type ServiceHarness,
  settle,
  startHarness,
  stopHarness,
} from './service-harness.js';
import { errorEnvelope, fullText, type ToolResult } from './tool-result.js';

/** One entry of a tool's `errors` array, as far as the suite reads it. */
interface ContractEntry {
  code: number;
  reason: string;
  recovery: string;
}

export interface FailureSuiteOptions {
  /** The tool's `errors` array: the suite reads each reason's `recovery` and `code` from it. */
  contract: readonly ContractEntry[];
  /** Installs `reply` as the answer to the request whose failure the tool must report. */
  install(h: ServiceHarness, reply: Responder | Response): void;
  /** True when the tool sends a caller query and so declares `invalid_query`. */
  invalidQuery: boolean;
  /**
   * Picks the failing request's attempts from those recorded, for a tool that sends
   * other requests on the same path in parallel; default: every request on `path`.
   */
  isAttempt?: (request: RecordedRequest) => boolean;
  /** Name for the `describe` block. */
  label: string;
  /** The request path the non-retried cases count single attempts on; default `/api/literature`. */
  path?: string;
  /** Runs the tool once on valid input. */
  run(options?: RunToolContractOptions): Promise<ToolResult>;
  /** Replies on the main route the tool must report as `upstream_unreadable`, each with a label. */
  unreadable: readonly (readonly [label: string, reply: () => Response])[];
}

/** Registers the shared failure-class cases for one tool. */
export function describeFailureClasses(options: FailureSuiteOptions): void {
  const attemptPath = options.path ?? '/api/literature';
  const isAttempt =
    options.isAttempt ?? ((request: RecordedRequest) => request.path === attemptPath);
  const entry = (reason: string): ContractEntry => {
    const found = options.contract.find((e) => e.reason === reason);
    if (!found) throw new Error(`the tool declares no ${reason} entry`);
    return found;
  };

  /** Asserts the wire envelope for a declared reason: code, reason, the contract's hint, the content line. */
  const expectDeclared = (result: ToolResult, reason: string) => {
    const declared = entry(reason);
    const error = errorEnvelope(result);
    expect(error.code).toBe(declared.code);
    expect(error.data?.reason).toBe(reason);
    expect(error.data?.recovery?.hint).toBe(declared.recovery);
    expect(fullText(result)).toContain(`Recovery: ${declared.recovery}`);
    expect(fullText(result)).toContain(`reason ${reason}`);
    return error;
  };

  describe(`${options.label}: upstream failure classes`, () => {
    let h: ServiceHarness;

    beforeEach(() => {
      vi.useFakeTimers();
      h = startHarness();
    });

    afterEach(() => {
      stopHarness();
      vi.useRealTimers();
    });

    const run = async (runOptions?: RunToolContractOptions) => {
      const outcome = await settle(() => options.run(runOptions));
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    };

    it('declares each shared reason with its contract code', () => {
      expect(entry('inspire_rate_limited').code).toBe(JsonRpcErrorCode.RateLimited);
      expect(entry('pacer_shed').code).toBe(JsonRpcErrorCode.RateLimited);
      expect(entry('upstream_unreadable').code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      if (options.invalidQuery) {
        expect(entry('invalid_query').code).toBe(JsonRpcErrorCode.ValidationError);
      } else {
        expect(options.contract.some((e) => e.reason === 'invalid_query')).toBe(false);
      }
    });

    it('reports a 429 as inspire_rate_limited with the wait INSPIRE asked for', async () => {
      options.install(h, rateLimitResponse('120'));

      const result = await run();

      const error = expectDeclared(result, 'inspire_rate_limited');
      expect(error.data?.retryAfter).toBe(120);
    });

    it('reports a 429 with no Retry-After as a 5 s wait', async () => {
      options.install(h, rateLimitResponse());

      const error = expectDeclared(await run(), 'inspire_rate_limited');

      expect(error.data?.retryAfter).toBe(5);
    });

    it('gives up on a persistent short-wait 429 with the same declared reason', async () => {
      options.install(h, rateLimitResponse('2'));

      const result = await run();

      expectDeclared(result, 'inspire_rate_limited');
      expect(h.requests.length).toBeGreaterThanOrEqual(3);
    });

    it('reports the server own queue as pacer_shed, with a retryAfter to wait', async () => {
      h = startHarness({
        pacer: createPacer({ name: 'test', limits: [{ requests: 1, perMs: 60_000 }] }),
      });
      await h.pacer.run(async () => undefined);

      const result = await run();

      const error = expectDeclared(result, 'pacer_shed');
      expect(error.data?.retryAfter).toBeGreaterThan(0);
      expect(h.requests).toHaveLength(0);
    });

    it.each(options.unreadable)('reports %s as upstream_unreadable', async (_label, reply) => {
      options.install(h, reply);

      expectDeclared(await run(), 'upstream_unreadable');
    });

    it('reports a body over the 8 MiB ceiling as upstream_unreadable', async () => {
      options.install(
        h,
        () => new Response('{}', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }),
      );

      expectDeclared(await run(), 'upstream_unreadable');
    });

    if (options.invalidQuery) {
      it('reports a 400 as invalid_query with the tool-specific hint, without retrying', async () => {
        options.install(
          h,
          jsonResponse(badRequestBody('Invalid pagination parameters.'), { status: 400 }),
        );

        const result = await run();

        const error = expectDeclared(result, 'invalid_query');
        expect(error.message).toContain('Invalid pagination parameters.');
        expect(error.data?.upstreamMessage).toBe('Invalid pagination parameters.');
        expect(h.requests.filter(isAttempt)).toHaveLength(1);
      });
    }

    it.each([
      [500, JsonRpcErrorCode.ServiceUnavailable],
      [503, JsonRpcErrorCode.ServiceUnavailable],
      [504, JsonRpcErrorCode.Timeout],
    ])(
      'reports a persistent HTTP %i with its classified code and no contract reason',
      async (status, code) => {
        options.install(h, new Response('upstream trouble', { status }));

        const error = errorEnvelope(await run());

        expect(error.code).toBe(code);
        expect(error.data?.reason).toBeUndefined();
        expect(error.data?.status).toBe(status);
      },
    );

    it.each([
      [404, JsonRpcErrorCode.NotFound],
      [403, JsonRpcErrorCode.Forbidden],
    ])('reports HTTP %i with its classified code and does not retry', async (status, code) => {
      options.install(h, new Response('no', { status }));

      const error = errorEnvelope(await run());

      expect(error.code).toBe(code);
      expect(h.requests.filter(isAttempt)).toHaveLength(1);
    });

    it('reports a network failure as ServiceUnavailable after retrying', async () => {
      h = startHarness({ fetch: () => Promise.reject(new TypeError('fetch failed')) });

      const error = errorEnvelope(await run());

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.data?.reason).toBeUndefined();
      expect(h.requests.length).toBeGreaterThanOrEqual(3);
    });

    it('reports an upstream that never answers as Timeout inside the call budget', async () => {
      h = startHarness({ fetch: hangingFetch() });
      const started = Date.now();

      const error = errorEnvelope(await run());

      expect(error.code).toBe(JsonRpcErrorCode.Timeout);
      expect(Date.now() - started).toBeLessThan(55_000);
    });

    it('reports a caller cancellation as RequestCancelled, without a request', async () => {
      const controller = new AbortController();
      controller.abort();

      const error = errorEnvelope(await run({ context: { signal: controller.signal } }));

      expect(error.code).toBe(JsonRpcErrorCode.RequestCancelled);
      expect(h.requests).toHaveLength(0);
    });
  });
}
