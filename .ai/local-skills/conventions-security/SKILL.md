---
name: conventions-security
description: "Apply when writing code that touches auth, data access, file handling, or external APIs. Stella handles privileged legal data (attorney-client privilege, litigation holds, personal data)."
---

# Security Conventions

Apply when writing code that touches auth, data access, file
handling, or external APIs. Stella handles privileged legal data
(attorney-client privilege, litigation holds, personal data).

## SOC 2 / ISO 27001 Principles

- **Least privilege** — minimum permissions needed. No wildcard
  IAM policies, no admin-by-default.
- **Audit trail** — state-changing operations traceable to an
  actor and timestamp. Never silently mutate data.
- **Encryption in transit and at rest** — TLS everywhere, S3 SSE,
  no plaintext secrets in code or logs.
- **Input validation at boundaries** — all external input
  validated and sanitised before processing.
- **Workspace isolation** — data from one workspace must never
  leak to another.
- **Matter visibility** — enforce the matter's explicit visibility at the RLS
  layer, independently of its client. `assigned_only` requires assignment for
  everyone, including organization owners and admins. `admins_and_assigned`
  admits owners, admins, and assigned members. `all_members` admits every
  internal organization member; external users still require assignment.
  Organization roles continue to determine permissions within an accessible
  matter. Attaching or changing a client does not change visibility.
- **Access control** — every endpoint enforces auth and
  authorisation. No "internal-only" endpoints without guards.
- **Dependency hygiene** — minimal, pinned, audited.
- **Logging without leaking** — never log secrets, tokens, PII,
  or document contents.
- **Change management** — all changes go through PR review. No
  direct commits to main.
- **Data retention** — when data is deleted, it is actually
  deleted (not soft-deleted indefinitely).

## Structural Guardrails

Prefer solutions that make security bugs **structurally impossible**
(compile-time, lint-time) over ones that rely on developer discipline.

### Authorized database boundary

Workspace-scoped handlers use `createSafeHandler`, declare permissions beside
the route, derive `workspaceId: SafeId<"workspace">` from the authorized
context, and access tenant data through `scopedDb`. Never accept ownership IDs
from body/query input or fall back to root `db` because a relation is awkward
to express. Root/system handlers require a documented non-tenant purpose and
tables whose RLS posture denies ordinary application access. Enforced by
`require-safe-route-handlers/require-safe-route-handlers` and
`no-body-ownership-ids/no-body-ownership-ids`.

When an identifier comes from a related row, authorize it in the same query or
transaction that uses it. A prior UI filter, cache lookup, or separate
read-then-write check is not an access-control boundary.

### Matter visibility and stewardship

Use `apps/api/src/lib/workspaces/visibility.ts` as the application owner of
visibility predicates and steward checks. Creation defaults belong to
`defaultMatterVisibilityFor` in `@stll/api-contract`, shared by the API and web
client. Read authorized matter sets
through `apps/api/src/lib/workspaces/authorized-workspace-ids.ts`; do not
recreate the rule in individual readers.

An `assigned_only` matter needs a usable lead: an internal organization member
assigned to that matter. Preserve this invariant when changing visibility,
lead, matter membership, or organization membership and role. The database
refuses writes that leave such a matter without a usable lead; application
checks provide the actionable error before that constraint is reached.
Never widen matter visibility automatically during offboarding, assignment
removal, role changes, account deletion, or migration repair. Refuse the
operation until an authorized person explicitly hands the matter to another
assigned internal member. Refusal responses list only affected matters the
caller already reaches; hidden matter names, identifiers and counts stay hidden.

Acquire stewardship locks through `lockMatterStewardship` in
`lib/db/aggregate-lock.ts`: lifecycle IDs, all candidate membership rows by
member ID, then matter rows by ID. Pass all organizations and matters in one
request before acquiring any part of that prefix. Revalidate after acquisition;
retry the whole transaction if discovery grows. Never extend a prefix below an
already locked matter or upgrade a shared reach hold into a writer.
Database triggers validate the completed prefix and steward state without
acquiring further locks. Completion proofs are root-owned; mutable session
settings cannot authorize a mutation. Reach holds, creation, recovery, repair, membership
changes and deletion use this same protocol. Creation uses
`create-workspace-row.ts`: scoped creators call `createWorkspaceInTransaction`;
system seeds and fixtures use `insertWorkspaceRowsInTransaction` or its
`withWorkspaceCreation` boundary. That owner acquires the complete batch
prefix before inserting, including generated IDs and future assignees.
`no-unowned-workspace-insert` rejects private or unresolved inserts outside
the owner; historical fixtures must prove their schema predates visibility.
After a mutation acquires its prefix, re-read reach and current authority
through `readMatterMutationAuthority` before acting on an earlier authorized
matter ID. Refuse lost reach with the same not-found response as a missing
matter. Multi-phase copies re-read every copied matter-row field and its
assignments under the prefix, using the same projection as the snapshot.
Refuse changed snapshots before inserting a copy and clean up staged files.
Recovery cannot assign its acting
administrator; hidden healthy, missing and foreign-organization matters produce
the same not-found response.

### Server-bound audit events

Actors, workspace/organization ownership, request metadata, and before/after
identifiers come from authenticated server context. Clients may supply a user
action or reason where the domain requires it, but never the authoritative
actor or tenant. Required audit writes participate in the same transaction as
the mutation, or use a durable outbox when the sink is external. Enforced by
`require-audit-on-mutation/require-audit-on-mutation`.

### Workspace status filtering

`resolveAccessibleWorkspaces` returns **all** workspaces (including
`deleting`). The auth macro exposes two fields:

- `activeWorkspaceIds` — excludes `deleting` workspaces (includes
  active and archived). Use this for search, chat, MCP, and any
  query that builds a workspace allowlist. This is the default;
  reach for it first.
- `accessibleWorkspaces` — includes all statuses. Only use in
  `workspaceAccessMacro` (which needs the status to return
  appropriate HTTP codes). Never pass these IDs as a search/query
  allowlist.

If you need workspace IDs for a new feature, use `activeWorkspaceIds`
unless you have an explicit reason to include deleting workspaces
and document that reason in a comment.

### CSV and file exports

Use `escapeCSV` from `@/api/lib/csv` for all CSV cell values. Never
hand-roll CSV escaping; the shared utility handles both delimiter
quoting and spreadsheet formula neutralization (=, +, -, @, tab, CR
prefixes). This prevents CSV injection attacks where user-controlled
values starting with formula characters execute in Excel/LibreOffice.

### Multi-entry-point validation

Validate untrusted input at each entry boundary with the owning shared schema.
Generated MCP capabilities validate the live endpoint's body, params, and query
schemas in `apps/api/src/mcp/capability-tools.ts`; do not repeat that parsing
inside the handler. Native MCP tools and chat registry tools normalize input
through `normalizeObjectInputAtBoundary` before dispatch; any other caller that
bypasses the HTTP route (cron jobs, workers) must apply the same normalizer and
schema before calling the operation. Keep business invariants and
related-resource authorization in the owning operation: an ID's valid shape
does not establish its ownership.

### Filename sanitization

All user-supplied filenames must pass through `sanitizeFilename`
(`@/api/lib/sanitize-filename`) before storage or use in file
operations (ZIP entries, Content-Disposition headers, S3 keys).
The sanitizer strips path separators, traversal sequences, and
dangerous characters. Enforced by
`security-guards/no-raw-filename-write`.

### Cross-org user ID validation

When a handler accepts a `userId` from user input (body, query, or
params) and uses it in a query that returns user data (names, emails,
images), validate org membership first using `validateOrgUserId` from
`@/api/lib/validated-org-user-id`. The returned `ValidatedOrgUserId`
proves the check happened at the type level, making cross-org user ID
injection structurally impossible. For read paths that resolve
userIds stored in the database (not from user input), scope the user
query with an `innerJoin` on the `member` table filtered by
`session.activeOrganizationId`; enforced by
`security-guards/no-unscoped-user-query`.

### CI workflow permissions

GitHub Actions workflows must declare the **minimum** permissions
needed. Never use `permissions: write-all`. For PR-triggered
workflows, scope to `contents: read` + `pull-requests: write`.
Pin third-party actions to commit SHAs, not mutable tags. For
SBOM/provenance, use the shared `stella/.github` reusable
workflows which handle pinning, checksums, and PR-based updates.
