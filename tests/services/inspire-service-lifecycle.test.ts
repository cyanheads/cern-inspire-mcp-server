/**
 * @fileoverview Tests for `InspireService` construction and lifecycle: the
 * `init` / `get` / `dispose` accessor, the production defaults (global fetch,
 * the version-bearing User-Agent), and the call budget `beginCall` opens.
 * @module tests/services/inspire-service-lifecycle.test
 */

import type { AppConfig } from '@cyanheads/mcp-ts-core/config';
import { createMockContext } from '@cyanheads/mcp-ts-core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CALL_BUDGET_MS,
  disposeInspireService,
  getInspireService,
  InspireService,
  initInspireService,
} from '@/services/inspire/inspire-service.js';
import { jsonResponse, literaturePage } from '../fixtures/inspire-upstream.js';

const config = { mcpServerVersion: '3.2.1' } as AppConfig;
const search = { query: 't higgs', sort: 'relevance', page: 1, size: 10 } as const;

let globalFetch: ReturnType<typeof vi.fn<typeof fetch>>;

beforeEach(() => {
  globalFetch = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(literaturePage())));
  vi.stubGlobal('fetch', globalFetch);
});

afterEach(() => {
  disposeInspireService();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('accessor', () => {
  it('throws an actionable error before initInspireService has run', () => {
    expect(() => getInspireService()).toThrow(/not initialized.*initInspireService/);
  });

  it('returns the same service after init, and a fresh one after dispose and re-init', () => {
    initInspireService(config);
    const first = getInspireService();
    expect(getInspireService()).toBe(first);

    disposeInspireService();
    expect(() => getInspireService()).toThrow(/not initialized/);

    initInspireService(config);
    expect(getInspireService()).not.toBe(first);
  });

  it('disposing with nothing initialized is a no-op', () => {
    expect(() => disposeInspireService()).not.toThrow();
  });
});

describe('production defaults', () => {
  it('uses the global fetch and the default pacer, and carries config.mcpServerVersion in the User-Agent', async () => {
    initInspireService(config);
    const ctx = createMockContext();
    const service = getInspireService();

    const page = await service.searchLiterature(search, service.beginCall(ctx));

    expect(page.papers).toHaveLength(1);
    expect(globalFetch).toHaveBeenCalledTimes(1);
    const [url, init] = globalFetch.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/^https:\/\/inspirehep\.net\/api\/literature\?/);
    expect(init?.headers).toEqual({
      'User-Agent':
        'cern-inspire-mcp-server/3.2.1 (+https://github.com/cyanheads/cern-inspire-mcp-server)',
    });
  });

  it('constructs directly with only a version', async () => {
    const service = new InspireService({ version: '0.0.1' });
    const ctx = createMockContext();

    await expect(service.searchLiterature(search, service.beginCall(ctx))).resolves.toMatchObject({
      total: 1,
    });
    service.dispose();
  });

  it('disposing the service twice does not throw', () => {
    const service = new InspireService({ version: '0.0.1' });

    service.dispose();

    expect(() => service.dispose()).not.toThrow();
  });
});

describe('beginCall', () => {
  it('opens the production 55 s budget by default', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const service = new InspireService({ version: '0.0.1' });
    const ctx = createMockContext();

    const call = service.beginCall(ctx);

    expect(CALL_BUDGET_MS).toBe(55_000);
    expect(call.deadline).toBe(Date.now() + 55_000);
    expect(call.ctx).toBe(ctx);
    service.dispose();
  });

  it('opens a custom budget', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const service = new InspireService({ version: '0.0.1' });

    const call = service.beginCall(createMockContext(), 1_234);

    expect(call.deadline).toBe(Date.now() + 1_234);
    service.dispose();
  });
});
