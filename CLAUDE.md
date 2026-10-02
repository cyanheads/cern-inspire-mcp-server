# Developer Protocol

**Server:** cern-inspire-mcp-server
**Version:** 0.1.1
**Framework:** [@cyanheads/mcp-ts-core](https://www.npmjs.com/package/@cyanheads/mcp-ts-core) `^0.13.10`
**Engines:** Bun ≥1.4.0, Node ≥24.0.0
**MCP SDK:** `@modelcontextprotocol/server` ^2.1.0
**Zod:** ^4.6.5

> **Read the framework docs first:** `node_modules/@cyanheads/mcp-ts-core/CLAUDE.md` contains the full API reference — builders, Context, error codes, exports, patterns. This file covers server-specific conventions only.

> **Read the design next:** `docs/design.md` records the tool surface, the input and output shapes, the INSPIRE API behavior verified live, the service's pacing and retry table, the design decisions, and the deferred HEPData-direct tools. Update it when the surface or a decision changes.

---

## Domain

Eight read-only tools and one resource over INSPIRE-HEP's keyless REST API (`https://inspirehep.net/api`). HEPData is reached only through INSPIRE's `data` collection; no request goes to hepdata.net, whose bot challenge refuses the server's User-Agent (design § Design Decisions #1). So the server reads no table values: `cern_inspire_get_paper` and `cern_inspire_search_hepdata` report each HEPData record's DOI, latest version, table count, and hepdata.net link.

| Upstream path | Used by |
|:--------------|:--------|
| `/literature` (search, `fields`-selected) | `cern_inspire_search_literature`, `cern_inspire_get_paper` (arXiv and DOI resolution included), `inspire://literature/{recid}` |
| `/literature/<recid>` (redirects not followed, after a `recid:N` search returns no hit: where INSPIRE sends a merged recid) | `cern_inspire_get_paper`, `inspire://literature/{recid}` |
| `/literature` with `format=` (`bibtex`, `latex-eu`, `latex-us`), plus a `fields=control_number` search for the match total on a later page | `cern_inspire_export_citations` |
| `/literature/facets` (`facet_name=citation-summary`, plus `citations-by-year` in parallel unless a year bound or the self-citation exclusion is set) | `cern_inspire_get_citation_summary` |
| `/authors` | `cern_inspire_search_authors`, author resolution in `cern_inspire_get_citation_summary` |
| `/experiments` | `cern_inspire_search_experiments` |
| `/data` | `cern_inspire_search_hepdata`, the `hepdata` block of `cern_inspire_get_paper` |

`cern_inspire_list_reference` serves static tables and makes no upstream call. There are no prompts.

`InspireService` (`src/services/inspire/inspire-service.ts`) owns every request: one process-wide pacer under INSPIRE's published 15 requests per 5 s per address (`limits: [{ requests: 12, perMs: 5_000 }]`, `maxConcurrent: 4`, a cooldown after a `429`), a series gate that lets at most two citations-by-year requests into that pacer at once (`maxConcurrent: 2`, since one holds a slot for up to 15 s), `withRetry` outside the pacer (2 retries), one 55 s budget per tool call opened by `beginCall(ctx)` and threaded through every request in the call, an 8 MiB byte ceiling through `fetchBounded` (`src/services/http/fetch-bounded.ts`), and a strict query-parameter allowlist, since INSPIRE silently ignores unknown parameters. There is no cache and no server-specific env var.

Conventions every definition follows:

- **Every INSPIRE request goes through `InspireService`**, with the call opened by `inspire.beginCall(ctx)`. Never `fetch` from a handler: pacing, the budget, retries, and error classification live in the service.
- **Honest User-Agent only.** `cern-inspire-mcp-server/<version> (+https://github.com/cyanheads/cern-inspire-mcp-server)`. Never add a `curl`, `Wget`, or `python-requests` token, and send nothing to hepdata.net.
- **Never request `email_addresses`.** INSPIRE's terms bar collecting them in bulk; the author `fields` list leaves them out.
- **Shared inputs** live in `src/mcp-server/tools/inputs.ts`: `blankAsUnset` wraps every optional or defaulted input; `paperInput`, `documentTypesInput` / `subjectsInput` (array or comma-joined string, case-folded, up to 4, values AND together), `yearFromInput` / `yearToInput`, `authorQueryInput` / `authorIdInput`, and the `formatAppliedFilters` echo. The advertised `inputSchema` must admit every spelling a description documents, and the input must parse it: `paperInput` checks its pattern in a `.refine()`, never `.regex()`, its description names the scheme on every URL form, and the facet descriptions document only the enum array (design § Design Decisions #31).
- **Placeholders the server writes** in a notice, an `errors[]` recovery hint, or `format()` text outside a code span are uppercase words (`"t WORDS"`, `"a NAME"`, `collaborations.value:NAME`), never `<…>`, which a client rendering markdown to HTML drops as a tag. A code span prints `<…>` as written (list_reference's `HEPData ins<recid>` term), and `.describe()` text and the server instructions reach `tools/list` and `initialize`, not rendered markdown.
- **Upstream text is data.** Every upstream or caller string in `format()` goes through `inline()`, `cell()`, `quote()`, `fenced()`, or `printUrl()` from `src/utils/render.ts`, and a list item that opens with one wraps it in `atLineStart()`; outside a `quote()` or `fenced()` block, no other line opens with upstream text. A caller's own query, author, or paper identifier echoed in a notice or error message goes through `callerEcho()`, which leaves `*`, `_`, `~`, and `>` as written so the echo can be sent back, and entity-encodes only a `<` that could open a tag, comment, or autolink; an identifier value a caller copies (DOI, record DOI, report number, texkey, arXiv ID, BAI, ORCID, INSPIRE ID, other ID) goes through `identifier()`, the same rules. `structuredContent` keeps each string as received with two exceptions: the service drops Unicode tag characters at decode, and `normalize.ts` converts titles and abstracts from publisher HTML/JATS/MathML to text with `markupToText()` (LaTeX left as published).
- **Required enrichment first.** A handler writes its required enrichment fields (`truncated` / `shown` / `cap`, `totalCount`, the echo strings) with neutral values before its first upstream call or branch, then overwrites them where the real value is known.
- **Errors.** Every tool that reaches INSPIRE declares `inspire_rate_limited`, `pacer_shed`, and `upstream_unreadable` inline (`thrownBy: 'service'`), plus `invalid_query` when it sends a caller query; the resource declares the first three. Handler-side reasons (`paper_not_found`, `beyond_result_window`, `invalid_year_range`, `missing_target`, `author_not_identifier`, `author_not_found`) are thrown through `ctx.fail`, and tools mark caller-input reasons `severity: 'notice'`.
- **No fabrication.** A field INSPIRE leaves out stays absent (`firstAuthor`, `ongoing`, `averageCitations`), and `format()` prints "Not available" or "not recorded" rather than a guess.

---

## What's Next?

When the user asks what's next or needs direction, suggest options based on the current project state. Common next steps:

1. **Re-run the `setup` skill** — ensures CLAUDE.md, skills, structure, and metadata are populated and up to date with the current codebase
2. **Run the `design-mcp-server` skill** — if the tool/resource surface hasn't been mapped yet, work through domain design
3. **Add tools/resources/prompts** — scaffold new definitions using the `add-tool`, `add-app-tool`, `add-resource`, `add-prompt` skills
4. **Add services** — scaffold domain service integrations using the `add-service` skill
5. **Add tests** — scaffold tests for existing definitions using the `add-test` skill
6. **Field-test definitions** — exercise tools/resources/prompts with real inputs using the `field-test` skill, get a report of issues and pain points
7. **Run `devcheck`** — lint, format, typecheck, and security audit
8. **Run the `security-pass` skill** — audit handlers for MCP-specific security gaps: output injection, scope blast radius, input sinks, tenant isolation
9. **Run the `polish-docs-meta` skill** — finalize README, CHANGELOG, metadata, and agent protocol for shipping
10. **Run the `maintenance` skill** — investigate changelogs, adopt upstream changes, and sync skills after `bun update --latest`

Tailor suggestions to what's actually missing or stale — don't recite the full list every time.

---

## Core Rules

- **Logic throws, framework catches.** Tool/resource handlers are pure — throw on failure, no `try/catch`. Plain `Error` is fine; the framework catches, classifies, and formats. Use error factories (`notFound()`, `validationError()`, etc.) when the error code matters.
- **Use `ctx.log`** for request-scoped logging. No `console` calls.
- **Use `ctx.state`** for tenant-scoped storage. Never access persistence directly.
- **Need input the caller didn't supply?** `return ctx.requestInput(...)` and read `ctx.inputs` when the handler is re-entered. Never `await` for user input mid-handler.
- **Secrets in env vars only** — never hardcoded.
- **Cut noise.** Add only what earns its place: no speculative generality, no guards for states the framework already prevents (Zod-validated params, classified errors), no abstraction until a third caller proves it, no option nothing sets.
- **Close the loop on issues.** When implementing work tracked by a GitHub issue, comment on the issue with what landed and close it. Do both — a comment without a close leaves stale issues open; a close without a comment leaves no record of what shipped. The comment is for future readers — state the concrete changes, not the conversation that produced them.

---

## Patterns

### Tool

`cern_inspire_get_paper`, condensed (`src/mcp-server/tools/definitions/get-paper.tool.ts`):

```ts
import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { blankAsUnset, paperInput } from '@/mcp-server/tools/inputs.js';
import { inline } from '@/utils/render.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';

export const getPaperTool = tool('cern_inspire_get_paper', {
  title: 'Get INSPIRE paper',
  description: "Fetch one paper's full INSPIRE-HEP record by recid, arXiv ID, or DOI: …", // abridged
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  input: z.object({
    paper: paperInput, // shared input: recid, arXiv ID, DOI, or URL forms, normalized in preprocess
    max_authors: blankAsUnset(z.number().int().min(0).max(500).default(25)).describe(
      'Most authors to list (0–500, default 25). The full count is always in authorCount.',
    ),
  }),
  output: paperDossierSchema, // also the inspire://literature/{recid} resource's output
  enrichment: {
    truncated: z.boolean().describe('True when the author list was capped at max_authors.'),
    shown: z.number().describe('Number of authors listed.'),
    cap: z.number().describe('The max_authors cap applied.'),
    notice: z.string().optional().describe('Guidance when the author list was capped or HEPData availability could not be checked.'),
  },
  errors: [
    {
      reason: 'paper_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The recid, arXiv ID, or DOI matches no INSPIRE literature record.',
      recovery: 'Find the record with cern_inspire_search_literature using title words, an author, or the arXiv number, then call cern_inspire_get_paper with its recid.',
      severity: 'notice',
    },
    // inspire_rate_limited, pacer_shed, upstream_unreadable: declared inline, thrownBy: 'service'
  ],

  async handler(input, ctx) {
    ctx.enrich({ truncated: false, shown: 0, cap: input.max_authors }); // required enrichment first

    const inspire = getInspireService();
    const lookup = await inspire.getPaper(input.paper, input.max_authors, inspire.beginCall(ctx));
    if (!lookup) {
      throw ctx.fail('paper_not_found', `No INSPIRE literature record matches "${inline(input.paper)}".`, {
        paper: input.paper,
      });
    }
    const { paper, authorsInRecord } = lookup;
    ctx.enrich({ shown: paper.authors.length });
    if (authorsInRecord > input.max_authors) {
      ctx.enrich.truncated({
        shown: paper.authors.length,
        cap: input.max_authors,
        guidance: `Showing ${paper.authors.length} of ${authorsInRecord} authors; raise max_authors (up to 500) to list more.`,
      });
    }
    return paper;
  },

  // format() is the content[] twin of structuredContent: every output field renders,
  // and every upstream string passes through inline() / quote() / printUrl().
  format: (paper) => [{ type: 'text', text: renderPaperDossier(paper) }],
});
```

### Resource

`inspire://literature/{recid}` (`src/mcp-server/resources/definitions/inspire-literature.resource.ts`) serves the same dossier through the same service call:

```ts
import { resource, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { paperDossierSchema } from '@/mcp-server/tools/definitions/get-paper.tool.js';
import { getInspireService } from '@/services/inspire/inspire-service.js';

const RESOURCE_MAX_AUTHORS = 25; // cern_inspire_get_paper's default

export const inspireLiteratureResource = resource('inspire://literature/{recid}', {
  name: 'inspire_literature',
  title: 'INSPIRE literature record',
  description: 'One INSPIRE-HEP literature record by recid, as the cern_inspire_get_paper dossier in JSON: …', // abridged
  mimeType: 'application/json',
  params: z.object({
    recid: z.string().regex(/^\d{1,9}$/).describe('INSPIRE literature record ID (recid), e.g. 451647.'),
  }),
  output: paperDossierSchema,
  cacheHint: { ttlMs: 3_600_000, cacheScope: 'public' },
  errors: [
    {
      reason: 'paper_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'The recid matches no INSPIRE literature record.',
      recovery: 'Find the record with cern_inspire_search_literature using title words, an author, or the arXiv number, then call cern_inspire_get_paper with its recid.',
    },
    // inspire_rate_limited, pacer_shed, upstream_unreadable: declared inline, thrownBy: 'service'
  ],

  async handler(params, ctx) {
    const inspire = getInspireService();
    const lookup = await inspire.getPaper(params.recid, RESOURCE_MAX_AUTHORS, inspire.beginCall(ctx));
    if (!lookup) {
      throw ctx.fail('paper_not_found', `No INSPIRE literature record has recid ${params.recid}.`, {
        recid: params.recid,
      });
    }
    return lookup.paper;
  },
});
```

### Server config

The server has no env vars of its own: INSPIRE is keyless, and the pacer limits, call budget, and byte ceiling are constants in `inspire-service.ts`. There is no `src/config/`. A new env var lands on every one of these surfaces in the same change:

| Surface | What it needs |
|:--------|:--------------|
| `src/config/server-config.ts` (new) | A lazily parsed Zod schema read through `parseEnvConfig` from `@cyanheads/mcp-ts-core/config`, so errors name the variable; `z.stringbool()` for booleans, never `z.coerce.boolean()` |
| `.env.example` | The variable under `# ── Server-specific`, with a comment and its default, replacing the "None." note |
| `server.json` | `environmentVariables[]` in both package entries, `isRequired` matching what INSPIRE actually requires |
| `manifest.json` | A `user_config` entry (`title`, `type`, `"default": ""` unless required) wired into `mcp_config.env` as `"X": "${user_config.X}"` |
| `.claude-plugin/plugin.json` | A `userConfig` entry referenced from `env` as `"X": "${user_config.X}"` |
| `.codex-plugin/mcp.json` | The name in `env_vars`; never `"X": ""` in `env` |
| `README.md` | A Configuration table row, and the "no settings of its own" sentence above it |
| `docs/design.md` and this file | § Config in the design, and the Domain section's "no server-specific env var" line |

`lint:packaging` (run by `devcheck`) checks the name parity between `server.json` and `manifest.json` and the `${user_config.X}` wiring; the rest is by hand.

### Server entry point

`src/index.ts`:

```ts
await createApp({
  name: 'cern-inspire-mcp-server',
  title: 'cern-inspire-mcp-server', // display identity is the machine name; lint:packaging checks the pair
  tools: allToolDefinitions,
  resources: allResourceDefinitions,
  instructions: 'cern-inspire-mcp-server reads INSPIRE-HEP (inspirehep.net), …', // abridged
  setup(core) {
    initInspireService(core.config); // the User-Agent carries core.config.mcpServerVersion
  },
  teardown() {
    disposeInspireService(); // releases both pacers' timers and rejects queued waiters
  },
});
```

- No `description`: the framework serves `package.json`'s.
- `instructions` is mirrored in `docs/design.md` § Server Instructions with its character count. Change both together.
- No `sessionMode`: no handler calls `ctx.requestInput`, so the deployment picks the mode through `MCP_SESSION_MODE`, and `.env.example` and the Dockerfile set `stateless`.

---

## Context

Handlers receive a unified `ctx` object. The properties this server uses:

| Property | Description |
|:---------|:------------|
| `ctx.log` | Request-scoped logger — `.debug()`, `.info()`, `.notice()`, `.warning()`, `.error()`. Auto-correlates requestId, traceId, tenantId. Dual-sink: Pino **and** `notifications/message` to the client, so treat it as client-visible. The service logs through `call.ctx.log`. |
| `ctx.enrich` | Success-path agent context — `ctx.enrich({ … })` for declared fields, `.total()` (`totalCount`), `.truncated({ shown, cap, guidance })`, `.notice()`, `.echo()` (`effectiveQuery`). Reaches `structuredContent` and `content[]`; lands only when the definition declares an `enrichment` block. Write the required fields with neutral values before the first upstream call. |
| `ctx.fail` | `throw ctx.fail(reason, message, data?)` for a reason declared in the definition's `errors[]`; the framework attaches the contract's `recovery` hint. |
| `ctx.signal` | `AbortSignal` for cancellation. `beginCall(ctx)` carries it into `withRetry` and the pacer, so a cancelled call stops queueing and retrying. |

---

## Errors

Handlers throw — the framework catches, classifies, and formats.

**Recommended: typed error contract.** Declare `errors: [{ reason, code, when, recovery, retryable?, severity?, thrownBy? }]` on `tool()` / `resource()` to receive `ctx.fail(reason, …)` typed against the reason union. TypeScript catches typos at compile time, `data.reason` is auto-populated for observability, linter enforces conformance against the handler body. `recovery` is required (≥ 5 words, lint-validated) — the single source of truth for the agent's next move. The framework puts it on the wire whenever a failure carrying that `reason` arrives without a hint — a bare `ctx.fail('reason')` or a service throw with `data: { reason }` — as `data.recovery.hint`, mirrored into `content[]` text unless the message already contains it verbatim; override with an explicit `{ recovery: { hint: '...' } }` when dynamic runtime context matters. Every error envelope also carries `data.requestId`, the id the server's log records for that call carry, and `content[]` closes with `(reason … · request <id>)`. Mark an entry the service layer throws with `thrownBy: 'service'` so `error-contract-unthrown` skips it — lint-only metadata, nothing at runtime reads it. Baseline codes (`InternalError`, `ServiceUnavailable`, `Timeout`, `ValidationError`, `SerializationError`, `RequestCancelled`) bubble freely and don't need declaring.

```ts
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

errors: [
  { reason: 'no_match', code: JsonRpcErrorCode.NotFound,
    when: 'No item matched the query',
    recovery: 'Broaden the query or check the spelling and try again.' },
],
async handler(input, ctx) {
  const item = await db.find(input.id);
  if (!item) throw ctx.fail('no_match', `No item ${input.id}`);
  return item;
}
```

**Declare contracts inline on each tool.** The contract is part of the tool's public surface — one file should give the full picture. Don't extract a shared `errors[]` constant; per-tool repetition is the intended cost of locality.

**Fallback (no contract entry fits):** throw via factories or plain `Error`.

```ts
// Error factories — explicit code
import { notFound, serviceUnavailable } from '@cyanheads/mcp-ts-core/errors';
throw notFound('Item not found', { itemId });
throw serviceUnavailable('API unavailable', { url }, { cause: err });

// Plain Error — framework auto-classifies from message patterns
throw new Error('Item not found');           // → NotFound
throw new Error('Invalid query format');     // → ValidationError

// McpError — when no factory exists for the code
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
throw new McpError(JsonRpcErrorCode.InitializationFailed, 'Connection failed', { pool: 'primary' });
```

See framework CLAUDE.md and the `api-errors` skill for the full auto-classification table, all available factories, and the contract reference.

---

## Structure

```text
src/
  index.ts                              # createApp(): tools, resource, instructions, service setup/teardown
  mcp-server/
    tools/
      inputs.ts                         # Shared inputs (paper, facets, years, author ids) + appliedFilters echo
      definitions/
        index.ts                        # allToolDefinitions barrel
        search-literature.tool.ts
        get-paper.tool.ts               # also exports paperDossierSchema, the resource's output
        export-citations.tool.ts
        search-authors.tool.ts
        get-citation-summary.tool.ts
        search-experiments.tool.ts
        search-hepdata.tool.ts
        list-reference.tool.ts          # static vocabulary tables, no upstream call
    resources/definitions/
      index.ts                          # allResourceDefinitions barrel
      inspire-literature.resource.ts    # inspire://literature/{recid}
  services/
    http/
      fetch-bounded.ts                  # One request: per-attempt timeout, byte ceiling, status accept-list
    inspire/
      inspire-service.ts                # InspireService: pacer, per-call budget, retries, param allowlist, field lists
      identifiers.ts                    # Paper and author identifier normalization and routing (matchedAs)
      markup-to-text.ts                 # Publisher HTML/JATS/MathML and entities in titles and abstracts → text
      normalize.ts                      # Raw INSPIRE records → output shapes; absent fields stay absent
      types.ts                          # Raw upstream and normalized domain types
      vocabulary.ts                     # Document types, subjects, citation-bucket ranges
  utils/
    render.ts                           # inline / cell / quote / fenced / printUrl / atLineStart / callerEcho for upstream and caller text in format(), notices, and error messages
tests/
  fixtures/                             # INSPIRE bodies, service harness, shared failure suite, result readers
  tools/  resources/  services/  shared/  # Suites mirroring src/
docs/
  design.md                             # Surface, verified upstream behavior, decisions, deferred HEPData tools
```

---

## Naming

| What | Convention | Example |
|:-----|:-----------|:--------|
| Files | kebab-case with suffix | `search-docs.tool.ts` |
| Tool/resource/prompt names | snake_case | `search_docs` |
| Directories | kebab-case | `src/services/doc-search/` |
| Descriptions | Single string or template literal, no `+` concatenation | `'Search items by query and filter.'` |

---

## Skills

Skills are modular instructions in `framework-skills/` at the project root. Read them directly when a task matches — e.g., `framework-skills/add-tool/SKILL.md` when adding a tool. `bun run list-skills` prints the full registry. The directory is deliberately not `skills/`: Claude Code and Codex auto-load a plugin's root `skills/`, so a server that ships `.claude-plugin/` or `.codex-plugin/` would hand these development skills to every agent that installs it. Keep `skills/` free for skills meant for those agents.

**Agent skill directory:** Copy skills into the directory your agent discovers (Claude Code: `.claude/skills/`, others: equivalent). Skills then load as context without referencing `framework-skills/` paths. After framework updates, run the `maintenance` skill — Phase B re-syncs the agent directory.

Available skills:

| Skill | Purpose |
|:------|:--------|
| `setup` | Post-init project orientation |
| `design-mcp-server` | Design tool surface, resources, and services for a new server |
| `add-tool` | Scaffold a new tool definition |
| `add-app-tool` | Scaffold an MCP App tool + paired UI resource |
| `add-resource` | Scaffold a new resource definition |
| `add-prompt` | Scaffold a new prompt definition |
| `add-service` | Scaffold a new service integration |
| `add-test` | Scaffold test file for a tool, resource, or service |
| `field-test` | Exercise tools/resources/prompts with real inputs, verify behavior, report issues |
| `tool-defs-analysis` | Read-only audit of MCP definition language across the surface — voice, leaks, defaults, recovery hints, output descriptions |
| `security-pass` | Audit server for MCP-flavored security gaps: output injection, scope blast radius, input sinks, tenant isolation |
| `code-simplifier` | Post-session cleanup against `git diff` — modernize syntax, consolidate duplication, align with the codebase |
| `polish-docs-meta` | Finalize docs, README, metadata, and agent protocol for shipping |
| `git-wrapup` | Land working-tree changes as a commit stack — version bump, changelog, verify, commit by concern, release commit on top. No tag, no push to main; opens the release PR when the project declares release PR mode |
| `release-pr-review` | Review pass on an open release PR — simplifier + correctness review, fixes as ordinary commits on top of the stack, PR body kept in sync. Release PR mode only |
| `release-and-publish` | Fast-forward merge (release PR mode) + tag + push + npm + MCP Registry + GH Release + Docker. Picks up from `git-wrapup` |
| `maintenance` | Investigate changelogs, adopt upstream changes, sync skills to agent dirs |
| `orchestrations` | Chain task skills into a gated multi-phase pipeline — build-out, QA-fix, update-ship — when you can spawn sub-agents |
| `report-issue-framework` | File a bug or feature request against `@cyanheads/mcp-ts-core` via `gh` CLI |
| `report-issue-local` | File a bug or feature request against this server's own repo via `gh` CLI |
| `techniques` | Catalog of response/data-shaping techniques — overflow handling, payload shaping, retrieval patterns |
| `api-auth` | Auth modes, scopes, JWT/OAuth |
| `api-canvas` | DataCanvas: register tabular data, run SQL, export, plus the `spillover()` helper for big result sets — Tier 3 opt-in |
| `api-config` | AppConfig, parseConfig, env vars |
| `api-context` | Context interface, RequestContext, logger, state, multi-round-trip input |
| `api-errors` | McpError, JsonRpcErrorCode, error patterns |
| `api-linter` | Definition linter rule catalog — invoked by `bun run lint:mcp` and `devcheck` |
| `api-mirror` | MirrorService: persistent self-refreshing local mirror (embedded SQLite + FTS5) of a bulk upstream dataset — Tier 3 opt-in |
| `api-services` | LLM, Speech, Graph services |
| `api-testing` | createMockContext, test patterns |
| `api-utils` | Formatting, parsing, security, pagination, scheduling, telemetry helpers |
| `api-telemetry` | OTel catalog: spans, metrics, completion logs, env config, cardinality rules |
| `api-workers` | Cloudflare Workers runtime |

**Chaining skills into pipelines.** When the user wants a multi-phase effort — build this server out, QA-and-fix the surface, update-and-ship — *and you can spawn sub-agents*, `framework-skills/orchestrations/SKILL.md` sequences the task skills above into a gated pipeline with verification at each step. Read it to drive the run. Optional: skip it if you can't orchestrate sub-agents, and ignore it entirely if you were *spawned* as one — you've already been scoped to a single phase.

When you complete a skill's checklist, check the boxes and add a completion timestamp at the end (e.g., `Completed: 2026-03-11`).

---

## Commands

**Runtime:** Scripts use Bun's native TypeScript execution — `bun run <cmd>` is the standard invocation. `npm run <cmd>` also works (npm delegates to bun).

| Command | Purpose |
|:--------|:--------|
| `bun run build` | Compile TypeScript |
| `bun run rebuild` | Clean + build |
| `bun run clean` | Remove build artifacts |
| `bun run devcheck` | Lint + format + typecheck + security + changelog sync |
| `bun run audit:fix` | `bun audit fix` — upgrade vulnerable packages to the lowest safe version within existing ranges (`--dry-run` previews, `--latest` rewrites ranges). First response when `devcheck` flags a transitive advisory; then `bun update <name>`, then `bun dedupe` |
| `bun run audit:refresh` | Delete `bun.lock` and reinstall. Last resort after `audit:fix`, `bun update <name>`, and `bun dedupe` — re-resolves every ranged dep (the framework pin included) and rewrites the lockfile as `lockfileVersion: 2` |
| `bun run lint:mcp` | Run the MCP definition linter standalone (rule catalog: `api-linter` skill) |
| `bun run lint:packaging` | Packaging surface checks — `server.json`/`manifest.json` env-var parity (run by devcheck) |
| `bun run list-skills` | Print the skill registry |
| `bun run tree` | Generate directory structure doc |
| `bun run format` | Auto-fix formatting (safe fixes only) |
| `bun run format:unsafe` | Also apply Biome's unsafe autofixes — review the diff; they can change behavior |
| `bun run test` | Run tests (Vitest — use `bun run test`, not `bun test`) |
| `bun run test:coverage` | Run tests with Istanbul coverage |
| `bun run start` | Run the built server (transport from `MCP_TRANSPORT_TYPE`, default stdio) |
| `bun run start:stdio` | Production mode (stdio) |
| `bun run start:http` | Production mode (HTTP) |
| `bun run changelog:build` | Regenerate `CHANGELOG.md` from `changelog/*.md` |
| `bun run changelog:check` | Verify `CHANGELOG.md` is in sync (used by devcheck) |
| `bun run bundle` | Build, pack, and clean a `.mcpb` for one-click Claude Desktop install |
| `bun run release:github` | Create (or repair) the GitHub Release on the current version's tag, attaching the `.mcpb` (release step) |
| `bun run publish-mcp` | Log in with the keychain-stored GitHub token and publish `server.json` to the MCP Registry (release step) |

**CI is one file.** `.github/workflows/codeql.yml` (scaffolded) is the only GitHub Actions workflow: CodeQL is GitHub-owned end to end, and the file runs only while the repo's CodeQL *default setup* is turned off. Verification — `devcheck`, tests, the release gates — runs locally; don't add a workflow that re-runs it.

---

## Bundling

`npm run bundle` produces a `.mcpb` extension bundle for one-click install in Claude Desktop. The pack step is followed by `scripts/clean-mcpb.ts`, which prunes dev dependencies (`mcpb clean`) and strips two classes of `node_modules/**` content that root-anchored `.mcpbignore` patterns cannot reach: dependency-shipped agent docs (`framework-skills/`, `skills/`, `.claude/`, `.agents/`, `SKILL.md`) and platform-specific native bindings, which would otherwise lock the bundle to the platform it was packed on. A server using DataCanvas therefore ships a portable bundle without the DuckDB native — `@duckdb/node-api` is an optional peer loaded lazily, so canvas tools report an actionable install hint and every other tool works normally. MCPB is stdio-only — HTTP and Cloudflare Workers deployments are unaffected. Consumers who don't need it can delete `manifest.json` and `.mcpbignore`; `lint:packaging` skips cleanly.

**Adding an env var requires both files:** `server.json` (registry discovery, `environmentVariables[]`) and `manifest.json` (bundle install UX, `mcp_config.env` + `user_config`). `lint:packaging` (run by `devcheck`) verifies the env var names match, that every `user_config` option is wired into `mcp_config.env` as `"X": "${user_config.X}"` (the host substitutes nothing else — `"${X}"` reaches the server as that literal string), and that an optional string option carries `"default": ""`.

**README install badges** (Claude Desktop `.mcpb`, Cursor, VS Code) and the `base64` / `encodeURIComponent` config-generation commands are ship-time concerns — run the `polish-docs-meta` skill, which carries the badge format, layout, and generation snippets in `framework-skills/polish-docs-meta/references/readme.md`.

---

## Changelog

Directory-based, grouped by minor series via the `.x` semver-wildcard convention. Source of truth: `changelog/<major.minor>.x/<version>.md` (e.g. `changelog/0.1.x/0.1.0.md`) — one file per release, shipped in the npm package. At release, author the per-version file with a concrete version and date, then run `npm run changelog:build` to regenerate the rollup. `changelog/template.md` is a **pristine format reference** — never edited or moved; read it for the frontmatter + section layout when scaffolding. `CHANGELOG.md` is a **navigation index** (header + link + summary per version), regenerated by `npm run changelog:build` — devcheck hard-fails on drift; never hand-edit it.

Each per-version file opens with YAML frontmatter:

```markdown
---
summary: "One-line headline, ≤350 chars"  # required — powers the rollup index
breaking: false                            # optional — true flags breaking changes
security: false                            # optional — true ONLY for a source-code security fix, never a dependency CVE bump
---

# 0.1.0 — YYYY-MM-DD
...
```

`breaking: true` renders a `· ⚠️ Breaking` badge — use it when consumers must update code on upgrade (signature changes, removed APIs, config renames). `security: true` renders a `· 🛡️ Security` badge and pairs with a `## Security` body section — set it only for a security fix in this server's *own source code*, never for a routine dependency or transitive CVE bump (record those under `## Dependencies`). When both are set, badges render `· ⚠️ Breaking · 🛡️ Security`.

`agent-notes` is an optional free-form field for maintenance agents processing the release downstream. Content here won't appear in the rendered CHANGELOG — it's consumed by agents running the `maintenance` skill. Use it for adoption instructions that don't fit the human-facing sections: new files to create, fields to populate, one-time migration steps. Omit entirely when there's nothing to say.

**Section order:** the Keep a Changelog sequence — Added, Changed, Deprecated, Removed, Fixed, Security — then `Dependencies` last. Include only sections with entries — don't ship empty headers.

**Tag annotations** render as GitHub Release bodies via `--notes-from-tag`. They must be structured markdown — never a flat comma-separated string. Subject omits the version number (GitHub prepends it). See `changelog/template.md` for the full format reference.

---

## Publishing

**Every release goes through a release PR, straight-through** — `git-wrapup`'s "Release PR mode", mode `straight-through`. One run: `git-wrapup` lands the commit stack on `release/<version>`, pushes it, and opens the PR (title = the release commit subject, body = the changelog entry plus a gates section); `release-and-publish` then fast-forwards `main` locally with `git merge --ff-only`, creates the tag on `main`'s tip, pushes `main` and the tag, deletes the branch, and publishes. A caller's brief may run a given release as `gated` instead — a `release-pr-review` pass on the open PR before `release-and-publish`. **Never merge through the GitHub UI or `gh pr merge`**: squash and rebase-merge are disabled in the repo settings because both rewrite the stack (rebase-merge also strips the SSH signatures), and a merge commit breaks the linear history.

---

## Imports

```ts
// Framework — z is re-exported, no separate zod import needed
import { tool, z } from '@cyanheads/mcp-ts-core';
import { McpError, JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';

// Server's own code — via path alias
import { getInspireService } from '@/services/inspire/inspire-service.js';
```

---

## Checklist

- [ ] Zod schemas: all fields have `.describe()`, only JSON-Schema-serializable types (no `z.custom()`, `z.date()`, `z.transform()`, `z.bigint()`, `z.symbol()`, `z.void()`, `z.map()`, `z.set()`, `z.function()`, `z.nan()`)
- [ ] Optional nested objects: handler guards for empty inner values from form-based clients (`if (input.obj?.field && ...)`, not just `if (input.obj)`). When regex/length constraints matter, use `z.union([z.literal(''), z.string().regex(...).describe(...)])` — literal variants are exempt from `describe-on-fields`.
- [ ] JSDoc `@fileoverview` + `@module` on every file
- [ ] `ctx.log` for logging, `ctx.state` for storage
- [ ] Handlers throw on failure — error factories or plain `Error`, no try/catch
- [ ] `format()` renders all data the LLM needs — different clients forward different surfaces (Claude Code → `structuredContent`, Claude Desktop → `content[]`); both must carry the same data
- [ ] If wrapping external API: raw/domain/output schemas reviewed against real upstream sparsity/nullability before finalizing required vs optional fields
- [ ] If wrapping external API: normalization and `format()` preserve uncertainty; do not fabricate facts from missing upstream data
- [ ] If wrapping external API: tests include at least one sparse payload case with omitted upstream fields
- [ ] Registered in `createApp()` arrays (directly or via barrel exports)
- [ ] Tests use `createMockContext()` from `@cyanheads/mcp-ts-core/testing`
- [ ] `.codex-plugin/plugin.json` populated — `name`, `version`, `description`, `repository`, `license` from `package.json`; `interface.displayName` = the unscoped repo name (never the npm scope — `lint:packaging` enforces this); `interface.shortDescription` from `package.json` description
- [ ] `.codex-plugin/mcp.json` updated — server name key is the unscoped repo name; every user-supplied variable (API key, contact email, instance URL) is listed in `env_vars` so Codex forwards it from the user's environment. Never write `"KEY": ""` into `env` — an empty value replaces the user's exported key and is read as unset
- [ ] `.claude-plugin/plugin.json` populated — `name`, `version`, `description`, `author`, `repository`, `license`, `keywords` from `package.json`; inline `mcpServers` entry keyed by the unscoped repo name. Every user-supplied variable is declared under `userConfig` (`type`, `title`, `description`; `sensitive: true` for keys and tokens; `required: true` or `default: ""`) and referenced from `env` as `"KEY": "${user_config.<option>}"` — mirror the `user_config` block in `manifest.json`. Never write `"KEY": ""` into `env`
- [ ] Every INSPIRE request goes through `InspireService` with the call opened by `inspire.beginCall(ctx)`; a new upstream parameter is added to `InspireParams` / `PARAM_NAMES`, a new field to the matching `*_FIELDS` list (never `email_addresses`), and nothing is sent to hepdata.net
- [ ] Optional and defaulted inputs wrapped in `blankAsUnset`; paper, facet, year, and author inputs reused from `src/mcp-server/tools/inputs.ts`
- [ ] Required enrichment written with neutral values before the first upstream call or branch
- [ ] Error contract declared inline: `inspire_rate_limited`, `pacer_shed`, `upstream_unreadable` (`thrownBy: 'service'`), plus `invalid_query` when the tool sends a caller query; caller-input reasons carry `severity: 'notice'`
- [ ] Every upstream or caller string in `format()` passes through a `render.ts` helper
- [ ] Surface change mirrored in `docs/design.md`, the server instructions (`src/index.ts` and design § Server Instructions with its character count), `cern_inspire_list_reference` when vocabulary changes, and the README Overview and Capability reference
- [ ] `npm run devcheck` passes
