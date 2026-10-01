<div align="center">
  <h1>@cyanheads/cern-inspire-mcp-server</h1>
  <p><b>Search INSPIRE-HEP papers, authors, experiments, HEPData records; get citation metrics and BibTeX via MCP. STDIO or Streamable HTTP.</b>
  <div>8 Tools • 1 Resource</div>
  </p>
</div>

<div align="center">

[![Version](https://img.shields.io/badge/Version-0.1.1-blue.svg?style=flat-square)](./CHANGELOG.md) [![License](https://img.shields.io/badge/License-Apache%202.0-orange.svg?style=flat-square)](./LICENSE) [![Docker](https://img.shields.io/badge/Docker-ghcr.io-2496ED?style=flat-square&logo=docker&logoColor=white)](https://github.com/users/cyanheads/packages/container/package/cern-inspire-mcp-server) [![MCP SDK](https://img.shields.io/badge/MCP%20SDK-^2.1.0-green.svg?style=flat-square)](https://modelcontextprotocol.io/) [![npm](https://img.shields.io/npm/v/@cyanheads/cern-inspire-mcp-server?style=flat-square&logo=npm&logoColor=white)](https://www.npmjs.com/package/@cyanheads/cern-inspire-mcp-server) [![TypeScript](https://img.shields.io/badge/TypeScript-^7.0.2-3178C6.svg?style=flat-square)](https://www.typescriptlang.org/) [![Bun](https://img.shields.io/badge/Bun-v1.4.2-blueviolet.svg?style=flat-square)](https://bun.sh/)

</div>

<div align="center">

[![Install in Claude Desktop](https://img.shields.io/badge/Install_in-Claude_Desktop-D97757?style=for-the-badge&logo=anthropic&logoColor=white)](https://github.com/cyanheads/cern-inspire-mcp-server/releases/latest/download/cern-inspire-mcp-server.mcpb) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=cern-inspire-mcp-server&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBjeWFuaGVhZHMvY2Vybi1pbnNwaXJlLW1jcC1zZXJ2ZXIiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect?url=vscode:mcp/install?%7B%22name%22%3A%22cern-inspire-mcp-server%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22%40cyanheads%2Fcern-inspire-mcp-server%22%5D%7D)

[![Framework](https://img.shields.io/badge/Built%20on-@cyanheads/mcp--ts--core-67E8F9?style=flat-square)](https://www.npmjs.com/package/@cyanheads/mcp-ts-core)

</div>

---

## Overview

High-energy-physics literature from INSPIRE-HEP, including its index of HEPData measurement records. Search papers, authors, and experiments, read a paper's full record, compute citation summaries and h-indices, export BibTeX or LaTeX entries, and find the HEPData record that holds a paper's numerical tables. Runs as a stdio process or a local Streamable HTTP server.

### Tools

| Tool | Description |
|:---|:---|
| `cern_inspire_search_literature` | Search papers with INSPIRE query syntax or free text, filtered by document type, subject, and year |
| `cern_inspire_get_paper` | Fetch one paper's full record by recid, arXiv ID, or DOI, with its HEPData availability |
| `cern_inspire_export_citations` | Export INSPIRE's BibTeX or LaTeX `\bibitem` entries for the papers a query selects |
| `cern_inspire_search_authors` | Find physicist profiles by name, BAI, ORCID, INSPIRE ID, or author recid |
| `cern_inspire_get_citation_summary` | h-index, citation totals, and citation buckets for one author or any literature query |
| `cern_inspire_search_experiments` | Find experiments, collaborations, and facilities, with a query that selects their papers |
| `cern_inspire_search_hepdata` | Find HEPData measurement records by process, observable, energy, or collaboration |
| `cern_inspire_list_reference` | Decode query syntax, identifier forms, filter values, citation buckets, and HEPData DOIs |

### Resources

| Resource | Description |
|:---|:---|
| `inspire://literature/{recid}` | One literature record as the `cern_inspire_get_paper` dossier in JSON |

The same record is reachable through `cern_inspire_get_paper` for clients that don't surface resources.

## Capability reference

### `cern_inspire_search_literature` <sub>tool</sub>

- INSPIRE query syntax or free text, with `sort` (`relevance`, `mostrecent`, `mostcited`), `document_types` and `subjects` (up to 4 values each, all of which must hold), and `year_from` / `year_to`; `size` 1–100 (default 10), paged by `page`
- Only the first 10,000 results of a query are reachable: `page × size` beyond that fails as `beyond_result_window`, and a reversed year range as `invalid_year_range`
- Hits carry `recid`, title, first author, date, citation counts, arXiv ID, DOI, publication, and a 300-character abstract snippet; `totalCount`, `nextPage`, and `appliedFilters` come back with the page, and a `notice` flags any query matching over 100,000 records

---

### `cern_inspire_get_paper` <sub>tool</sub>

- `paper` takes a recid, arXiv ID, DOI, inspirehep.net literature URL, or HEPData `ins<recid>` / hepdata.net record URL; `resolvedAs` names the form that matched, and a miss fails as `paper_not_found`
- `max_authors` 0–500 (default 25) caps the author list; `authorCount` always gives the full number
- `hepdata.status` is `available`, `none`, or `lookup_failed`, with `recordDoi`, `latestVersion`, `tableCount`, and `hepdataUrl` when available; `citingQuery` and `referencesQuery` feed `cern_inspire_search_literature`

---

### `cern_inspire_export_citations` <sub>tool</sub>

- Any literature query (`recid:451647 or arxiv:1207.7214` for named papers); `format` is `bibtex` (default), `latex-eu`, or `latex-us`; `size` 1–50 (default 10)
- Entries arrive verbatim from INSPIRE, each with its `texkey`; `truncated` is set when more papers matched than `size`

---

### `cern_inspire_search_authors` <sub>tool</sub>

- A name or one identifier (BAI, ORCID, INSPIRE ID, author recid); `limit` 1–25 (default 5)
- `matchedAs` reports the route: `orcid`, `inspire_id`, `bai`, and `recid` match exactly, while `name` runs a free-text search whose ranked candidates are returned for the caller to choose from
- Profiles carry `recid`, `bai`, ORCID, positions, advisors, arXiv categories, awards, and a `literatureQuery` selecting the person's papers

---

### `cern_inspire_get_citation_summary` <sub>tool</sub>

- Exactly one of `author` (BAI, ORCID, INSPIRE ID, or author recid) or `query` (any literature query); otherwise `missing_target`, and a name passed as `author` fails as `author_not_identifier`
- `document_types`, `subjects`, and `year_from` / `year_to` narrow every figure; `exclude_self_citations` recounts without self-citations
- h-index, citation totals and averages, and paper counts in the buckets `0`, `1–9`, `10–49`, `50–99`, `100–249`, `250–499`, `500+`, each for all citeable and for published papers

---

### `cern_inspire_search_experiments` <sub>tool</sub>

- An experiment, collaboration, accelerator, or facility name, an INSPIRE legacy name (`CERN-LHC-CMS`), or an experiment recid (digits only); `limit` 1–25 (default 5)
- Records carry the accelerator, host institutions, collaboration, lifecycle dates, `ongoing` (omitted when INSPIRE records neither state), INSPIRE's paper count, and a `literatureQuery` for `cern_inspire_search_literature` or `cern_inspire_get_citation_summary`

---

### `cern_inspire_search_hepdata` <sub>tool</sub>

- Free text or INSPIRE syntax over HEPData submissions (`collaborations.value:LHCb`, `literature.control_number:<recid>`); `sort` is `relevance` or `mostrecent`; `size` 1–50 (default 10), within the same 10,000-result window
- Records carry `paperRecids`, collaborations, keywords (reactions, observables, centre-of-mass energies), `recordDoi`, `latestVersion`, `tableCount`, and `hepdataUrl`; table values are not returned

---

### `cern_inspire_list_reference` <sub>tool</sub>

- `topic`: `search_syntax`, `identifiers`, `document_types`, `subjects`, `citation_buckets`, or `hepdata`
- Static `term` / `meaning` / `example` entries with no upstream call

---

### `inspire://literature/{recid}` <sub>resource</sub>

- The `cern_inspire_get_paper` dossier for one recid as `application/json`, listing the first 25 authors
- Takes a recid only; use the tool for arXiv IDs, DOIs, or a higher author cap

## Features

Built on [`@cyanheads/mcp-ts-core`](https://github.com/cyanheads/mcp-ts-core): stdio and Streamable HTTP transports, pluggable auth (`none` / `jwt` / `oauth`), swappable storage (`in-memory`, `filesystem`, `Supabase`, `Cloudflare KV/R2/D1`), structured logging with optional OpenTelemetry tracing.

INSPIRE-specific:

- One process-wide pacer under INSPIRE's published 15 requests per 5 s: 12 request starts per 5 s, at most 4 in flight, and a shared cooldown after a 429 that starts at 5 s and doubles on each consecutive 429, up to 30 s
- One 55 s budget per tool call covers queue wait, up to 2 retries, and every request the call makes; a request that can't start in time fails at once as `pacer_shed` with a `retryAfter`
- JSON requests select only the fields a tool returns, under an 8 MiB response ceiling and a strict query-parameter allowlist, since INSPIRE silently ignores parameters it doesn't know; author email addresses are never requested
- Forgiving inputs: paper identifiers accept an `arXiv:` or `doi:` prefix, a version suffix, an arxiv.org, doi.org, or inspirehep.net URL, and HEPData's `ins<recid>`; author identifiers accept an orcid.org URL; `document_types` and `subjects` take an array or a comma-joined string in any case

Agent-friendly output:

- Chainable identifiers: hits carry `recid`, author profiles and experiments carry a ready `literatureQuery`, and `cern_inspire_get_paper` returns `citingQuery` and `referencesQuery`, so the next call needs no query building
- Query echo and paging state: `totalCount`, `truncated` / `shown` / `cap`, `nextPage`, `appliedFilters`, and `effectiveQuery`, plus a `notice` with next-step text on empty, capped, or suspiciously broad results
- Discriminated fields: `hepdata.status`, `resolvedAs`, `matchedAs`, and `target.kind` let callers branch on data, and typed failure reasons (`paper_not_found`, `author_not_found`, `beyond_result_window`, `inspire_rate_limited`) each carry a recovery hint
- No fabrication: a field INSPIRE leaves out stays absent and prints as "Not available" or "not recorded"; upstream strings are escaped in the text output and kept verbatim in `structuredContent`

## Data and licensing

- INSPIRE-HEP metadata is mostly CC0 under INSPIRE's [terms of use](https://inspirehep.net/help/knowledge-base/terms-of-use/); credit INSPIRE when you reuse it.
- HEPData records are CC0; cite the HEPData record DOI (`recordDoi`) when you reuse the data.
- INSPIRE allows 15 requests per 5 seconds per address, and the server paces its own requests under that limit.
- This is an independent project, not affiliated with or endorsed by INSPIRE-HEP, HEPData, or CERN.

## Known limitations

- **No HEPData table values.** hepdata.net's bot challenge refuses the server's User-Agent, so tools that read hepdata.net directly are deferred. `cern_inspire_get_paper` and `cern_inspire_search_hepdata` return the record DOI and the hepdata.net page where the values are read.
- **Malformed INSPIRE syntax doesn't fail.** An unparsed operator widens or empties the match instead; zero hits or a very large `totalCount` usually means a syntax slip (`cern_inspire_list_reference` topic `search_syntax`).
- **10,000-result window.** Only the first 10,000 results of a query are reachable; narrow the query to reach the rest.
- **One request queue per process, one rate limit per address.** Every caller of a server process shares one queue under INSPIRE's 15 requests per 5 s, so on a shared deployment one client's burst can delay or shed everyone else's calls with a retryable rate-limit error.

## Getting started

Add the following to your MCP client configuration file. No API key is needed.

```json
{
  "mcpServers": {
    "cern-inspire-mcp-server": {
      "type": "stdio",
      "command": "bunx",
      "args": ["@cyanheads/cern-inspire-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with npx (no Bun required):

```json
{
  "mcpServers": {
    "cern-inspire-mcp-server": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@cyanheads/cern-inspire-mcp-server@latest"],
      "env": {
        "MCP_TRANSPORT_TYPE": "stdio",
        "MCP_LOG_LEVEL": "info"
      }
    }
  }
}
```

Or with Docker:

```json
{
  "mcpServers": {
    "cern-inspire-mcp-server": {
      "type": "stdio",
      "command": "docker",
      "args": ["run", "-i", "--rm", "-e", "MCP_TRANSPORT_TYPE=stdio", "ghcr.io/cyanheads/cern-inspire-mcp-server:latest"]
    }
  }
}
```

For Streamable HTTP, set the transport and start the server:

```sh
MCP_TRANSPORT_TYPE=http MCP_HTTP_PORT=3010 bun run start:http
# Server listens at http://localhost:3010/mcp
```

### Prerequisites

- [Bun v1.4.0](https://bun.sh/) or higher (or Node.js v24+).
- Nothing else: INSPIRE-HEP's API is public and keyless.

### Installation

1. **Clone the repository:**

```sh
git clone https://github.com/cyanheads/cern-inspire-mcp-server.git
```

2. **Navigate into the directory:**

```sh
cd cern-inspire-mcp-server
```

3. **Install dependencies:**

```sh
bun install
```

4. **Configure environment (optional):**

```sh
cp .env.example .env
# edit .env to change the transport, logging, or session settings
```

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

## Project structure

| Directory | Purpose |
|:---|:---|
| `src/index.ts` | `createApp()` entry point: registers the tools and resource, sets the server instructions, starts and disposes the INSPIRE service. |
| `src/mcp-server/tools` | Tool definitions (`*.tool.ts`), eight tools, plus shared input schemas (`inputs.ts`). |
| `src/mcp-server/resources` | Resource definitions. The literature record resource. |
| `src/services/inspire` | INSPIRE service: request pacer, per-call budget, retries, identifier routing, normalization, and the controlled vocabularies. |
| `src/services/http` | Bounded fetch: per-attempt timeout and response byte ceiling. |
| `src/utils` | Escaping for upstream text in tool output and error messages (`render.ts`). |
| `tests/` | Vitest suites for the tools, resource, services, and shared helpers, with INSPIRE response fixtures. |
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
