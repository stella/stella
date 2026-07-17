# Plan: Maintainability Cleanup Wave

Date: 2026-07-17

## Goal

Reduce change risk in the chat, Template Studio, and template-filling hotspots
without changing product behaviour. Land the work as six independently
reviewable pull requests, preserving vertical-slice ownership and adding a
safety net before each structural extraction.

## Design Decisions

- **Safety nets precede extraction:** Characterization and browser tests land
  before moving high-churn orchestration so failures distinguish behavioural
  regressions from mechanical movement.
- **Keep ownership inside the existing slice:** Chat helpers stay in the chat
  slice, Template Studio interactions stay in the knowledge route slice, and
  reusable template-filling logic becomes a templates-domain service. This is
  not a package or shared-folder reorganization.
- **Extract by side-effect boundary:** File operations, persistence,
  compaction, and external-model preparation get explicit seams. Endpoint files
  retain contracts, permissions, and orchestration.
- **Reduce ratchets through hotspot fixes:** Cross-handler and route-private
  import counts should fall as a consequence of clearer ownership; repository-
  wide mechanical rewrites are out of scope.
- **Observability remains opt-in and data-minimizing:** Remote export is disabled
  unless configured and only accepts explicitly allowlisted structured
  attributes. Legal content, prompts, filenames, tokens, and personal data are
  never exported.

## Scope

**In scope:**

- PR 1: characterize chat send-message failure, rollback, tenant-scope,
  persistence, and usage invariants.
- PR 2: decompose send-message orchestration within the chat slice.
- PR 3: add browser coverage for Template Studio edit, directive insertion,
  save, and reload.
- PR 4: extract Template Studio slash-menu and selection-gesture subsystems
  within the knowledge slice.
- PR 5: move the highest-leverage template-filling helpers out of endpoint
  modules and into templates-domain services.
- PR 6: add an optional privacy-safe production log exporter with correlation
  identifiers and fail-closed attribute filtering.

**Out of scope:**

- Behaviour or UI redesign.
- Billing, plan, or entitlement changes.
- Broad package reorganization or new barrel modules.
- Repository-wide lint-suppression, detached-promise, or large-file cleanup.
- Database schema changes unless a later PR demonstrates an unavoidable
  observability requirement; such a change requires a plan amendment first.

## Implementation

- `apps/api/src/handlers/chat/send-message.ts` — retain the endpoint contract
  and readable turn orchestration; move independently testable preparation,
  file-side-effect, persistence, and compaction responsibilities into adjacent
  chat modules.
- `apps/api/src/handlers/chat/*.test.ts` — add invariants around authorization,
  workspace scope, rollback, idempotent persistence, aborted streams, and
  exactly-once usage accounting at the highest practical layer.
- `apps/web/e2e/specs/` — add a focused Template Studio editor journey using the
  existing Playwright stack.
- `apps/web/src/routes/_protected.knowledge/-components/` — give slash-menu and
  selection-gesture interactions their own state, behaviour, and presentation
  modules without exporting route-private implementation across slices.
- `apps/api/src/handlers/templates/` — place reusable fill behaviour in domain
  service modules so endpoints stop importing helpers from other endpoints.
- `apps/api/src/lib/observability/` — add an optional exporter interface,
  allowlisted record projection, trace/request correlation, configuration, and
  privacy regression tests.
- `scripts/ratchet-baseline.json` — lower affected metrics only after the
  implementation reduces them; never reseed upward.

**DB schema changes:** none planned.

## Test Cases

- An aborted or failed chat turn cannot leave persisted partial messages or
  uploaded objects behind.
- Chat workspace scope is never widened by extraction; deleting workspaces are
  excluded from model and search allowlists.
- Persistence retry and finish callbacks cannot double-write a turn or charge
  usage twice.
- Compaction failure preserves the conversation tail and leaves the turn usable.
- Template Studio supports keyboard and pointer insertion, save, reload, and
  focus restoration after subsystem extraction.
- Template fill endpoints produce byte-for-byte equivalent successful outputs
  and equivalent structured errors after service extraction.
- Remote logs contain correlation and allowlisted operational attributes but
  reject content, prompt, filename, secret, token, and identity fields.
- Each PR passes its focused tests plus `bun run verify`; build and E2E jobs run
  where the changed surface requires them.

## Open Questions

- Which send-message invariants require a handler integration fixture versus a
  smaller extracted state-machine test? Resolve during PR 1 without weakening
  tenant or side-effect coverage.
- Which Template Studio directive best exercises both keyboard interaction and
  persistence without coupling the browser test to incidental presentation?
- Which OTLP-compatible backend will receive production logs? PR 6 keeps the
  exporter provider-neutral unless deployment requirements select one.
