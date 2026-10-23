# Stella API

The Stella backend API built with [Elysia](https://elysiajs.com/).

## Getting Started

### Install dependencies

```bash
bun install
```

### Run the development server

```bash
bun --filter @stll/api dev
```

The API serves on [http://localhost:3001](http://localhost:3001) by default.

## Response conformance

The integration preload validates HTTP responses against the matched route's
response schema, including the status. Direct safe-handler calls validate their
configured response schema; MCP results validate their declared output schema.
Failures identify the route or tool, status, and first issue path without printing
response data. Missing declarations are tracked as debt.

`response-conformance-census.json` is generated from the composed router and the
MCP/capability registries. Its test coverage uses statically resolved invocations:
HTTP calls and direct-handler calls are recorded separately. Imports alone do not
count, and source calls do not claim a completed test execution. Dynamic tool
families are recorded as templates; upstream text relays retain their explicit
schema exemption.

From the repository root:

```bash
bun apps/api/scripts/response-conformance-census.ts --write
bun apps/api/scripts/response-conformance-guard.ts --self-test
bun apps/api/scripts/response-conformance-guard.ts --check
```

The existing MCP coverage CI guard checks a freshly generated census and the
shrink-only `response-conformance-baseline.json`. A new missing schema or missing
resolved test call fails. After fixing existing debt, regenerate the census and
run the guard with `--write` to prune its baseline; that command refuses growth.
Existing web API type, CLI runtime, capability-catalog, and MCP contract generation
checks remain the client-drift checks. PR test selection stays affected-only.

Full API runs also write `response-conformance-execution.json` in their existing
test artifact directory and print a runtime summary. Nightly API shards upload
these reports as artifacts. Set
`RESPONSE_CONFORMANCE_REPORT` to choose another output path for a dispatch run.
Only successful child batches contribute; incomplete reports say so. These
observations are informational: HTTP templates include test-created Elysia apps,
handler contexts are not endpoint identities, and neither replaces the static
census or its PR gate. Reports contain templates, tool names, and test provenance,
never request URLs or response bodies.
