/**
 * @fileoverview The single HTTP boundary every upstream service sits on: one
 * request under a per-attempt timeout and the caller's signal, a body read as a
 * stream under a byte ceiling, an accept-list of statuses returned to the caller,
 * and transport failures classified so the retry layer can tell transient from
 * final. Kept apart from any one service so each upstream reuses it.
 * @module services/http/fetch-bounded
 */

import { serviceUnavailable, timeout } from '@cyanheads/mcp-ts-core/errors';
import { httpErrorFromResponse } from '@cyanheads/mcp-ts-core/utils';

/** Options for {@link fetchBounded}. */
export interface FetchBoundedOptions {
  /** Statuses returned to the caller; any other status throws a classified `McpError`. */
  accept: readonly number[];
  /** Fetch implementation; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Body ceiling in bytes; a larger body is abandoned as `upstream_unreadable`. */
  maxBytes: number;
  /** Redirect mode; defaults to `follow`. */
  redirect?: RequestInit['redirect'];
  /** Logical upstream name used in error messages. */
  service: string;
  /** The caller's signal; when it fires, its reason is rethrown unchanged. */
  signal?: AbortSignal;
  /** Per-attempt timeout covering the request and the body read. */
  timeoutMs: number;
}

/** A response whose status was on the accept-list, with its body read in full. */
export interface BoundedResponse {
  headers: Headers;
  status: number;
  text: string;
}

/**
 * Fetches `url` once and reads the body under `maxBytes`.
 *
 * - Status on `accept` → `{ status, headers, text }`.
 * - Any other status → the `McpError` `httpErrorFromResponse` classifies (body captured, URL omitted).
 * - Body over `maxBytes` (Content-Length checked first) → `ServiceUnavailable`, `reason: 'upstream_unreadable'`.
 * - Caller signal fired → its reason, rethrown unchanged (never retried).
 * - Per-attempt timeout fired → `Timeout` (retried by the caller's retry layer).
 * - Network failure (`TypeError`, reset, DNS) → `ServiceUnavailable` (retried).
 */
export async function fetchBounded(
  url: string,
  options: FetchBoundedOptions,
): Promise<BoundedResponse> {
  const { service, signal, timeoutMs } = options;
  const clock = new AbortController();
  const timer = setTimeout(() => clock.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([clock.signal, signal]) : clock.signal;

  /** Classifies a transport-level throw from `fetch` or the body stream. */
  const transportFailure = (err: unknown): never => {
    if (signal?.aborted) throw signal.reason;
    if (clock.signal.aborted) {
      throw timeout(
        `${service} did not respond within ${timeoutMs} ms.`,
        { timeoutMs },
        { cause: err },
      );
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw serviceUnavailable(`${service} could not be reached: ${detail}`, {}, { cause: err });
  };

  try {
    const response = await (options.fetch ?? fetch)(url, {
      ...(options.headers && { headers: options.headers }),
      redirect: options.redirect ?? 'follow',
      signal: requestSignal,
    }).catch(transportFailure);

    if (!options.accept.includes(response.status)) {
      throw await httpErrorFromResponse(response, { service });
    }
    const text = await readBounded(response, options.maxBytes, service, transportFailure);
    return { status: response.status, headers: response.headers, text };
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a response body as UTF-8 text, abandoning it once it passes `maxBytes`. */
async function readBounded(
  response: Response,
  maxBytes: number,
  service: string,
  transportFailure: (err: unknown) => never,
): Promise<string> {
  const tooLarge = () =>
    serviceUnavailable(
      `${service} returned a response larger than ${maxBytes} bytes; it was abandoned unread.`,
      { reason: 'upstream_unreadable', maxBytes },
    );

  if (Number(response.headers.get('content-length')) > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let received = 0;
  for (;;) {
    const chunk = await reader.read().catch(transportFailure);
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    parts.push(decoder.decode(chunk.value, { stream: true }));
  }
  parts.push(decoder.decode());
  return parts.join('');
}
