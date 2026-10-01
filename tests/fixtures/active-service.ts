/**
 * @fileoverview The `InspireService` a tool or resource handler receives from
 * `getInspireService()` in a test. Handlers read the service through that
 * module-level accessor, so a test file replaces the accessor with one that
 * returns the harness's service: `vi.mock('@/services/inspire/inspire-service.js',
 * async (importOriginal) => (await import('../fixtures/active-service.js'))
 * .withActiveService(await importOriginal()))`. Kept free of runtime imports from
 * `src/` so the mock factory can load it while the service module is mocked.
 * @module tests/fixtures/active-service
 */

import type { InspireService } from '@/services/inspire/inspire-service.js';

let active: InspireService | undefined;

/** Makes `service` the one `getInspireService()` returns; `undefined` clears it. */
export function setActiveService(service: InspireService | undefined): void {
  active = service;
}

/** The service module's exports with `getInspireService` answering from the active harness service. */
export function withActiveService<T extends { getInspireService: () => InspireService }>(
  actual: T,
): T {
  return {
    ...actual,
    getInspireService: () => {
      if (!active) throw new Error('No harness service is active: call startHarness() first.');
      return active;
    },
  };
}
