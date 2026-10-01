# cern-inspire-mcp-server - Directory Structure

Generated on: 2026-10-01 11:02:12

```text
cern-inspire-mcp-server/
├── .claude-plugin/
│   └── plugin.json
├── .codex-plugin/
│   ├── mcp.json
│   └── plugin.json
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── bug_report.yml
│   │   ├── config.yml
│   │   └── feature_request.yml
│   ├── workflows/
│   │   └── codeql.yml
│   ├── CODE_OF_CONDUCT.md
│   ├── CONTRIBUTING.md
│   ├── FUNDING.yml
│   └── SECURITY.md
├── .vscode/
│   ├── extensions.json
│   └── settings.json
├── changelog/
│   ├── 0.1.x/
│   └── template.md
├── docs/
│   └── design.md
├── framework-skills/
│   ├── add-app-tool/
│   │   └── SKILL.md
│   ├── add-prompt/
│   │   └── SKILL.md
│   ├── add-resource/
│   │   └── SKILL.md
│   ├── add-service/
│   │   └── SKILL.md
│   ├── add-test/
│   │   └── SKILL.md
│   ├── add-tool/
│   │   └── SKILL.md
│   ├── api-auth/
│   │   └── SKILL.md
│   ├── api-canvas/
│   │   └── SKILL.md
│   ├── api-config/
│   │   └── SKILL.md
│   ├── api-context/
│   │   └── SKILL.md
│   ├── api-errors/
│   │   └── SKILL.md
│   ├── api-linter/
│   │   └── SKILL.md
│   ├── api-mirror/
│   │   └── SKILL.md
│   ├── api-services/
│   │   ├── references/
│   │   │   ├── graph.md
│   │   │   ├── llm.md
│   │   │   └── speech.md
│   │   └── SKILL.md
│   ├── api-telemetry/
│   │   └── SKILL.md
│   ├── api-testing/
│   │   └── SKILL.md
│   ├── api-utils/
│   │   ├── references/
│   │   │   ├── formatting.md
│   │   │   ├── parsing.md
│   │   │   └── security.md
│   │   └── SKILL.md
│   ├── api-workers/
│   │   └── SKILL.md
│   ├── code-simplifier/
│   │   └── SKILL.md
│   ├── design-mcp-server/
│   │   └── SKILL.md
│   ├── field-test/
│   │   └── SKILL.md
│   ├── git-wrapup/
│   │   └── SKILL.md
│   ├── maintenance/
│   │   └── SKILL.md
│   ├── orchestrations/
│   │   ├── workflows/
│   │   │   ├── field-test-fix.md
│   │   │   ├── fix-wrapup-release.md
│   │   │   ├── greenfield-build.md
│   │   │   └── maintenance-release.md
│   │   └── SKILL.md
│   ├── polish-docs-meta/
│   │   ├── references/
│   │   │   ├── agent-protocol.md
│   │   │   ├── package-meta.md
│   │   │   ├── readme.md
│   │   │   └── server-json.md
│   │   └── SKILL.md
│   ├── release-and-publish/
│   │   └── SKILL.md
│   ├── release-pr-review/
│   │   └── SKILL.md
│   ├── report-issue-framework/
│   │   └── SKILL.md
│   ├── report-issue-local/
│   │   └── SKILL.md
│   ├── security-pass/
│   │   └── SKILL.md
│   ├── setup/
│   │   └── SKILL.md
│   ├── techniques/
│   │   ├── references/
│   │   │   └── outline-on-overflow.md
│   │   └── SKILL.md
│   └── tool-defs-analysis/
│       └── SKILL.md
├── scripts/
│   ├── build-changelog.ts
│   ├── build.ts
│   ├── check-dependency-specifiers.ts
│   ├── check-docs-sync.ts
│   ├── check-framework-antipatterns.ts
│   ├── check-skill-versions.ts
│   ├── check-skills-sync.ts
│   ├── clean-mcpb.ts
│   ├── clean.ts
│   ├── devcheck.ts
│   ├── install-otel.ts
│   ├── lint-mcp.ts
│   ├── lint-packaging.ts
│   ├── list-skills.ts
│   ├── release-github.ts
│   └── tree.ts
├── src/
│   ├── mcp-server/
│   │   ├── resources/
│   │   │   └── definitions/
│   │   │       ├── index.ts
│   │   │       └── inspire-literature.resource.ts
│   │   └── tools/
│   │       ├── definitions/
│   │       │   ├── export-citations.tool.ts
│   │       │   ├── get-citation-summary.tool.ts
│   │       │   ├── get-paper.tool.ts
│   │       │   ├── index.ts
│   │       │   ├── list-reference.tool.ts
│   │       │   ├── search-authors.tool.ts
│   │       │   ├── search-experiments.tool.ts
│   │       │   ├── search-hepdata.tool.ts
│   │       │   └── search-literature.tool.ts
│   │       └── inputs.ts
│   ├── services/
│   │   ├── http/
│   │   │   └── fetch-bounded.ts
│   │   └── inspire/
│   │       ├── identifiers.ts
│   │       ├── inspire-service.ts
│   │       ├── normalize.ts
│   │       ├── types.ts
│   │       └── vocabulary.ts
│   ├── utils/
│   │   └── render.ts
│   └── index.ts
├── tests/
│   ├── fixtures/
│   │   ├── active-service.ts
│   │   ├── failure-suite.ts
│   │   ├── inspire-upstream.ts
│   │   ├── service-harness.ts
│   │   └── tool-result.ts
│   ├── resources/
│   │   └── inspire-literature.resource.test.ts
│   ├── services/
│   │   ├── fetch-bounded.test.ts
│   │   ├── inspire-service-lifecycle.test.ts
│   │   ├── inspire-service-transport.test.ts
│   │   └── inspire-service.test.ts
│   ├── shared/
│   │   ├── identifiers.test.ts
│   │   ├── inputs.test.ts
│   │   └── render.test.ts
│   └── tools/
│       ├── export-citations.tool.test.ts
│       ├── get-citation-summary.tool.test.ts
│       ├── get-paper.tool.test.ts
│       ├── list-reference.tool.test.ts
│       ├── search-authors.tool.test.ts
│       ├── search-experiments.tool.test.ts
│       ├── search-hepdata.tool.test.ts
│       └── search-literature.tool.test.ts
├── .dockerignore
├── .env.example
├── .gitattributes
├── .gitignore
├── .mcpbignore
├── AGENTS.md
├── biome.json
├── bun.lock
├── bunfig.toml
├── CHANGELOG.md
├── CLAUDE.md
├── devcheck.config.json
├── Dockerfile
├── LICENSE
├── manifest.json
├── package.json
├── README.md
├── server.json
├── tsconfig.build.json
├── tsconfig.json
└── vitest.config.ts
```

_Note: This tree excludes files and directories matched by .gitignore and default patterns._
