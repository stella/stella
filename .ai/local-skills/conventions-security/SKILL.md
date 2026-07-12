---
name: conventions-security
description: 'Apply when writing code that touches auth, data access, file handling, or external APIs. Stella handles privileged legal data (attorney-client privilege, litigation holds, personal data).'
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
- **Ethical walls** — workspace (matter) boundaries enforce
  information barriers for the `member` role at the RLS layer (not
  just the UI): a member has zero visibility into workspaces they
  are not assigned to via `workspace_members` — no names, no
  members, no metadata. **Known limitation:** org `owner`/`admin`
  roles carry a deliberate firm-admin override granting access to
  every client matter (`client_id IS NOT NULL`) regardless of
  assignment, and there is no per-matter screening to wall a
  specific admin out of a specific matter. Do not describe admin
  access as "absolute confidentiality." Screening a matter from an
  admin requires a matter-level exclusion consulted by the RLS
  view (`stella_authorized_workspaces`), which is not yet built.
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

When business logic is reachable from multiple entry points (HTTP
routes, MCP tools, chat tools, cron jobs), validation must live in
the business logic function itself or in a shared schema, not only
in the HTTP route schema. The MCP/chat path will bypass Elysia
`t.Object` schemas. Prefer Valibot `v.parse()` at the handler
boundary so constraints are enforced regardless of caller.

### Filename sanitization

All user-supplied filenames must pass through `sanitizeFilename`
(`@/api/lib/sanitize-filename`) before storage or use in file
operations (ZIP entries, Content-Disposition headers, S3 keys).
The sanitizer strips path separators, traversal sequences, and
dangerous characters.

### Cross-org user ID validation

When a handler accepts a `userId` from user input (body, query, or
params) and uses it in a query that returns user data (names, emails,
images), validate org membership first using `validateOrgUserId` from
`@/api/lib/branded-types`. The returned `ValidatedOrgUserId` proves
the check happened at the type level, making cross-org user ID
injection structurally impossible. For read paths that resolve
userIds stored in the database (not from user input), scope the user
query with an `innerJoin` on the `member` table filtered by
`session.activeOrganizationId`.

### CI workflow permissions

GitHub Actions workflows must declare the **minimum** permissions
needed. Never use `permissions: write-all`. For PR-triggered
workflows, scope to `contents: read` + `pull-requests: write`.
Pin third-party actions to commit SHAs, not mutable tags. For
SBOM/provenance, use the shared `stella/.github` reusable
workflows which handle pinning, checksums, and PR-based updates.
