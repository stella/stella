# Plan: MCP Full-Surface Parity

Date: 2026-07-02

## Goal

Make MCP a stable, first-class product surface: every Stella capability is
reachable by users' agents via MCP (or carries an explicit, reviewed waiver),
the default and anonymized MCP surfaces cannot structurally diverge, and tool
quality (agent usability, context cost) is enforced by tests rather than by
discipline.

Current state: 16 static curated tools against roughly 260 workspace/org-scoped
endpoints. Entire domains (entities/documents, fields, tasks, time and billing,
clauses, playbooks, views, uploads, org settings, legislation) have zero MCP
exposure; matters, contacts, templates, search, and case law are read-only
partial. The anonymized surface (`/mcp-anonymized`) is a hand-maintained second
tool list with per-handler `mode` branching.

## Design Decisions

- **Single tool registry; anonymized mode is a derived projection.** Every
  `McpToolDefinition` carries a required `anonymized` policy as a discriminated
  union: `{ exposure: "anonymize", textFields: [...] }`,
  `{ exposure: "passthrough" }` (no tenant text in output), or
  `{ exposure: "excluded", reason: ExclusionReason }` (closed `as const` union,
  no freetext). The anonymized tool list, `stella:*_anonymized` scopes, and
  OAuth resource metadata are all computed from this one registry. The
  hand-written `ANONYMIZED_COMPAT_TOOL_DEFINITIONS` and the static mapping in
  `static-tool-definitions.ts` are deleted. Rationale: adding a tool without an
  anonymization decision becomes a compile error, not a review catch.

- **Handlers cannot see the mode.** `mode` is removed from the
  `McpToolHandler` signature. Handlers return full trimmed objects; the
  dispatch layer applies, in order: anonymize declared text fields, window the
  declared field (`maxChars` moves into the definition), serialize.
  Anonymize-before-window is preserved centrally (entity names must not split
  across window edges, which is why compat `fetch` anonymizes the whole
  document first today). With no mode in scope, per-mode behavioral divergence
  inside a handler is structurally impossible.

- **Required `mcp` disposition on every handler config.** `HandlerConfig` in
  `apps/api/src/lib/api-handlers.ts` gains a required `mcp` field (same
  pattern as the required `permissions`):
  `{ type: "tool", name: McpToolName }` (this endpoint backs tool X;
  name typechecked against the registry),
  `{ type: "covered", by: McpToolName }` (capability reachable through an
  existing tool), `{ type: "internal", reason: InternalReason }` (closed
  union: auth plumbing, presign mechanics, SSE streams, collab/desktop token
  exchange, webhooks, dev-only), or `{ type: "pending" }`. A new endpoint
  without an MCP decision fails typecheck.

- **Ratcheted coverage guard, exact-mirror-guard style.** A CI script imports
  the composed app (the `import.meta.main` boot guard already makes this
  side-effect free), iterates every scoped route's `config.mcp`, and
  cross-checks against the registry and a checked-in baseline of `pending`
  endpoints. The baseline can only shrink; any new `pending` fails CI. It also
  checks the reverse direction: every `type: "tool"` name exists and no
  registry tool is orphaned. Existing gaps do not block; new gaps cannot be
  created.

- **Curated capability granularity, not endpoint mirroring.** Tools stay
  hand-designed at `verb_noun` capability level (an endpoint count of ~260
  must not become 260 tools). OAuth scopes act as progressive disclosure: a
  client consenting only to `stella:templates` sees only template tools.
  Auto-generation from Elysia schemas stays rejected (prior decision: curated
  set, LLM-optimized descriptions, structured errors).

- **Quality is enforced deterministically in CI.** Tests over the registry:
  total `tools/list` token budget per mode and per scope set, per-tool
  description token ceiling, every input param described, every list tool has
  `limit` + `cursor`, `verb_noun` naming, and a serialized snapshot of the
  tool list per mode so surface changes are visible diffs. No
  model-in-the-loop eval harness; tool ergonomics are judged in review, with
  the snapshots making every surface change explicit.

## Scope

**In scope:**

- Registry/type refactor in `apps/api/src/mcp/` (single registry, anonymized
  projection, centralized egress pipeline).
- `HandlerConfig.mcp` field, the closed reason unions, and annotation of all
  existing endpoint modules (bulk `pending` plus obvious `internal`/`covered`).
- Coverage guard script + baseline, wired into `bun run verify` and CI.
- Deterministic registry-quality test suite and tool-list snapshots.
- Phase-2 tool buildout, domain by domain, shrinking the baseline: entities
  (read, then create/move/rename), tasks, time and billing, clauses,
  playbooks, views, contacts writes, matter writes, org settings.

**Out of scope:**

- Model-in-the-loop eval harness (decided against; deterministic budgets and
  snapshot review only).
- Deanonymization of caller input on the anonymized surface (writes stay
  excluded there; only the chat agent does the round-trip).
- Auto-generating tools from route schemas.
- Frontend changes (MCP is a backend surface; connector management UI exists).
- DB schema changes (none needed).

## Implementation

- `apps/api/src/mcp/tool-types.ts` — `McpToolDefinition` gains required
  `anonymized` policy and optional `window` declaration; `McpToolHandler`
  loses `mode`.
- `apps/api/src/mcp/static-tool-definitions.ts` — becomes a pure derivation
  (default list, anonymized projection, scope map) from the single registry.
- `apps/api/src/mcp/compat-tools.ts`, `stella-tools.ts`, `template-tools.ts` —
  move mode branches and windowing out of handlers; declare policies.
- `apps/api/src/mcp/tools.ts` (`handleMcpToolCall`) — central egress pipeline:
  anonymize declared fields, window, serialize; scope checks unchanged.
- `apps/api/src/lib/api-handlers.ts` — `HandlerConfig.mcp` (required) plus the
  `McpExposure` / `InternalReason` unions; endpoint modules across
  `apps/api/src/handlers/**` annotated.
- `apps/api/scripts/mcp-coverage-guard.ts` + `apps/api/mcp-coverage-baseline.json`
  — ratchet guard, wired next to `exact-mirror-guard.ts` in
  `.github/workflows/ci.yml` and `bun run verify`.
- `apps/api/src/mcp/registry-quality.test.ts` — budgets, naming, pagination,
  param descriptions, per-mode snapshots.

## Security Implications

- Write tools inherit the existing permission model: each backing handler
  already declares `permissions`; MCP dispatch runs the same checks, and
  workspace isolation stays derived from token org membership
  (`resolveAccessibleWorkspaces`), never from caller-supplied IDs.
- Destructive tools carry MCP `destructiveHint`/`readOnlyHint` annotations.
- Audit events: every mutating MCP tool call must record audit events through
  the existing recorders (the `require-audit-on-mutation` rule applies to the
  backing handlers).
- Anonymized surface remains egress-only; mode-specific OAuth audiences
  already prevent token replay across surfaces.

## Test Cases

- Registry invariants: every tool has an anonymized policy; anonymized
  projection equals (registry minus excluded); no orphan scopes.
- Egress pipeline: declared text fields anonymized before windowing; window
  cursors stable across anonymized/default modes; placeholder stability across
  windows of the same document.
- Coverage guard: new endpoint without `mcp` fails typecheck; new `pending`
  fails CI; baseline shrink passes; `type: "tool"` with unknown name fails.
- Budgets: `tools/list` payload under budget per mode; description ceiling;
  list tools paginated; snapshot diffs reviewed.

## Resolved Decisions

1. **Write scope**: full parity including destructive ops, gated by the
   existing permission model and annotated with `destructiveHint`.
2. **Permanent `internal` waivers**: account deletion, hosted billing
   management, and mechanical plumbing (SSE streams, presign mechanics,
   collab/desktop token exchange, webhooks, dev-only). Member/org
   administration and skills management do get tools.
3. **Anonymized mode**: grows to the full read surface via the central egress
   pipeline; writes stay excluded there.
4. **No eval harness**: quality enforcement is deterministic CI only.
