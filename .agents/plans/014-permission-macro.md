# Plan: Permission Guard as Elysia Macro

Date: 2026-03-07

## Goal

Replace the `beforeHandle: permission(...)` pattern with a
declarative `permission` macro property on `authMacro`. This
eliminates the redundant session lookup, removes lifecycle
ordering ambiguity, and gives routes a cleaner API:
`permission: { entity: ["delete"] }`.

## Status Quo

The `permission()` function in `auth.ts` (lines 181-229) is a
curried `beforeHandle` guard. It:

1. Calls `auth.api.getSession()` (separate from authMacro's
   resolve, relies on cookie cache to avoid a second DB hit)
2. Queries `member` table for the user's role
3. Calls `roles[role].authorize(perms)`
4. Returns 401/403/undefined

This runs in the same beforeHandle/resolve queue as the auth
macro, but independently re-derives the session. 67 endpoints
across 14 route files use this pattern.

## Design Decisions

- **Permission as a function macro on `authMacro`**, not a
  separate plugin. `authMacro` already resolves the session;
  the permission macro extends it, accesses `ctx.session`, and
  adds the role check. Since `workspaceAccessMacro` composes
  `authMacro`, both org-scoped and workspace-scoped routes get
  the permission property for free.

- **Function form, not property shorthand.** The macro uses the
  function form `(perms: PermissionInput) => ({ resolve ... })`
  so it accepts the permission object as a value (not just a
  boolean toggle). Routes declare `permission: { entity: ["delete"] }`.
  When the property is omitted (or undefined), no permission
  check runs.

- **Member role resolved once, added to context.** The macro
  queries the `member` table once and adds `memberRole` to the
  route context. This avoids duplicate member lookups if
  multiple parts of the handler need the role. The query is
  simple (indexed by `organizationId` + `userId`).

- **Keep `beforeHandle` for the one dynamic case.** The batch
  time-entry endpoint needs to inspect `ctx.body.action` to
  choose between `timeEntry: ["update"]` and
  `timeEntry: ["delete"]`. A static macro property can't
  express this. Keep a manual `beforeHandle` for this single
  endpoint; it can call the same role-checking logic without
  the `permission()` wrapper.

- **Delete the `permission()` function.** Once all 66 static
  routes are migrated to the macro, the curried `permission()`
  function and its imports are removed entirely. The batch
  endpoint uses an inline check.

## Scope

**In scope:**

- New `permission` macro property on `authMacro`
- Migrate all 14 route files (66 static + 1 dynamic endpoint)
- Remove `permission()` function from `auth.ts`
- Remove `PermissionInput` import from `time-entries/routes.ts`
  (batch endpoint uses inline role check instead)
- Update permission-guards test to reflect the new pattern
  (the regex that detects guards may need updating)

**Out of scope:**

- Caching the member role in Redis (future optimization)
- Moving the `member` query into `authMacro`'s existing resolve
  (would add a DB query to read-only GET endpoints that don't
  need permissions; keep it in the permission macro only)
- Changing the `@stella/permissions` package
- Frontend changes (none needed; `useCanPerform` is unaffected)

## Implementation

### `apps/api/src/lib/auth.ts`

Add a second `.macro()` call on `authMacro` after the existing
`validateAuth` macro:

```ts
.macro({
  permission: (perms: PermissionInput) => ({
    validateAuth: true,
    async resolve(ctx) {
      const member = await db
        .select({ role: authSchema.member.role })
        .from(authSchema.member)
        .where(
          and(
            eq(authSchema.member.organizationId,
               ctx.session.activeOrganizationId),
            eq(authSchema.member.userId, ctx.user.id),
          ),
        )
        .limit(1)
        .then((rows) => rows[0]);

      if (!member || !isValidRole(member.role)) {
        return status(403);
      }

      if (!roles[member.role].authorize(perms).success) {
        return status(403);
      }

      return { memberRole: member.role as RoleKey };
    },
  }),
})
```

Delete the `permission` export function (lines 176-229).

### `apps/api/src/handlers/*/routes.ts` (14 files, ~66 sites)

Mechanical replacement at each route:

```diff
-.delete("/:entityId", handler, {
-  beforeHandle: permission({ entity: ["delete"] }),
+.delete("/:entityId", handler, {
+  permission: { entity: ["delete"] },
 })
```

Remove `permission` from imports:
```diff
-import { permission, workspaceAccessMacro } from "@/api/lib/auth";
+import { workspaceAccessMacro } from "@/api/lib/auth";
```

### `apps/api/src/handlers/time-entries/routes.ts` (batch)

Replace the `permission()` call with an inline role check:

```ts
.post("/batch", handler, {
  beforeHandle: (ctx) => {
    const perms: PermissionInput =
      ctx.body.action === "delete"
        ? { timeEntry: ["delete"] }
        : { timeEntry: ["update"] };
    // ctx.session and ctx.user available from validateAuth
    // inline role check here (or extract a small helper)
  },
  body: batchUpdateBodySchema,
})
```

### `apps/api/src/tests/security/permission-guards.test.ts`

Update `PERMISSION_RE` to match the new declarative pattern:

```ts
const PERMISSION_RE = /\bpermission\s*:\s*\{/;
```

This matches `permission: { entity: [...] }` in route options.
The batch endpoint's inline beforeHandle should be added to the
ALLOWLIST (or use a secondary regex for the `authorize` call).

## Test Cases

- Existing permission-guards test passes (after regex update)
- Owner/admin can access all mutation endpoints (existing)
- Intern gets 403 on workspace create (existing)
- External gets 403 on all mutations (existing)
- Batch time-entry: intern can update but not delete (existing)
- Unauthenticated request returns 401 (not 403)
- `memberRole` is available in handler context (new; verify
  with a type-level check or a simple test)

## Open Questions

- **Should `memberRole` be added to the context?** It's useful
  for handlers that need role-aware logic beyond permission
  gates (e.g., filtering visible data by role). But it's also
  a new context property on every guarded route. Lean yes,
  but confirm with the team.
- **Elysia macro deduplication**: if a route has both
  `validateWorkspaceAccess: true` (which sets `validateAuth: true`)
  and `permission: { ... }` (which also sets `validateAuth: true`),
  Elysia should deduplicate. Verify this in a quick test before
  migrating all routes.
