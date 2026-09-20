<p align="center">
  <img src="https://raw.githubusercontent.com/stella/stella/main/.github/assets/banners/mcp.webp" alt="stll/mcp" width="100%" />
</p>

# stella MCP server

stella MCP turns a stella workspace into something AI tools can work with
directly. Instead of copying files, pasting matter context, or wiring custom
API calls by hand, MCP-compatible clients can search, read and act through a
single permission-aware gateway.

Use it to give agents structured access to stella matters, documents, contacts,
case law, skills and connected tools. The same gateway can expose anonymized
read/search surfaces for clients that should not receive raw legal or personal
data.

One server, one registry, several audiences. Each audience is its own HTTP
path with its own tool list, server name, resource scopes and connect-time
instructions, because an orchestrator picks tools from the names it was handed:

- `/mcp`: the default stella MCP. It includes first-party stella tools,
  OpenAI-compatible `search` / `fetch` tools, user-managed skills, and enabled
  external MCP connectors.
- `/mcp-anonymized`: the anonymized MCP mode. It exposes the full first-party
  read/search surface (matters, matter overviews, cross-matter search and
  content, contacts, templates, case law, plus the OpenAI-compatible
  `search`/`fetch` tools) for clients that should receive anonymized results.
  Tenant and personal text is redacted on egress; mutating tools and the dynamic
  gateway are not exposed.
- `/mcp-documents`: the least-privilege document surface. Document tools plus
  the version-upload lifecycle through `invoke_capability`, whose capability IDs
  are allowlisted for that surface.
- `/mcp-law`: the public legal corpus. Exactly ten read tools (`search`,
  `fetch`, `search_case_law`, `lookup_case_law`, `read_case_law_decision`,
  `read_case_law_citations`, `search_legislation`, `read_statute`,
  `read_statute_provisions`, `read_provision_history`) under `stella:search`
  and `stella:read`. No matter, document, contact or billing data is reachable
  through it. `search`/`fetch` are the OpenAI-compatible pair, defined and
  handled separately from the default audience's pair of the same names
  (`compat-law-tools.ts`), because a handler never sees the request mode.
  Authentication is the same as every other audience: an OAuth bearer token or
  an API key carrying those two scopes.

Every audience authenticates the same way and serves static MCP resources
through `resources/list` and `resources/read`, but each serves a filtered
subset of them rather than the whole set: a reference for a workflow an
audience carries no tool for is context an agent pays for and cannot use. The
resources are `stella://about` for canonical product identity and official
URLs, `stella://reference/template-markers` for the DOCX template marker
grammar, `stella://reference/template-fields` for the
`configure_template_fields` overlay, `stella://reference/template-workflow` for
the order those two are used in (author, create, read the discovered paths
back, configure, preview, persist), and
`stella://reference/legislation-workflow` for the corpus-reading order.

The default audience serves all of them. The documents audience serves the
product identity and the three template references, and not the legislation
workflow. The law audience serves the product identity and the legislation
workflow, and none of the template references.

Each audience is also an OAuth resource, and adding one needs no operator step.
It widens the resource set the startup census requires, and startup never seeds
an existing database, so the reconciliation belongs to the deploy: the migrate
task's `better-auth-oauth-resources` online repair inserts any configured
resource the table lacks and links every existing client registration to it,
before the API rolls. It refuses a stored definition that disagrees with the
configured one rather than overwriting it, and its completion check is the same
census the API runs at startup, so a partial repair fails the deploy instead of
the boot.

OAuth protected-resource discovery is served from:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource/mcp-anonymized`
- `/.well-known/oauth-protected-resource/mcp-documents`
- `/.well-known/oauth-protected-resource/mcp-law`

## Comparing files stella does not store

`compare_documents` redlines stored document versions. For two `.docx` files
that are not in stella, `prepare_file_comparison` reserves a slot for each:
it returns a presigned PUT url with the exact headers to send, and the
`compare_documents` call to make next, spelled out. The client uploads the
bytes; the comparison then verifies each object's size and checksum against
what was declared, scans it the way a document upload is scanned, runs the same
comparison the stored-version path runs, and returns the redline as a temporary
download link.

None of it becomes a document, a version, or matter content. The rows live in
`file_comparison_uploads`, which is scoped to one member in one organization
and carries no matter reference. Each input is deleted once it has been read,
the redline expires with its download link, and a scheduled sweep clears
whatever a client abandoned: object first, then the row that names it.

## Single registry, derived anonymized projection

There is one curated tool registry (`DEFAULT_MCP_TOOL_DEFINITIONS` in
`static-tool-definitions.ts`, composed from `compat-tools.ts`, `stella-tools.ts`
and `template-tools.ts`). Every `McpToolDefinition` carries a required
`anonymized` policy, a closed discriminated union:

- `{ exposure: "anonymize", textFields, description? }`: available in anonymized
  mode; the listed output text fields are redacted on egress. An optional
  `description` overrides the tool text on the anonymized surface.
- `{ exposure: "passthrough" }`: available as-is (the output carries no
  tenant/personal text, e.g. the shared case-law corpus).
- `{ exposure: "excluded", reason }`: kept off the anonymized surface. `reason`
  is a closed union (`write`, `dynamic_gateway`).

The anonymized tool list and its `stella:*_anonymized` scopes are a pure
projection of this registry (`ANONYMIZED_MCP_TOOL_DEFINITIONS`): excluded tools
are dropped, and every other tool keeps its schema while its scope is remapped
to the paired anonymized scope. Adding a tool without an anonymization decision
is therefore a compile error, and the two surfaces cannot silently diverge.

## Handlers never see the mode; the egress pipeline is central

`McpToolHandler` has no `mode` parameter. A handler returns either a finished
typed internal result or an egress plan (`McpEgressPlan`) carrying the full,
pre-window, un-anonymized payload. `handleMcpToolCall` (in `tools.ts`) runs the
handler and then `finalizeToolEgress` (in `egress.ts`), which, in anonymized
mode, anonymizes the declared text fields on the whole payload, then windows.
Only the outer MCP transport boundary serializes the finished result into a
`CallToolResult`. Anonymize-before-window keeps entity names from splitting
across a window edge and keeps placeholders stable across windows of one
document. With no mode in scope, per-mode divergence inside a handler is
structurally impossible. Tools with compound windowing (e.g.
`read_case_law_decision`) keep that logic tool-local and mode-agnostic.

Most read tools use the generic `{ egress: "structured" }` plan: the handler
builds the whole response object and declares its anonymizable text fields as
`{ workspaceId, value, apply }` descriptors (plus an optional `window` for one
field). Fields are grouped by `workspaceId` and batched into one
`anonymizeTextFields` call per workspace, so placeholders stay consistent across
a payload and multi-tenant payloads (search hits, matter lists) group correctly.
Org-scoped payloads (contacts, templates) use the organization id as the scope.
The OpenAI-compatible `search`/`fetch` tools keep their bespoke
`compatSearch`/`compatFetch` plans (workspaceId stripping, anonymization
metadata).

## One agent-input boundary

First-party calls normalize from the canonical input schema in
`input-normalization.ts` before strict validation and dispatch. The order is
optional-null handling, declared normalization, coercion/defaults, validation,
then the handler. Standard JSON Schema number, boolean, string-enum, and
`format: date` fields supply their own normalization kind;
`x-stella-agent-input` names locale and date-format fields and generates the
same guidance carried into MCP schemas and CLI artifacts. Ambiguous dates and
numbers return field-level `validation_error` clarification instead of being
guessed. Ordinary strings are untouched. A field may declare the narrow
`handler-owned` invalid-value disposition only when its handler already repairs
that property and reports a per-entry issue instead of rejecting valid siblings.

The MCP transport, generic capability path, and chat registry adapters all call
this boundary. Gateway tools from upstream MCP servers keep their upstream
contracts. Confirmation controls (`confirm`, `validate_only`) retain literal
JSON-boolean semantics and are never normalized from strings.

## Structured error envelope

This server is driven almost entirely by AI agents (and the companion CLI), so
every tool error carries a machine-readable code, not just prose. A failed tool
returns a single text content of

```json
{
  "error": { "code": "...", "message": "...", "hint": "...", "retryable": true }
}
```

with `isError` set. `hint` and `retryable` are omitted when absent. Build these
with `structuredErrorResult` (or the `notFoundResult` shorthand) in
`tool-utils.ts`; the arg parsers there already emit `validation_error`. The
`code` set is closed (`error-codes.ts`): `validation_error`, `missing_scope`,
`feature_disabled`, `not_found`, `confirmation_required`, `rate_limited`,
`unknown_tool`, `internal_error`. Agents branch on `code`; `hint` states the
next step (e.g. `missing_scope` tells the client to re-run OAuth consent). The
CLI keys its exit codes off `error.code` (e.g. `feature_disabled` -> exit 5), so
the string values are a stable contract. `internal_error` never leaks internals:
the real exception is captured for observability and the caller gets a generic
message plus the feedback-tool hint.

## Destructive-op confirm guardrail

Every tool with `annotations.destructiveHint === true` (the `delete_*` tools)
advertises a `confirm` boolean (`confirmProp()`) and is refused before dispatch
unless the call sets `confirm: true`. The gate lives in `handleMcpToolCall`,
before any DB access, and returns `confirmation_required`. This stops an agent
from deleting tenant data without an explicit, human-approved confirmation; the
handlers themselves tolerate and ignore the extra `confirm` arg.

## Feedback channel

`prepare_feedback` (`feedback-tools.ts`, scope `stella:feedback`) lets an agent
prepare a sanitized bug, feature request, or docs issue for the public repo. It
is read-only because it publishes nothing; it is excluded from the anonymized
surface and has no backing REST endpoint, so it is waived in the coverage
guard's `TOOLS_WITHOUT_ENUMERABLE_ENDPOINT`.

Title and body are always sanitized server-side by `feedback-sanitize.ts`: a
deterministic set of regex passes redacts emails, ids/UUIDs, JWT/secret blobs,
non-allowlisted URLs (only queryless, fragmentless `github.com/stella/stella`,
`stella.legal`, and `api.stll.app/public/feedback` URLs survive), and IP
literals. Tenant-entity-name anonymization is deliberately not run here: it is
workspace-bound and heavy, and feedback is org-scoped free text. The tool
returns a prefilled `issues/new` URL (label
`agent-feedback`) and an equivalent `gh issue create` command. Nothing is
published until the human opens the URL (or runs the command) and submits
under their own GitHub account, so approval is intrinsic and no server-side
token is needed. An oversized body is truncated in the URL with a
paste-the-rest marker; the full sanitized body is always returned separately.

## Public feedback intake

The separate public, unauthenticated `POST /public/feedback` endpoint
(`handlers/feedback/`) is not a backing endpoint for `prepare_feedback`. It carries
no `mcp` disposition and is mounted outside the auth macro alongside the other
public routes in `index.ts`.

The body is a strict Elysia schema (`kind`, `title` 1..200, `body` 1..8000, an
optional `source` `{ instance?, version? }`; unknown keys and oversize are
rejected). Title and body are re-sanitized here — the caller's pass is never
trusted. Delivery is email-only: the sanitized report is emailed to
`FEEDBACK_EMAIL_TO` when set (`200 { delivered: "email" }`), otherwise the
endpoint refuses with `503 feature_disabled`. Public issues are filed
through `prepare_feedback`, where the human
submits under their own GitHub account, so the intake never holds a GitHub
token. Because it is an unauthenticated public write, it is abuse-bounded in
`intake-guards.ts` (Redis with an in-memory fallback): a per-IP rate limit
(5/hour) and 24h content dedup (a duplicate is rejected `409`, and a claim is
released if delivery fails so a genuine retry is not blocked). All error bodies
reuse the `{ error: { code, message, hint } }` envelope so the forwarding tool
can branch on HTTP status.

## Server instructions

`instructions.ts` supplies the MCP `instructions` string handed to clients at
connect time, per mode. It states the conventions an agent cannot read off the
tool list: pagination (`limit`/`cursor` in, `nextCursor` out), long-text
windowing, the error envelope shape, the confirm guardrail, and where static
resources live. Terse and factual, under hard character budgets asserted in
`instructions.test.ts` (the anonymized variant drops the write-only feedback
tool).

## Code map

- `constants.ts`: resource paths, scopes and discovery URLs.
- `error-codes.ts`: the closed `McpErrorCode` union for the error envelope.
- `instructions.ts`: per-mode server `instructions` strings.
- `tool-types.ts`: `McpToolDefinition`, the `anonymized` policy union, the
  egress-plan and handler types.
- `static-tool-definitions.ts`: the single registry plus the derived default
  list, anonymized projection, and anonymized scope set.
- `stella-tools.ts`: first-party stella tool definitions and handlers.
- `compat-tools.ts`: OpenAI-compatible `search` / `fetch` tools.
- `egress.ts`: the central anonymize-then-window egress pipeline.
- `gateway/`: dynamic gateway for user-managed skills and external MCP tools.
  `gateway/dynamic-tool-policy.ts` holds one policy per dynamic tool family:
  a Stella-owned family (skills) shares one output contract and annotation
  set, a third-party connector family keeps its upstream contract.
- `server.ts` and `server-core.ts`: MCP HTTP transport wiring.
- `../handlers/mcp/routes-core.ts`: Elysia routes that expose the MCP resources.
- `../handlers/mcp-connectors/`: connector management APIs used by the web app.
