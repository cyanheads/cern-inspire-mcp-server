/** @fileoverview Bundle cleaning preserves SDK skill runtime while removing dependency agent guides. */
import { expect, it } from 'vitest';
import { filterAgentDocEntries } from '../../scripts/clean-mcpb.js';
import { checkBundleEntries } from '../../scripts/lint-packaging.js';

it('retains nested skill runtime modules and the server guide', () => {
  const runtime = [
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'node_modules/@modelcontextprotocol/server/dist/ext/skills/loader.mjs',
    'node_modules/outer/node_modules/@modelcontextprotocol/server/dist/ext/skills/index.mjs',
    'skills/cern-inspire-guide/SKILL.md',
  ];
  expect(filterAgentDocEntries(runtime)).toEqual([]);
  expect(checkBundleEntries(runtime, 'test.mcpb')).toEqual([]);
});

it('removes dependency guides at scoped, unscoped and nested package roots', () => {
  const docs = [
    'node_modules/@scope/package/skills/guide/reference.md',
    'node_modules/package/skills/guide/reference.md',
    'node_modules/outer/node_modules/@scope/package/skills/guide/reference.md',
    'node_modules/outer/node_modules/package/skills/guide/reference.md',
    'node_modules/package/framework-skills/guide/SKILL.md',
    'node_modules/package/.claude/settings.json',
    'node_modules/package/.agents/agent.md',
    'node_modules/package/docs/SKILL.md',
  ];
  expect(filterAgentDocEntries(docs)).toHaveLength(8);
  expect(checkBundleEntries(docs, 'test.mcpb')).toEqual([
    expect.stringContaining('contains 8 node_modules agent-doc entries'),
  ]);
});
