/**
 * @fileoverview Readers for the `CallToolResult` that `runToolContract` returns:
 * the `structuredContent` payload, the text blocks of `content[]` (the first is
 * the tool's `format()` output, the second the enrichment trailer), and the
 * error envelope of a failed call. A tool test asserts on both surfaces through
 * these so the two stay in step.
 * @module tests/fixtures/tool-result
 */

import type { runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { expect } from 'vitest';

export type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

/** The error envelope a failed call carries in `structuredContent.error`. */
export interface ErrorEnvelope {
  code: number;
  data?: {
    reason?: string;
    recovery?: { hint?: string };
    retryAfter?: number;
    retryable?: boolean;
    [key: string]: unknown;
  };
  message: string;
}

/** `structuredContent` of a successful call, typed by the caller. */
export function structured<T extends object>(result: ToolResult): T {
  expect(result.isError, 'the call should have succeeded').toBeFalsy();
  return result.structuredContent as T;
}

/** The text of every text block in `content[]`, in order. */
export function textBlocks(result: ToolResult): string[] {
  return result.content.flatMap((block) => (block.type === 'text' ? [block.text] : []));
}

/** The tool's own `format()` output: the first text block. */
export function bodyText(result: ToolResult): string {
  const [first] = textBlocks(result);
  if (first === undefined) throw new Error('the result has no text block');
  return first;
}

/** Every text block joined: the `format()` output and the enrichment trailer. */
export function fullText(result: ToolResult): string {
  return textBlocks(result).join('');
}

/** Every string and number in a JSON value, depth first; booleans and null carry no text to find. */
export function leaves(value: unknown): (string | number)[] {
  if (typeof value === 'string' || typeof value === 'number') return [value];
  if (Array.isArray(value)) return value.flatMap(leaves);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(leaves);
  return [];
}

/** The error envelope of a failed call; fails the test when the call succeeded. */
export function errorEnvelope(result: ToolResult): ErrorEnvelope {
  expect(result.isError, 'the call should have failed').toBe(true);
  const error = (result.structuredContent as { error?: ErrorEnvelope } | undefined)?.error;
  if (!error) throw new Error('the failed result carries no structuredContent.error');
  return error;
}
