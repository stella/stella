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
- `/mcp-law`: the public legal corpus. Exactly eleven read tools (`search`,
  `fetch`, `search_case_law`, `lookup_case_law`, `read_case_law_decision`,
  `read_case_law_citations`, `case_law_coverage`, `search_legislation`, `read_statute`,
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
structurally impossible. Tools that page by number (e.g.
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
`code` set is closed and defined in [`error-codes.ts`](./error-codes.ts).
Verification active and daily run limits preserve their distinct codes from
`@stll/api-contract/verification-run-caps`. Agents branch on `code`; `hint` states the
next step (e.g. `missing_scope` tells the client to re-run OAuth consent). The
CLI keys its exit codes off `error.code` (e.g. `feature_disabled` -> exit 5), so
the string values are a stable contract. `internal_error` never leaks internals:
the real exception is captured for observability and the caller gets a generic
message plus the feedback-tool hint.

## Reauthorization

A connected client should almost never need a manual reconnect. Grants carry
`offline_access`, so a client refreshes its access token (15 minutes) with the
refresh token (30 days, rotated on use) without the user, and a refresh grant
survives the browser session that created it. When the user must act, the
server says so in the form each host acts on:

- **Missing, expired or revoked token:** the transport answers HTTP 401 with
  `WWW-Authenticate: Bearer error="invalid_token", ..., resource_metadata="<protected-resource metadata URL>"`
  (no `error` when no credential was sent). Hosts refresh or rerun OAuth from
  this; it is the only signal Claude acts on.
- **Valid token without a scope the call needs:** the tool returns the
  `missing_scope` envelope (`isError`), and `tool-auth-challenge.ts` adds
  `_meta["mcp/www_authenticate"]` with an `insufficient_scope` challenge naming
  the same metadata. ChatGPT and Codex read it and offer to reconnect in place;
  hosts that ignore `_meta` still show the envelope's `hint`.

Per host (verify again when a host changes its client):

| Host | Expired access token | Dead refresh token | Missing scope on a call |
| --- | --- | --- | --- |
| ChatGPT | Refreshes | 401 challenge, reconnect prompt | `_meta` challenge, inline reconnect |
| Codex | Refreshes | 401 challenge, reconnect prompt | `_meta` challenge, inline reconnect |
| Claude | Refreshes on 401 and before expiry | 401 challenge, OAuth rerun | Envelope `hint` only (Claude acts on transport 401/403, not `_meta`) |

## Destructive-op confirm guardrail

`annotations.destructiveHint` tells clients that a tool can change existing
stored data, including updates and deletions. It does not require a server
confirmation gate: reversible updates may declare the hint without a
`destructiveBehavior` or a `confirm` input.

`destructiveBehavior` declares the server confirmation policy. The `always`
behavior (used by the `delete_*` tools) requires `confirm: true` on every call;
`input-discriminator` requires it only for the declared actions. These tools
advertise a `confirm` boolean (`confirmProp()`). The gate in
`handleMcpToolCall` returns `confirmation_required` before dispatch when
confirmation is required and absent. Catalog-dispatched capabilities resolve
their confirmation policy from the selected target; upstream servers own their
operation-specific confirmation protocol.

## Feedback pipeline

Two tools, one service. `prepare_feedback` (read-only) sanitizes a draft report
and returns it; `submit_feedback` (write) files the same object once a human has
approved it. The split exists because the human approval is the real control on
what leaves the workspace: `prepare_feedback` returns the report in exactly the
shape `submit_feedback` accepts, so the approved bytes and the sent bytes are the
same bytes (`feedback-tools.test.ts` pins that round trip). Both carry scope
`stella:feedback`, are excluded from the anonymized surface, and are not
projected into the in-app chat, which has its own feedback UI.

`submit_feedback` declares `destructiveBehavior: { type: "outbound" }`. It
deletes nothing, so `destructiveHint` stays false, but the transport gate in
`tools.ts` refuses it without `confirm: true` exactly as it refuses a delete, and
the refusal says what is about to be sent. The generated CLI leaf gets the same
`--yes` pre-approval a destructive leaf gets.

`stella://reference/feedback-workflow` (`feedback-workflow-reference.ts`) is the
agent-facing procedure: when a report is worth filing, what it must never
contain, the field-by-field schema rendered from `FEEDBACK_LIMITS`, and the three
steps. It is served on the default and documents surfaces only.

Every field is sanitized by `feedback-sanitize.ts`: a deterministic set of regex
passes redacts emails, UUIDs and ULIDs, JWT/secret blobs, non-allowlisted URLs
(only queryless, fragmentless `github.com/stella/stella`, `stella.legal`, and
`api.stll.app/public/feedback` URLs survive), and IP literals. `context.requestId`
is the one field that is not sanitized: it is validated against
`[A-Za-z0-9._-]{1,64}` and stored verbatim, because it is the key a maintainer
correlates with server logs and the secret passes would otherwise eat it.
Tenant-entity-name anonymization is deliberately not run here: it is
workspace-bound and heavy, and feedback is org-scoped free text.

## Where a report goes

`handlers/feedback/submit.ts` is the one service behind every entry point. It
sanitizes, fingerprints the sanitized content, looks that fingerprint up among
reports filed in the last day (a match answers with the original receipt and
delivers nothing), stores the row, then delivers outside the transaction.

Storage is `feedback_reports`, a system table: RLS is enabled with no policy and
the migration revokes every privilege from `stella`, so the request role can
neither read a report nor file one under another reporter's identity. All access
goes through `lib/db/feedback-report-store.ts`, which writes the row and its audit
event in one transaction.

Delivery is per configured channel. Email goes to `FEEDBACK_EMAIL_TO` when the
transactional transport is configured. A GitHub issue is filed when
`FEEDBACK_GITHUB_TOKEN` and `FEEDBACK_GITHUB_REPO` are both set; that issue body
carries the sanitized report, the receipt, the context and the server version,
and never any reporter identity. A failed channel is captured and recorded as
`failed` on the row; the reporter still gets their receipt. With no channel
configured the report is stored and the response carries a warning naming the two
settings, so a self-host degrades to a local record instead of refusing.

Every submission emits one `feedback_report_submitted` analytics event carrying
kind, area, entry point, redaction count and per-channel outcome. No content.

## HTTP entry points

`POST /v1/feedback` is the authenticated route the web and desktop apps use
(`handlers/feedback/create.ts`), rate-limited to 10 reports per user per hour. It
is mounted at the root like `/v1/notifications` for the Eden type-complexity
reason documented there.

`POST /public/feedback` is the public, unauthenticated intake
(`handlers/feedback/intake.ts`), for a caller with no Stella account. Its body is
the same report plus an optional `instance`, parsed from the raw string by a
Valibot `strictObject` (Elysia's normalizer would strip unknown keys before a
typed schema could reject them). Identity is not its protection: a per-IP rate
limit of 5 per hour in `intake-guards.ts` is, plus the service's own
sanitization and fingerprint dedup. All error bodies reuse the
`{ error: { code, message, hint } }` envelope so a forwarding tool can branch on
HTTP status.

`submit_feedback` is additionally bounded per organization at 20 reports an hour,
on the same counter primitive.

## Server instructions

`instructions.ts` supplies the MCP `instructions` string handed to clients at
connect time, per mode. It states the conventions an agent cannot read off the
tool list: pagination (`limit`/`cursor` in, `nextCursor` out), long-text
windowing, the error envelope shape, the confirm guardrail, and where static
resources live. Terse and factual, under hard character budgets asserted in
`instructions.test.ts` (the anonymized and law variants drop the feedback
pointer, because neither surface carries the tools).

## Surface size

`apps/api/mcp-surface-baseline.json` holds one row per tool and audience (the
UTF-16 length of the tool's title, description, input schema, output schema
and annotations, and its UTF-8 size in `tools/list`) and each audience's
instructions length. It stores no totals: the tool count, the per-part sums,
the size of the `tools/list` array, and the largest description, input schema
and output schema are derived from the rows, so changes to different tools
touch different lines. It measures the unfiltered static first-party registry,
an upper bound for the first-party tools any session is served; the skill and
connector tools the gateway adds per organization are not included.
`registry-quality.test.ts` fails when a derived total moves past its tolerance
in either direction or the set of tools changes. From `apps/api`,
`bun run mcp:surface-baseline --write` rewrites the file, so a pull request
that grows a surface shows the rows it moved; `--check` also rejects a file
that is not in its sorted one-row-per-line format.
Without a flag the script prints the parts and three views built from them:

- anthropic: name + description + input schema;
- deferred upfront: names + instructions;
- codex upper bound: instructions x tool count + description + input schema +
  output schema (Codex renders output schemas shorter than their JSON).

Which parts reach the model depends on the host. Observed on 2026-09-26 by
capturing the requests each host sent to its model API; these are
observations of those versions, not protocol guarantees:

| Part               | Claude Code 2.1.283             | Codex CLI 0.157.1, code mode                          | Codex CLI 0.157.1, function tools    |
| ------------------ | ------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| name               | sent                            | on discovery                                          | on discovery                         |
| description        | sent                            | on discovery, prefixed with the instructions          | on discovery                         |
| input schema       | sent                            | on discovery, as a TypeScript declaration             | on discovery                         |
| output schema      | not sent                        | on discovery, as a TypeScript return type             | not sent                             |
| title, annotations | not sent                        | not sent                                              | not sent                             |
| instructions       | once, in the first user message | prefixed to every tool description                    | once, in the tool-search description |
| call result        | `structuredContent` JSON only   | the script receives `content` and `structuredContent` | `structuredContent` JSON only        |

Claude Code sends every tool upfront or, when the definitions are large, only
the names (and instructions) and loads a definition when a tool is searched
for. Codex always defers MCP tools behind discovery.

`scripts/mcp-surface-token-calibration.ts` measures the chars-per-token ratios
behind the estimates with the Anthropic count_tokens endpoint; it needs
`ANTHROPIC_API_KEY` and is run by hand, never in CI.

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

## Output projection contracts

Bind successful payloads with `projectionPayload(schema, payload)` from
`lib/projection-totality.ts` before a handler return annotation widens their
source types. It checks undeclared fields recursively, including forwarded
objects, arrays, unions and spreads. A domain field must be declared in the
strict schema or explicitly removed when constructing the payload. Open JSON
fields remain explicit schema decisions. Dispatch still strict-parses the
served result; the compile-time gate does not replace runtime validation.

The `weak-mcp-projection-ties` ratchet prevents new satisfies-only projection
ties. `contracts/mcp-output-projection.ts` exercises producer-field drift and
binds the case-law facet tree to its source type. The case-law source-facet
database tests feed real SQL output through the production count builder and
the MCP projection, covering exact counts, lower bounds and unknown-field
rejection.
