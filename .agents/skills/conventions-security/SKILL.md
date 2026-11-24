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
  IAM policies, no admin-by-default. [review]
- **Encryption in transit and at rest** — TLS everywhere, S3 SSE,
  no plaintext secrets in code or logs. [review]
- **Input validation at boundaries** — all external input
  validated and sanitised before processing. [review]
- **Workspace isolation** — data from one workspace must never
  leak to another.
  [test: apps/api/src/tests/security/cross-tenant-handlers.test.ts]
- **Ethical walls** — workspace (matter) boundaries enforce
  information barriers at the RLS layer (not just the UI). Each
  matter's `visibility` decides who reaches it without a
  `workspace_members` assignment: `all_members` (every internal
  member), `admins_and_assigned` (org owners and admins) or
  `assigned_only` (nobody, owners and admins included). External
  members reach a matter only through an assignment. Anyone not
  reached has zero visibility: no names, no members, no metadata.
  The rule lives once in `stella_authorized_workspace_ids`, which
  the RLS view (`stella_authorized_workspaces`) calls; a matter
  without a stored visibility follows its client (admins with a
  client, assigned members without). An assigned-only matter
  always keeps an assigned internal member (database triggers
  refuse every change that would lose the last one). Organization
  roles still decide what a member may do inside a matter.
  [test: apps/api/src/lib/workspaces/matter-visibility.postgres.test.ts]
- **Access control** — every endpoint enforces auth and
  authorisation. No "internal-only" endpoints without guards.
  [test: apps/api/src/tests/security/route-auth-invariants.test.ts]
- **Dependency hygiene** — minimal, pinned, audited.
  [check: scripts/dependency-audit.ts]
- **Change management** — all changes go through PR review. No
  direct commits to main.
  [check: .github/workflows/audit-branch-protection.yml]
- **Data retention** — when data is deleted, it is actually
  deleted (not soft-deleted indefinitely). [review]

## Structural Guardrails

Prefer solutions that make security bugs **structurally impossible**
(compile-time, lint-time) over ones that rely on developer discipline.

### Authorized database boundary

- When an identifier comes from a related row, authorize it in the same query or
  transaction that uses it. A prior UI filter, cache lookup, or separate
  read-then-write check is not an access-control boundary.
  [review]

### Server-bound audit events

- Audit actors, workspace and organization ownership, request metadata, and
  before/after identifiers come from authenticated server context; a client
  may supply an action or reason, never the actor or tenant. [review]

### Workspace status filtering

`resolveAccessibleWorkspaces` returns **all** workspaces (including
`deleting`). The auth macro exposes two fields:

- `activeWorkspaceIds` — excludes `deleting` workspaces (includes
  active and archived). Use this for search, chat, MCP, and any
  query that builds a workspace allowlist. This is the default;
  reach for it first. [review]
- `accessibleWorkspaces` — includes all statuses. Only use in
  `workspaceAccessMacro` (which needs the status to return
  appropriate HTTP codes). Never pass these IDs as a search/query
  allowlist. [review]

If you need workspace IDs for a new feature, use `activeWorkspaceIds`
unless you have an explicit reason to include deleting workspaces
and document that reason in a comment.

### CSV and file exports

- Use `escapeCSV` from `@/api/lib/csv` for all CSV cell values. Never
  hand-roll CSV escaping; the shared utility handles both delimiter
  quoting and spreadsheet formula neutralization (=, +, -, @, tab, CR
  prefixes). This prevents CSV injection attacks where user-controlled
  values starting with formula characters execute in Excel/LibreOffice.
  [review]

### Multi-entry-point validation

- Validate untrusted input at each entry boundary with the owning shared schema.
  Generated MCP capabilities validate the live endpoint's body, params, and query
  schemas in `apps/api/src/mcp/capability-tools.ts`; do not repeat that parsing
  inside the handler. Native MCP tools and chat registry tools normalize input
  through `normalizeObjectInputAtBoundary` before dispatch; any other caller that
  bypasses the HTTP route (cron jobs, workers) must apply the same normalizer and
  schema before calling the operation. Keep business invariants and
  related-resource authorization in the owning operation: an ID's valid shape
  does not establish its ownership.
  [review]

### CI workflow permissions

- GitHub Actions workflows must declare the **minimum** permissions
  needed. Never use `permissions: write-all`. For PR-triggered
  workflows, scope to `contents: read` + `pull-requests: write`.
  Pin third-party actions to commit SHAs, not mutable tags. For
  SBOM/provenance, use the shared `stella/.github` reusable
  workflows which handle pinning, checksums, and PR-based updates.
  [review]
