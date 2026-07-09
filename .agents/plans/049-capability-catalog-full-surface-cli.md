# Plan: Capability Catalog and Full-Surface CLI

Date: 2026-07-09

## Goal

Make "everything in Stella is controlled by user or agent alike" structurally
true on the automation surfaces. Every safe handler is either an invokable
capability or carries an explicit, reviewed waiver; the CLI reaches the full
capability surface; MCP keeps its small curated tool list (agent context
budget); and drift between CLI, MCP, and chat stays structurally impossible
because all three remain generated projections of one registry.

Current state: 41 curated static tools against ~315 safe handlers. Every
handler already carries an `mcp` disposition (`tool | covered | internal`;
the `pending` baseline is empty), so the full surface is *accounted for*, but
`covered` means "reachable through a consolidated tool, lossily" and the CLI
inherits the 41-tool list — a ceiling that exists for LLM context budgets, a
constraint that does not apply to a CLI. The tool-count/payload ceilings in
`registry-quality.test.ts` and the CLI trust boundary are deliberate ratchets;
this plan keeps them and routes the long tail around them instead of raising
them wholesale.

## Design Decisions

- **Capability universe = the safe-handler enumeration.** The coverage guard
  (`apps/api/scripts/mcp-coverage-guard.ts`) already enumerates every
  `createSafe*Handler` export and forces an `mcp` disposition on each. A
  capability is any handler whose disposition is `tool` or `covered`;
  `internal` stays a waiver. No new annotation burden on handler authors:
  catalog membership is derived from the disposition that already exists.
  Capability IDs are derived from handler paths
  (`handlers/time-entries/create.ts` → `time-entries.create`), stable and
  collision-checked by a drift guard.

- **Catalog entries are projections of handler configs, not hand-written.**
  Handler configs hold TypeBox schemas (`body`/`params`/`query`), which are
  JSON Schema objects at runtime, plus `permissions`. A dev-only export script
  (same pattern as `export-mcp-tool-registry.ts`) emits
  `capability-catalog.json`: id, description, input JSON Schema, required
  permissions, scope, `access: read | write`, destructive flag, handler scope
  kind (workspace/root/session). `access`/destructive are derived from the
  `permissions` action verbs (create/update/delete/manage → write; delete →
  destructive) with a small explicit override table in the export script,
  drift-guarded so a new unclassifiable verb fails CI rather than defaulting.

- **The long tail is reached through three curated meta-tools, not 315
  advertised tools.** New static tools `list_capabilities` (paginated,
  filterable by domain/access), `describe_capability` (full schema +
  metadata), and `invoke_capability` (`{ capability, input, validateOnly?,
  confirm? }`). Static tool count goes 41 → 44, inside the 45 hard ceiling.
  The advertised `tools/list` payload stays small; agents discover the long
  tail on demand. All three are `excluded` on the anonymized surface (the
  generic path cannot prove egress safety per-capability; the anonymized
  surface keeps its curated read-only projection).

- **Generic invoke reuses the safe-handler wrapper; it does not reimplement
  gates.** A generated static dispatch module in `apps/api` (same pattern as
  `static-tool-definitions.ts`) maps capability ID → handler module default
  export. `invoke_capability` synthesizes the handler context from
  `McpRequestContext` (which already carries `safeDb`/`scopedDb`,
  `memberRole`, `accessibleWorkspaceIds`, and the audit recorder), resolves
  the workspace like existing tools do (`ensureActiveWorkspace` +
  `bindWorkspaceRecorder`), and calls the `{ config, handler }` export — so
  permission checks and usage preflight run in the same code path REST uses.
  This replaces today's per-tool bespoke bridging for the long tail. The
  central destructive-confirm gate applies from capability metadata
  (`confirmation_required` without `confirm: true`), and per-capability scope
  requirements are enforced before dispatch. A drift-guard test asserts the
  dispatch module exactly matches the coverage-guard enumeration, so a new
  handler cannot land without becoming invokable or waived.

- **`validateOnly` and structured validation issues.** `invoke_capability`
  with `validateOnly: true` runs input validation (compiled TypeBox
  validators) and returns issues without executing. The error envelope grows
  an optional `issues: [{ path, message }]` field on `validation_error`, and
  all tool argument-validation failures are routed through
  `structuredErrorResult` (today Valibot issues are collapsed to one string
  and emitted through the legacy code-less `errorResult`). Agents get
  machine-actionable feedback on every surface; the CLI renders issues and
  keeps exit code 2.

- **CLI generates its full command tree from the catalog snapshot.** The
  catalog is snapshotted into `packages/cli/src/generated/` beside the tool
  registry snapshot (the CLI still never imports `apps/api`). Codegen reuses
  `generateRouteMap`: curated tools keep their first-class annotated commands;
  catalog capabilities get heuristically named commands merged into the same
  tree, with curated commands winning collisions deterministically, and the
  leaf executor calling `invoke_capability` over the same MCP transport.
  The runtime trust boundary gets a catalog-shaped validator with fail-closed
  caps (the existing `MAX_TOOLS = 200` stays for `tools/list`; the catalog
  path gets its own byte/depth/count caps). An older CLI can still reach a
  newer server's capabilities through describe/invoke without a reinstall.

- **Agent-grade CLI output contract, test-enforced.** stdout carries results,
  stderr carries diagnostics/progress; `--no-input` never prompts (fails
  closed where `--yes` or flags are missing); `--all` streams JSONL with the
  existing page/byte bounds; `--output json` remains stable. These are tests
  in `packages/cli`, not documentation promises.

- **Receipts.** A request ID is introduced into the API request context and
  returned in both the error envelope and mutation success payloads
  (`meta.requestId`), so agents can reference a specific server-side action.
  Surfacing per-row audit IDs is deferred until a concrete consumer exists.

## Rejected Alternatives

- **Raw REST passthrough (`stella api <method> <path>`).** Bypasses the
  confirm/egress/envelope gates, would freeze internal HTTP shapes into a
  public contract, and CLI OAuth tokens are only valid at the MCP gateway.
- **Advertising the full catalog on `tools/list`.** Breaks every deliberate
  context-budget ratchet (tool-count, payload chars, client trust caps).
- **Per-capability versioning / deprecation / compatibility negotiation.**
  Pre-launch there are no third-party clients to migrate; the snapshot
  version plus the `x-stella-cli-latest` nudge suffice. Revisit on real
  external adoption.
- **Idempotency keys and signed plan/apply tokens as blanket requirements.**
  Deferred; the HMAC confirmation-token pattern (`feedback-token.ts`) is
  available when a bulk-destructive capability warrants it.
- **Model-in-the-loop eval harness.** Standing decision: deterministic CI
  guards only.

## Phases

1. **Catalog foundation (api-only, no surface change).** Capability ID
  scheme + export script + `capability-catalog.json` + drift guard wired into
  `bun run verify`/CI; envelope `issues[]` + `validation_error` unification.
2. **Server meta-tools.** Generated dispatch module; `list_capabilities`,
  `describe_capability`, `invoke_capability` with scope/permission/confirm/
  `validateOnly` gates; ceilings 41 → 44; registry-quality and coverage-guard
  extensions; tests.
3. **CLI full surface.** Catalog snapshot + codegen merge into the command
  tree; leaf executor via `invoke_capability`; trust-boundary catalog
  validator; output-contract tests (`--no-input`, JSONL, stdout/stderr);
  skill regeneration.
4. **Receipts and docs.** Request ID in request context + envelope/success
  meta; generated capability-coverage table in docs.

## Open Decisions

- **Scope mapping for long-tail writes.** Reuse the existing per-domain
  write scopes for capabilities in those domains (no new consent labels), or
  add a dedicated scope for generic invoke? Default in this plan: reuse
  domain scopes; a capability outside every scoped domain fails the drift
  guard until mapped.
- **Admin-gated capabilities via generic invoke from day one?** Default:
  yes, behind `stella:admin_write` + member-role permission, since the safe
  wrapper enforces both; flag if a narrower rollout is preferred.
- **Covered-capability suppression in the CLI tree.** When a curated command
  already covers a handler, default is to still expose the capability command
  (it may accept parameters the consolidated tool flattened) unless its
  annotation says suppress.
