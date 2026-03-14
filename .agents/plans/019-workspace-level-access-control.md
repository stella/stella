# Plan: Workspace-Level Access Control (RLS + Branded Types)

Date: 2026-03-09
Updated: 2026-03-10

Status: **implemented**

## Goal

Make cross-workspace data leaks structurally impossible.
Enforce ethical walls (Chinese walls) at two independent
layers: TypeScript branded types + PostgreSQL Row-Level
Security. Both the compiler and the database prevent
unauthorized access. Users must have zero visibility into
workspaces they are not assigned to: no names, no members,
no metadata.

## Architecture

### Single database role

The app connects as `stella`, a non-owner role with
SELECT/INSERT/UPDATE/DELETE grants. RLS applies because
`stella` does not own the tables. Migrations run as the
table owner (`stella` superuser via `DATABASE_URL`).

There is no second connection string. `DATABASE_URL` is
the only env var. The runtime role is enforced by the
grants SQL (`drizzle/0001_stella-grants.sql`).

### Session variables (PgBouncer-safe)

All RLS policies read from transaction-scoped session
variables set via `set_config(..., true)` (SET LOCAL):

| Variable              | Set by              | Purpose                       |
| --------------------- | ------------------- | ----------------------------- |
| `app.workspace_ids`   | `createScopedDb`    | Workspace-level RLS filtering |
| `app.organization_id` | Both                | Org-level RLS filtering       |
| `app.user_id`         | `createBootstrapDb` | Bootstrap policy activation   |

Constants are exported from `db/rls.ts` to avoid typos.

### Two database wrappers

**`createScopedDb(workspaceIds, organizationId)`** — used
by all handler queries. Opens a transaction, sets all three
session variables, runs the callback. Every handler receives
`scopedDb` from `authMacro`.

**`createBootstrapDb(userId, organizationId)`** — used only
in `resolveAccessibleWorkspaceIds`. Sets `app.organization_id`
and `app.user_id` but NOT `app.workspace_ids`. This activates
bootstrap policies (see below). Used before `scopedDb` can be
created.

Raw `db` is reserved for internal infrastructure (connection
setup, schema introspection). Never used in handlers.

### RLS policy structure

All policies are defined in `db/schema.ts` using Drizzle's
`pgPolicy`. Shared helpers live in `db/rls.ts`.

**`db/rls.ts` exports:**

```
stella          — pgRole("stella")
wsIdsArray      — sql`current_setting('app.workspace_ids', true)::text[]`
wsPolicies()    — 4 CRUD policies: workspace_select/insert/update/delete
orgPolicies()   — 4 CRUD policies: organization_select/insert/update/delete
```

Policy SQL checks:

- Workspace: `workspace_id = ANY(current_setting('app.workspace_ids', true)::text[])`
- Organization: `organization_id = current_setting('app.organization_id', true)`

### Bootstrap policies

Problem: `resolveAccessibleWorkspaceIds` queries `workspaces`
and `workspace_members` before workspace IDs are known. With
RLS active, these queries return zero rows.

Solution: permissive SELECT policies that activate only when
`app.workspace_ids` IS NULL. PostgreSQL permissive policies
combine with OR, so if either the normal or bootstrap policy
passes, the row is visible.

**`workspaces` — `bootstrap_select`:**

```sql
USING (
  organization_id = current_setting('app.organization_id', true)
  AND current_setting('app.workspace_ids', true) IS NULL
)
```

**`workspace_members` — `bootstrap_select`:**

```sql
USING (
  user_id = current_setting('app.user_id', true)
  AND current_setting('app.workspace_ids', true) IS NULL
)
```

Ethical walls preserved: during bootstrap, a user sees only
their own membership rows. The JOIN with workspace_members
filters workspaces to assigned ones only. Once `scopedDb`
is created, normal workspace policies take over.

## Tables with RLS

### Workspace-scoped (18 tables, `...wsPolicies()`)

workspaceMembers, workspaceContacts, properties,
propertyDependencies, entities, entityVersions, fields,
justifications, searchDocuments, extractedContent,
timeEntries, billingCodes, rateTables, expenses, invoices,
documentCounters, caseLawMatterLinks

All filter on `workspace_id = ANY(app.workspace_ids)`.

### Workspace-scoped with custom policies (1 table)

**workspaces** — custom policies using `id = ANY(wsIdsArray)`
(uses `id` not `workspace_id`). Plus `bootstrap_select`.
INSERT uses `withCheck: true` (unrestricted, org_id checked
at app layer).

### Organization-scoped (13 tables, `...orgPolicies()`)

contacts, contactRelationships, templates, templateVersions,
matterCounters, organizationSettings, clauseCategories,
clauses, clauseVariants, clauseVersions, templateCategories,
templateClauses, templateFills

All filter on `organization_id = app.organization_id`.

### No RLS (global / unscoped)

caseLawSources, caseLawDecisions, caseLawCitations,
caseLawPolarityRules, caseLawSearchDocuments — global
reference data with no tenant column.

rateEntries — no direct tenant column; accessed only
through rateTables (which has wsPolicies).

Auth tables (user, session, account, verification,
organization, member) — managed by better-auth, no RLS.

## Denormalized tenant IDs

Many child tables carry both `workspaceId` and
`organizationId` even when reachable via FK. This is
intentional: RLS policies need the scoping column directly
on each row for efficient filtering without JOINs.

## Key files

| File                                  | Role                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------ |
| `db/rls.ts`                           | Role, setting constants, SQL fragments, policy helpers                                     |
| `db/schema.ts`                        | Table definitions with `pgPolicy` in table configs                                         |
| `db/index.ts`                         | `createScopedDb`, `createBootstrapDb`, `db`                                                |
| `lib/auth.ts`                         | `resolveAccessibleWorkspaceIds` (uses bootstrapDb), `workspaceAccessMacro` (uses scopedDb) |
| `drizzle/0001_stella-grants.sql`      | GRANT statements for `stella` role                                                         |
| `tests/security/rls-policies.test.ts` | Structural test: every scoped table has policies                                           |

## Design decisions

- **Junction table for workspace membership.** Many-to-many
  via `workspace_members`. Workspace-level roles can be added
  as a column later without schema changes elsewhere.

- **`SET LOCAL` per transaction, not per connection.** Safe
  with PgBouncer in transaction mode. Variable scoped to
  current transaction only.

- **Array of workspace IDs, not a single ID.** Workspace list
  and search need to filter across all of a user's workspaces.
  Set once per request, avoids re-querying membership in every
  policy evaluation.

- **Branded type `SafeId<"workspace">` gates access.**
  `workspaceAccessMacro` checks `workspace_members` before
  minting the branded ID. Handlers cannot compile without
  the access check having run.

- **404, not 403.** Unauthorized workspaces return 404 to
  prevent enumeration. RLS filters search, lists, chat tools.

- **No Redis cache for membership.** Simple indexed lookup,
  sub-millisecond. Caching introduces revocation delay;
  for privileged legal data, immediate revocation wins.

- **New user joins org → zero workspaces.** Admin explicitly
  assigns. Safest default for legal data.

- **Owner/admin bypass.** Org owners and admins see all
  workspaces (needed for management). Checked in both the
  macro and RLS policies.

## Resolved questions

- **No `adminDb` / superuser connection.** Bootstrap policies
  eliminate the need. Single `DATABASE_URL` for everything.

- **`sql.raw()` not needed.** Drizzle's `sql` template tag
  parameterizes string constants correctly. `::text[]` cast
  is necessary because `current_setting()` returns `text`.

- **Ethical walls by design.** Zero visibility across
  workspace boundaries. All counts derive from filtered
  result sets, never global `COUNT(*)`. Bootstrap policies
  restrict visibility to own membership rows only.
