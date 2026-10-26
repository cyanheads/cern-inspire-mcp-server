<div align="center">
  <h1>@cyanheads/cern-inspire-mcp-server</h1>
  <p><b>Search INSPIRE-HEP papers, authors, experiments, HEPData records; get citation metrics and BibTeX via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 1 Literature Resource Template • 1 Agent Skill</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.2.0-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/cern-inspire-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.4.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/cern-inspire-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cern-inspire-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.4-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/cern-inspire-mcp-server/releases/latest/download/cern-inspire-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=cern-inspire-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2Vybi1pbnNwaXJlLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22cern-inspire-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcern-inspire-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

<div align="center">

**Public Hosted Server:** [https://cern-inspire.caseyjhand.com/mcp](https://cern-inspire.caseyjhand.com/mcp)

</div>

---

## Overview

High-energy-physics literature from INSPIRE-HEP and the HEPData tables behind it. Search papers, authors, and experiments, compute citation summaries and h-indices, export BibTeX or LaTeX, and find the record holding a paper's numerical data.

### Tools

| Tool | Description |
|:---|:---|
| `cern_inspire_search_literature` | Search papers with INSPIRE query syntax or free text, filtered by document type, subject, and year |
| `cern_inspire_get_paper` | Fetch one paper's full record by recid, arXiv ID, or DOI, with its HEPData availability |
| `cern_inspire_export_citations` | Export INSPIRE's BibTeX or LaTeX `\bibitem` entries for the papers a query selects |
| `cern_inspire_search_authors` | Find physicist profiles by name, BAI, ORCID, INSPIRE ID, or author recid |
| `cern_inspire_get_citation_summary` | h-index, citation totals, citation buckets, and citations per year for one author or any literature query |
| `cern_inspire_search_experiments` | Find experiments, collaborations, and facilities, with a query that selects their papers |
| `cern_inspire_search_hepdata` | Find HEPData measurement records by process, observable, energy, or collaboration |
| `cern_inspire_list_reference` | Decode query syntax, identifier forms, filter values, citation buckets, and HEPData DOIs |

### Resources

| Resource | Description |
|:---|:---|
| `inspire://literature/{recid}` | One literature record as the `cern_inspire_get_paper` dossier in JSON |

The same record is reachable through `cern_inspire_get_paper` for clients that don't surface resources.

### Agent skill

[`cern-inspire-guide`](./skills/cern-inspire-guide/SKILL.md) covers identifier routing, query syntax, and research workflows. Plugin installs, npm, Docker, and the Claude Desktop bundle include it. MCP clients can discover it through `skills/list` or read `skill://cern-inspire-guide/SKILL.md` from `resources/list`.

## Capability reference

### `cern_inspire_search_literature` <sub>tool</sub>

- INSPIRE query syntax or free text, with `sort` (`relevance`, `mostrecent`, `mostcited`), `document_types` and `subjects` (up to 4 values each, all must hold), and `year_from` / `year_to`; positive integer `size` (default 10, clamped to 100), paged by `page`
- Only the first 10,000 results of a query are reachable: `page × effective size` beyond that fails as `beyond_result_window`; a reversed year range fails as `invalid_year_range`
- Hits carry `recid`, title, first author, date, citation counts, arXiv ID, DOI, publication, and a 300-character abstract snippet; the page also returns `totalCount`, `nextPage`, and `appliedFilters`, and a `notice` flags queries matching over 100,000 records

---

### `cern_inspire_get_paper` <sub>tool</sub>

- `paper` takes a recid, arXiv ID, DOI, inspirehep.net literature URL, or HEPData `ins<recid>` / hepdata.net `record/ins<recid>` URL; `resolvedAs` names the form that matched, and a miss fails as `paper_not_found`. A merged recid returns the surviving record, with `mergedFrom` naming the recid asked for
- `max_authors` (default 25, capped at 500) and `author_offset` (default 0) page through contributors; pass `nextAuthorOffset` to continue. Entries retain recorded `roles` (such as editor or supervisor); an absent role stays unknown. `authorCount` retains INSPIRE's count, falling back to the available contributor-list length
- `documents` lists public attached-document URLs with recorded filename, description, material, and full-text status; hidden and URL-less entries are omitted. Files are not downloaded. External `urls` remain separate; `citingQuery` and `referencesQuery` feed `cern_inspire_search_literature`
- `hepdata.status` is `available`, `none`, or `lookup_failed`, with `recordDoi`, `latestVersion`, `tableCount`, and `hepdataUrl` when available; extra HEPData records appear in `hepdata.otherRecords`

---

### `cern_inspire_export_citations` <sub>tool</sub>

- Any literature query (`recid:451647 or arxiv:1207.7214` for named papers), with the same `document_types`, `subjects`, `year_from`, `year_to`, and `sort` as search; reversed years fail as `invalid_year_range`
- `format` is `bibtex` (default), `latex-eu`, or `latex-us`; positive integer `size` (default 10, clamped to 50), paged by `page` within the first 10,000 matches (beyond that, `beyond_result_window`)
- Entries arrive verbatim from INSPIRE, each with its `texkey`; `truncated` and `nextPage` signal more results, and `appliedFilters` echoes the selection

---

### `cern_inspire_search_authors` <sub>tool</sub>

- A name or one identifier (BAI, ORCID, INSPIRE ID, author recid); positive integer `limit` (default 5, clamped to 25)
- `matchedAs` is `orcid`, `inspire_id`, `bai`, or `recid` (exact match), or `name` (free-text search returning ranked candidates to choose from)
- Profiles carry `recid`, `bai`, ORCID, positions (with an `institutionRecid` that `affid:N` takes for the institution's papers), advisors, arXiv categories, awards, and a `literatureQuery` selecting the person's papers

---

### `cern_inspire_get_citation_summary` <sub>tool</sub>

- Exactly one of `author` (BAI, ORCID, INSPIRE ID, or author recid) or `query` (any literature query, such as `affid:902725` for an institution's papers); otherwise `missing_target`, and a name passed as `author` fails as `author_not_identifier`
- Narrow with `document_types`, `subjects`, `year_from`, `year_to`, and `exclude_self_citations`
- Returns h-index, citation totals and averages, and paper counts in the buckets `0`, `1–9`, `10–49`, `50–99`, `100–249`, `250–499`, `500+`, each for all citeable and for published papers
- `citationsByYear` is omitted, with a notice, when `year_from`, `year_to`, or `exclude_self_citations` is set, when INSPIRE does not return it, or for queries matching more than about 150,000 records

---

### `cern_inspire_search_experiments` <sub>tool</sub>

- An experiment, collaboration, accelerator, or facility name, an INSPIRE legacy name (`CERN-LHC-CMS`), or an experiment recid (digits only); positive integer `limit` (default 5, clamped to 25)
- Records carry the accelerator, host institutions, collaboration, lifecycle dates, `ongoing` (omitted when INSPIRE records neither state), INSPIRE's paper count, and a `literatureQuery` for `cern_inspire_search_literature` or `cern_inspire_get_citation_summary`

---

### `cern_inspire_search_hepdata` <sub>tool</sub>

- Free text or INSPIRE syntax over HEPData submissions (`collaborations.value:LHCb`, `literature.control_number:<recid>`); `sort` is `relevance` or `mostrecent`; positive integer `size` (default 10, clamped to 50), within the same 10,000-result window
- Records carry `paperRecids`, collaborations, keywords (reactions, observables, centre-of-mass energies), `recordDoi`, `latestVersion`, `tableCount`, and `hepdataUrl` (each record's own hepdata.net page); table values are not returned

---

### `cern_inspire_list_reference` <sub>tool</sub>

- `topic`: `search_syntax`, `identifiers`, `document_types`, `subjects`, `citation_buckets`, or `hepdata`
- Static `term` / `meaning` / `example` entries; no upstream call

---

### `inspire://literature/{recid}` <sub>resource</sub>

- The `cern_inspire_get_paper` dossier as `application/json`, with the first 25 contributors, their recorded roles, and public attached-document links
- Takes a recid only; use the tool for arXiv IDs, DOIs, or further contributor pages. A merged recid serves the surviving record, with `mergedFrom`

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

INSPIRE-specific:

- Paces requests to 12 per 5 s, under INSPIRE's limit of 15, with a cooldown after a 429; a call that can't start in time fails as `pacer_shed` with a `retryAfter`
- 55 s budget per tool call, including queue wait and up to 2 retries
- Requests select only the fields a tool returns; author email addresses are never requested
- Forgiving inputs: paper identifiers accept `arXiv:` / `doi:` prefixes, version suffixes, and arxiv.org, doi.org, or inspirehep.net URLs; author identifiers accept an orcid.org URL

Agent-friendly output:

- Positive integer result budgets above the ceiling succeed with a notice stating requested and effective values: literature 100, HEPData and citation export 50, author and experiment search 25. Defaults stay unchanged; zero, negative, and fractional budgets fail. Paging and the 10,000-result window use the effective size
- Chainable identifiers: hits carry `recid`, author profiles and experiments carry a ready `literatureQuery`, and `cern_inspire_get_paper` returns `citingQuery` and `referencesQuery`
- Query echo and paging state: `totalCount`, `truncated` / `shown` / `cap`, `nextPage`, `appliedFilters`, and `effectiveQuery`, plus a `notice` with next-step text on empty, capped, or suspiciously broad results
- Discriminated fields: `hepdata.status`, `resolvedAs`, `matchedAs`, and `target.kind` let callers branch on data; typed failure reasons (`paper_not_found`, `author_not_found`, `beyond_result_window`, `inspire_rate_limited`) each carry a recovery hint
- No fabrication: a field INSPIRE leaves out stays absent and prints as "Not available" or "not recorded"
- Titles and abstracts as text: publisher HTML, JATS, and MathML become plain text (`σ_γ`, `^{23}Na(n,γ)`), with LaTeX left as published and citation export entries verbatim

## Data and licensing

- INSPIRE-HEP metadata is mostly CC0 under INSPIRE's [terms of use](https://inspirehep.net/help/knowledge-base/terms-of-use/); credit INSPIRE when you reuse it.
- HEPData records are CC0; cite the HEPData record DOI (`recordDoi`) when you reuse the data.
- This is an independent project, not affiliated with or endorsed by INSPIRE-HEP, HEPData, or CERN.

## Known limitations

- **No HEPData table values.** hepdata.net's bot challenge refuses the server's User-Agent, so the server never calls it. `cern_inspire_get_paper` and `cern_inspire_search_hepdata` return the record DOI and the hepdata.net page where the values are read.
- **Malformed INSPIRE syntax mostly doesn't fail.** Literature search, citation summaries, and citation export reject empty recognized field clauses (`a:`, `a: not`, or `a:""`, including whitespace-only quoted values) as `invalid_query`; give each field a value (`a Witten`). Otherwise an unparsed operator widens or empties the match; zero hits or a very large `totalCount` usually means a syntax slip (`cern_inspire_list_reference` topic `search_syntax`).
- **Selection checks cost an extra request.** Literature search verifies filtered selections and later pages; export verifies filtered first pages and all later pages. This prevents INSPIRE's reference fallback from bypassing filters or repeating exhausted results. A required verification failure fails the call; unfiltered first pages keep one request
- **10,000-result window.** Only the first 10,000 results of a query are reachable; narrow the query to reach the rest.
- **Shared request queue.** All callers of one server process share one queue under INSPIRE's 15 requests per 5 s per address, so a burst can delay or shed other calls with a retryable rate-limit error.

## Getting started

Connect to the hosted instance, no install:

```sh
claude mcp add --transport http cern-inspire-mcp-server https://cern-inspire.caseyjhand.com/mcp
```

Every caller of the hosted instance shares one INSPIRE request budget of 12 request starts per 5 seconds. For sustained use, run your own instance:

```sh
claude mcp add cern-inspire-mcp-server -- npx -y @cyanheads/cern-inspire-mcp-server
```

For other clients, add this to the MCP config file:

```json
{
  "mcpServers": {
    "cern-inspire-mcp-server": {
      "command": "npx",
      "args": ["-y", "@cyanheads/cern-inspire-mcp-server"]
    }
  }
}
```

No API key is needed. For Docker or a source build, see [Running the server](#running-the-server).

## Configuration

The server has no settings of its own: INSPIRE needs no key, and the request pacing is fixed in code. These framework variables cover most deployments.

| Variable | Description | Default |
|:---|:---|:---|
| `MCP_TRANSPORT_TYPE` | Transport: `stdio` or `http`. | `stdio` |
| `MCP_HTTP_PORT` | HTTP server port. | `3010` |
| `MCP_SESSION_MODE` | HTTP session mode: `stateless`, `stateful`, or `auto`. `.env.example` and the Docker image set `stateless`. | `auto` |
| `MCP_AUTH_MODE` | Authentication: `none`, `jwt`, or `oauth`. | `none` |
| `MCP_LOG_LEVEL` | Log level (`debug`, `info`, `notice`, `warning`, `error`, etc.). The Docker image sets `info`. | `debug` |
| `LOGS_DIR` | Directory for log files (Node.js only). | `<app-root>/logs` |
| `STORAGE_PROVIDER_TYPE` | Storage backend: `in-memory`, `filesystem`, `supabase`, `cloudflare-kv/r2/d1`. | `in-memory` |
| `OTEL_ENABLED` | Enable [OpenTelemetry](https://github.com/cyanheads/mcp-ts-core/tree/main/docs/telemetry). | `false` |

See [`.env.example`](./.env.example) for the full list of framework overrides.

## Running the server

### Local development

Requires [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+). INSPIRE-HEP's API is public and keyless.

```sh
git clone https://github.com/cyanheads/cern-inspire-mcp-server.git
cd cern-inspire-mcp-server && bun install
cp .env.example .env
# Optional: change transport, logging, or session settings in .env
```

- **Build and run the production version**:

  ```sh
  # One-time build
  bun run rebuild

  # Run the built server
  bun run start:http
  # or
  bun run start:stdio
  ```

- **Run checks and tests**:
  ```sh
  bun run devcheck  # Lints, formats, type-checks, and more
  bun run test      # Runs the test suite
  ```

### Docker

```sh
docker run --rm -p 3010:3010 ghcr.io/cyanheads/cern-inspire-mcp-server:latest
```

The image defaults to HTTP transport, stateless sessions, and logs at `/var/log/cern-inspire-mcp-server`. For an MCP client using stdio, use `"command": "docker"` with `"args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/cern-inspire-mcp-server:latest"]`. Build locally with `docker build -t cern-inspire-mcp-server .`; add `--build-arg OTEL_ENABLED=false` to omit the OpenTelemetry peers.

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers tools and resource, sets server instructions, starts and disposes the INSPIRE service. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`) and shared input schemas (`inputs.ts`). |
| `src/mcp-server/resources` | The literature record resource. |
| `src/services/inspire` | INSPIRE service: pacer, per-call budget, retries, identifier routing, normalization, controlled vocabularies. |
| `src/services/http` | Bounded fetch: per-attempt timeout and response byte ceiling. |
| `src/utils` | Escaping for upstream text in tool output and error messages (`render.ts`). |
| `skills/` | Published `cern-inspire-guide` for agents calling the server. |
| `tests/` | Vitest suites with INSPIRE response fixtures. |
| `docs/design.md` | Tool surface, verified INSPIRE behavior, design decisions, and the deferred HEPData-direct tools. |

## Development guide

See [`CLAUDE.md`](./CLAUDE.md) for development guidelines and architectural rules. The short version:

- Handlers throw, framework catches — no `try/catch` in tool logic
- Every INSPIRE request goes through `InspireService`, with the call opened by `beginCall(ctx)`; handlers never `fetch` directly
- Register new tools and resources in the barrels at `src/mcp-server/tools/definitions/index.ts` and `src/mcp-server/resources/definitions/index.ts`
- Wrap external API calls: validate raw → normalize to domain type → return output schema; never fabricate missing fields

## Contributing

Issues are welcome. Run checks and tests before submitting:

```sh
bun run devcheck
bun run test
```

## License

This project is licensed under the Apache 2.0 License. See the [LICENSE](./LICENSE) file for details.
