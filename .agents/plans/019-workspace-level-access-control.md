# Plan: Workspace-Level Access Control (RLS + Branded Types)

Date: 2026-03-09

## Goal

Make cross-workspace data leaks structurally impossible. Add a
`workspaceMember` junction table so not every org member sees
every matter; enforce this at two independent layers (TypeScript
branded types + PostgreSQL Row-Level Security) so both the
compiler and the database prevent unauthorized access.

## Design Decisions

- **Junction table, not a column on `member`.** A user can
  belong to many workspaces. A workspace can have many members.
  Many-to-many requires a junction table (`workspaceMember`).
  Workspace-level roles (e.g., lead vs. viewer) can be added
  later as a column on this table without schema changes
  elsewhere.

- **RLS on all 13 workspace-scoped tables, not just
  `workspaces`.** A leaked query on `entities`, `timeEntries`,
  or `invoices` is just as dangerous as one on `workspaces`.
  Every table with a `workspaceId` column gets a policy. Tables
  reachable only through FK (e.g., `fields` → `entityVersions`
  → `entities`) inherit protection transitively; they don't need
  their own policies because they can only be JOINed through an
  already-filtered parent.

- **`SET LOCAL` per transaction, not per connection.** The app
  is designed for PgBouncer in transaction mode (CLAUDE.md).
  `SET LOCAL` scopes the session variable to the current
  transaction, so it's safe with connection pooling. `SET`
  (global) would leak context across requests sharing a
  connection.

- **RLS variable carries an array of workspace IDs, not a single
  ID.** The workspace list endpoint and search need to filter
  across all of a user's workspaces. Setting
  `app.workspace_ids = '{ws1,ws2,...}'` once per request avoids
  re-querying `workspaceMember` in every RLS policy evaluation.

- **Branded type `VerifiedWorkspaceAccess` gates the macro
  exit.** `workspaceAccessMacro` already returns
  `SafeId<"workspace">`; it will now also check
  `workspaceMember` before minting it. This is the only code
  path that produces the branded ID. Handlers that require a
  `SafeId<"workspace">` literally cannot compile without the
  access check having run.

- **Owner and admin roles bypass workspace membership.** Org
  owners and admins can see all workspaces (they need to manage
  assignments). The RLS policy and the macro both check: "is
  member of workspace OR has org-wide admin/owner role."

- **Workspace creation auto-assigns the creator.** When a user
  creates a workspace, a `workspaceMember` row is inserted in
  the same transaction. No workspace exists without at least
  one member.

- **No workspace-level invitations yet.** Users are invited to
  the org (existing flow). Workspace assignment is done by
  admins/owners after org membership. A workspace invitation
  flow can be added later on top of this table.

## Scope

**In scope:**

- `workspaceMember` junction table (schema + migration)
- PostgreSQL RLS policies on all 13 workspace-scoped tables
- Transaction wrapper that sets `app.workspace_ids` via
  `SET LOCAL` at the start of every authenticated request
- Extend `workspaceAccessMacro` to check workspace membership
- Extend `readWorkspacesHandler` to filter by membership
- Update workspace creation to auto-assign creator
- Update search handler to respect membership
- Update chat tools to respect membership
- Security test: structural test that all workspace-scoped
  tables have RLS policies enabled
- Drizzle `pgPolicy` definitions in schema

**Out of scope:**

- Workspace-level roles (lead, viewer, etc.) — column can be
  added later
- Workspace-level invitations — use admin assignment for now
- UI for managing workspace members — can use existing member
  management patterns
- Migration of existing data — all existing org members get
  auto-assigned to all existing workspaces (backfill migration)

## Implementation

### Schema

`apps/api/src/db/schema.ts`:

- Add `workspaceMember` table:
  - `id` (nanoid PK)
  - `workspaceId` (FK → workspaces.id, cascade delete)
  - `userId` (FK → user.id, cascade delete)
  - `createdAt` (timestamp)
  - Unique constraint on `(workspaceId, userId)`
  - Indexes: `(userId, workspaceId)`, `(workspaceId, userId)`

- Add RLS policies (via `pgPolicy`) to all 13 tables:
  `files`, `workspaceContacts`, `properties`, `entities`,
  `searchDocuments`, `views`, `timeEntries`, `billingCodes`,
  `rateTables`, `expenses`, `invoices`, `documentCounters`,
  `caseLawMatterLinks`

  Each policy:
  ```sql
  USING (
    workspace_id = ANY(
      string_to_array(
        current_setting('app.workspace_ids', true),
        ','
      )
    )
  )
  ```

- Add RLS policy to `workspaces` table itself (for the list
  endpoint):
  ```sql
  USING (
    id = ANY(
      string_to_array(
        current_setting('app.workspace_ids', true),
        ','
      )
    )
  )
  ```

### Database layer

`apps/api/src/db/index.ts`:

- Create a `withWorkspaceContext(userId, orgId, fn)` wrapper
  that:
  1. Queries `workspaceMember` + checks admin/owner role
  2. Collects the user's accessible workspace IDs
  3. Opens a transaction with
     `SET LOCAL app.workspace_ids = '{...}'`
  4. Executes `fn(tx)` within that transaction
  5. Returns the result

- This wrapper is used by the auth macro so every
  authenticated request automatically has RLS context.

### Auth macro

`apps/api/src/lib/auth.ts`:

- `workspaceAccessMacro`: add a `workspaceMember` existence
  check before minting `SafeId<"workspace">`. Return 404
  (not 403) if the workspace exists but the user isn't a
  member — same as "workspace doesn't exist" to prevent
  enumeration.

- Integrate `SET LOCAL` into the request lifecycle. Either:
  (a) in the `authMacro` resolve (runs once per request), or
  (b) in a new Elysia `onBeforeHandle` hook that wraps all
  handlers in a transaction.

### Handlers

`apps/api/src/handlers/workspaces/create.ts`:

- After inserting workspace, insert `workspaceMember` row for
  the creator in the same transaction.

`apps/api/src/handlers/workspaces/read.ts`:

- RLS handles filtering automatically. The query can stay
  as-is (fetches by `organizationId`); RLS will additionally
  filter by membership. No application code change needed
  if RLS is set.

`apps/api/src/handlers/search/search.ts`:

- Currently validates workspace manually. With RLS active,
  the validation is redundant but harmless. Keep the
  application check as defense-in-depth.

`apps/api/src/handlers/registry/actors/chat-tools.ts`:

- `allowedWorkspaceIds` already filters. RLS provides the
  second layer.

New handler — `apps/api/src/handlers/workspaces/members.ts`:

- `GET /workspaces/:workspaceId/members` — list members
- `PUT /workspaces/:workspaceId/members` — add member
  (admin/owner only)
- `DELETE /workspaces/:workspaceId/members/:userId` — remove
  member (admin/owner only)

### Frontend

`apps/web/src/routes/_protected.workspaces/`:

- Workspace list automatically shows only accessible
  workspaces (backend filters).
- Add workspace members UI (member list, add/remove) in the
  workspace settings or metadata sheet.

### Migration

- Backfill migration: for every existing `(organization,
  member)` pair, insert `workspaceMember` rows for all
  workspaces in that org. This preserves current behavior
  (everyone sees everything) and lets admins restrict later.
- Enable RLS on all 14 tables via `ALTER TABLE ... ENABLE
  ROW LEVEL SECURITY`.
- Create a dedicated PostgreSQL role for the application
  connection (RLS does not apply to table owners / superusers).

### Security test

`apps/api/src/tests/security/rls-policies.test.ts`:

- Static test that reads `schema.ts` and verifies every table
  with a `workspaceId` column has `pgPolicy` defined.
- Similar to the permission guards test: fails CI if a new
  workspace-scoped table is added without RLS.

## Test Cases

- User A (member of workspace X) can read entities in X
- User A cannot read entities in workspace Y (not a member)
- User A cannot see workspace Y in the workspace list
- Admin/owner can see all workspaces regardless of membership
- Creating a workspace auto-assigns the creator
- Removing last member from workspace is prevented (or
  transfers to admin)
- RLS filters work: a raw SQL query (bypassing application
  code) returns zero rows for unauthorized workspaces
- Backfill migration assigns all existing members to all
  existing workspaces
- `workspaceAccessMacro` returns 404 for workspaces the user
  isn't a member of
- Search results only include documents from accessible
  workspaces

## Resolved Questions

- **No Redis cache for workspace membership.** The query is
  a simple indexed lookup on `(userId, workspaceId)` —
  sub-millisecond. Caching introduces revocation delay
  (admin removes access, user keeps it for TTL). For
  privileged legal data, immediate revocation wins over
  saving a cheap query. Revisit at Magic Circle scale.

- **New user joins org → zero workspaces.** Admin explicitly
  assigns workspaces. This is the safest default for a legal
  product (no accidental exposure to privileged matters).

- **Ethical walls handled by design.** 404 (not 403) for
  unauthorized workspaces prevents enumeration. RLS filters
  search, lists, chat tools. Remaining discipline: never
  expose global counts or aggregates that reveal hidden
  workspace existence. All counts must derive from the
  filtered result set, not a global `COUNT(*)`.

- **Two PostgreSQL roles for RLS enforcement.** The app
  currently connects as `stella` which owns the tables;
  RLS is silently bypassed for table owners. Split into:
  - `stella` (owner) — used by `db:push` / migrations only
    via `DATABASE_URL`
  - `stella_app` — runtime role with SELECT/INSERT/UPDATE/
    DELETE grants but no table ownership. RLS applies.
    Connected via new `DATABASE_APP_URL` env var.
  The Drizzle config keeps `DATABASE_URL`; the app runtime
  (`db/index.ts`) switches to `DATABASE_APP_URL`.
