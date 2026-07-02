<p align="center">
  <img src=".github/assets/banner.png" alt="stll/mcp" width="100%" />
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

The server exposes two MCP resources:

- `/mcp`: the default stella MCP. It includes first-party stella tools,
  OpenAI-compatible `search` / `fetch` tools, user-managed skills, and enabled
  external MCP connectors.
- `/mcp-anonymized`: the anonymized MCP mode. It exposes anonymized search and
  read tools for clients that should receive anonymized results.

OAuth protected-resource discovery is served from:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-protected-resource/mcp-anonymized`

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
  is a closed union (`write`, `pending_projection`, `dynamic_gateway`).

The anonymized tool list and its `stella:*_anonymized` scopes are a pure
projection of this registry (`ANONYMIZED_MCP_TOOL_DEFINITIONS`): excluded tools
are dropped, and every other tool keeps its schema while its scope is remapped
to the paired anonymized scope. Adding a tool without an anonymization decision
is therefore a compile error, and the two surfaces cannot silently diverge.

## Handlers never see the mode; the egress pipeline is central

`McpToolHandler` has no `mode` parameter. A handler returns either a finished
`CallToolResult` or an egress plan (`McpEgressPlan`) carrying the full,
pre-window, un-anonymized payload. `handleMcpToolCall` (in `tools.ts`) runs the
handler and then `finalizeMcpEgress` (in `egress.ts`), which, in anonymized
mode, anonymizes the declared text fields on the whole payload, THEN windows,
THEN serializes. Anonymize-before-window keeps entity names from splitting
across a window edge and keeps placeholders stable across windows of one
document. With no mode in scope, per-mode divergence inside a handler is
structurally impossible. Tools with compound windowing (e.g.
`read_case_law_decision`) keep that logic tool-local and mode-agnostic.

## Code map

- `constants.ts`: resource paths, scopes and discovery URLs.
- `tool-types.ts`: `McpToolDefinition`, the `anonymized` policy union, the
  egress-plan and handler types.
- `static-tool-definitions.ts`: the single registry plus the derived default
  list, anonymized projection, and anonymized scope set.
- `stella-tools.ts`: first-party stella tool definitions and handlers.
- `compat-tools.ts`: OpenAI-compatible `search` / `fetch` tools.
- `egress.ts`: the central anonymize-then-window egress pipeline.
- `gateway/`: dynamic gateway for user-managed skills and external MCP tools.
- `server.ts` and `server-core.ts`: MCP HTTP transport wiring.
- `../handlers/mcp/routes-core.ts`: Elysia routes that expose the MCP resources.
- `../handlers/mcp-connectors/`: connector management APIs used by the web app.
