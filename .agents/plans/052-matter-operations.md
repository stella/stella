# Plan: Matter Operations

Date: 2026-08-01

## Goal

Turn Stella's existing tasks into a matter-operations system with accountable
ownership, review decisions, contextual discussion, exception queues,
policy-driven recovery, and calendar coexistence.

## Design Decisions

- **Extend existing tasks:** Continue using `entities.kind = "task"` and the
  existing agenda kinds for tasks and deadlines. Add a one-to-one governed-work
  record rather than a competing task store.
- **One accountable owner:** Existing multi-assignees remain collaborators during
  migration. Governed work has exactly one owner with explicit acknowledgement
  and auditable delegation.
- **First-class review records:** A review stores its reviewer, requester, reviewed
  entity/version, due time, decision, and rationale. It is not represented by
  `task.status` or an assignee role.
- **Preserve deadline history:** Store working targets separately from hard
  deadlines. Revisions retain the previous value, source, actor, and reason.
- **Typed transitions:** Shared business logic enforces valid lifecycle changes
  with conditional updates or row locks; workflow state does not accumulate
  boolean flags.
- **Two histories:** Human workflow events form a readable matter timeline;
  compliance mutations also enter the existing append-only audit log.
- **Shared comments, not chat reuse:** Matter-work discussion is workspace-scoped
  and attached to the obligation. Private AI chat threads remain separate.
- **Policy snapshots:** Firm policies are versioned and snapshotted onto active
  obligations so later edits do not silently alter existing deadlines.
- **Durable delivery:** Reminders and escalations use an idempotent transactional
  outbox and bounded scheduler processing.
- **Calendar projection:** Stella remains authoritative. External calendars
  initially receive one-way projections through a provider-neutral boundary.

## Scope

**In scope:**

- Visible Task and Deadline types.
- One accountable owner, acknowledgement, and delegation history.
- Working target and hard deadline with provenance.
- My Work, Needs My Decision, Waiting on Others, and At Risk queues.
- Matter-linked comments and resolvable discussion.
- One reviewer per review step, with approve, request-changes, and reject decisions
  tied to an artifact version.
- Superseding stale approvals after a material document-version change.
- Firm reminder/escalation policies with constrained matter overrides.
- In-app and minimal-content email delivery.
- One-way external calendar projection.
- Auditability, tenant isolation, localization, and RTL behavior.

**Out of scope:**

- Court-rule deadline calculation.
- Sequential, parallel, or quorum approvals.
- Client or other external-party approvals.
- Arbitrary workflow/automation builders.
- AI obligation extraction.
- External-calendar edits automatically changing governed deadlines.

## Implementation

### Phase 1: governed work foundation

- `apps/api/src/db/schema/workflow.ts` and an additive migration: obligations and
  immutable workflow events.
- `apps/api/src/handlers/work-obligations/`: lifecycle transitions, acknowledgement,
  delegation, and cursor-paginated queue handlers.
- Existing task handlers: create or attach governed records without breaking
  legacy tasks or MCP callers.
- Evolve `/todos` into My Work while preserving route compatibility.
- Extend the task inspector with type, owner, acknowledgement, working target,
  hard deadline, and provenance.

### Phase 2: discussion and review

- Add workflow comments and review-request tables and handlers.
- Bind reviews to exact entity-version records and supersede decisions when a
  material later version becomes current.
- Add discussion, review state, decision history, Needs My Decision, and Waiting
  on Others UI.

### Phase 3: policy-driven recovery

- Add versioned organization policies, authorized matter overrides, obligation
  snapshots, and notification-delivery records.
- Add organization workflow-policy settings and a bounded scheduler task for
  reminders, acknowledgement checks, and escalation.
- Add At Risk supervision, including failed delivery and missing acknowledgement.

### Phase 4: calendar coexistence

- Add a provider-neutral calendar projection boundary and projection outbox.
- Add encrypted connections and per-calendar projection records.
- Start with one-way Stella-to-calendar synchronization; treat external edits as
  proposed changes requiring confirmation.

All phases also update MCP task tools so automation cannot bypass workflow rules,
all locale catalogs and terminology, task/calendar queries, cache invalidation,
audit constants, and capability coverage.

## Test Cases

- Valid lifecycle transition matrix and stale-transition rejection.
- Only the accountable owner can acknowledge; acknowledgement is idempotent.
- Delegation preserves previous accountability.
- Owner/reviewer IDs require organization and workspace membership.
- Workspace and ethical-wall isolation for every queue and mutation.
- Cursor ordering remains stable under concurrent inserts.
- Approval applies only to the submitted artifact version; a material new version
  supersedes it.
- Comments and decisions appear in both the readable timeline and audit log.
- Deadline revisions retain source, previous value, actor, and reason.
- Scheduler retry is idempotent and bounded; acknowledgement does not end
  completion escalation, and snoozing does not modify policy eligibility.
- Calendar projection is replay-safe and sync failure cannot alter a deadline.
- UI dates use the central locale and new surfaces work in Arabic RTL.
