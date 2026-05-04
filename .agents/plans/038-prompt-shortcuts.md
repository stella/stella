# Plan: Prompt Shortcuts ("Skills")

Date: 2026-05-03

## Goal

Let users create personal or org-shared `/` prompt shortcuts with a name, description, command handle, and prompt body. The Knowledge > Skills tile becomes the management surface; the chat home screen surfaces a random selection from the user's saved shortcuts.

## Design Decisions

- **Reuse `ChatPrompt` shape**: `apps/web/src/lib/prompts/types.ts` already defines `scope: "stock" | "team" | "private"` and the `ChatPrompt` type. The DB-backed shortcuts feed the same `PromptSuggestions` component and the future slash-command picker without any shape changes. The `"stock"` scope value is removed — all prompts are DB-backed.
- **`command` field**: Shortcuts carry a `/command` handle (e.g. `/summarize-nda`). Validation: `^[a-z0-9][a-z0-9_-]{0,48}$` — no whitespace, no uppercase. Reserved: `model`, `new` (blocked at the API boundary and validated on the frontend).
- **Scope = ownership**: `scope: "team"` means org-wide; creating team shortcuts requires Admin or Owner role. `scope: "private"` means only the creating user. `organizationId` is always stored for RLS; `userId` is stored for private shortcuts (non-null) and for team shortcuts (creator audit trail).
- **Command uniqueness is split by scope**: team commands are unique per-org; private commands are unique per-user. This allows a user's private `/foo` to coexist with an org-wide `/foo`. When both exist for the same command string, team takes precedence in the slash menu and the Skills page shows a "shadowed by team shortcut" badge on the private one.
- **Pre-seeded defaults via `isDefault` flag**: On first visit to the Skills page (or during onboarding if one is added later), four default private shortcuts are seeded into the DB for the user (the same content as today's hardcoded stock prompts). They carry `isDefault: true` so the UI can label them "Default" but they are otherwise fully editable and deletable. The hardcoded `useStockPrompts` hook is deleted once seeding is in place.
- **Seeding trigger**: The list endpoint returns a `seeded: boolean` field. On first load (empty result + `seeded: false`), the frontend calls a dedicated `POST /shortcuts/seed` endpoint that inserts the defaults for the current user. Idempotent: re-calling it is a no-op if any shortcuts already exist.
- **Chat home screen**: Queries the user's shortcuts (private + team) via the list endpoint; samples up to 4 at random. Falls back to the seeded defaults if the list is empty (edge case during first page load before seeding completes).

## Scope

**In scope:**

- `promptShortcuts` DB table with `id`, `organizationId`, `userId`, `scope`, `name`, `description`, `command`, `prompt`, `isDefault`, `createdAt`, `updatedAt`
- API: CRUD + seed endpoints under `/api/shortcuts`
- Command validation + reserved-word rejection at the API boundary
- Team shortcut creation restricted to Admin/Owner; any member can create private shortcuts
- Knowledge > Skills route (`/knowledge/skills`) with full CRUD table UI (shows both team and private, grouped or tabbed)
- Knowledge landing tile linked (remove "coming soon" state)
- Skills page triggers seeding on first load
- Chat home screen samples up to 4 from the user's shortcuts
- `PromptSuggestions` extended to show `/command` handle alongside name
- "Shadowed" badge on private shortcuts whose command collides with a team shortcut
- Remove `useStockPrompts` and the hardcoded stock list once seeding covers the same content
- i18n keys for all new strings

**Out of scope:**

- Slash-command autocomplete in the chat composer (separate feature)
- Workspace-scoped shortcuts
- Import/export of shortcut libraries
- Per-shortcut usage analytics

## Implementation

- `apps/api/src/db/schema.ts` — add `promptShortcuts` table
- `apps/api/src/db/schema-validators.ts` — add `PromptShortcutScope` union, command regex constant, reserved command list
- `apps/api/src/handlers/shortcuts/` — `create.ts`, `update.ts`, `delete.ts`, `list.ts`, `seed.ts`, `routes.ts`
- `apps/api/src/routes.ts` — mount shortcuts router
- `apps/web/src/routes/_protected.knowledge/skills.tsx` — Skills page (grouped table + form dialog + seed-on-mount effect)
- `apps/web/src/routes/_protected.knowledge/-components/shortcut-form-dialog.tsx` — create/edit dialog with command validation
- `apps/web/src/routes/_protected.knowledge/-queries.ts` — add `shortcutsOptions` query factory
- `apps/web/src/routes/_protected.knowledge/index.tsx` — wire up skills tile link
- `apps/web/src/lib/prompts/use-prompts.ts` — new hook that queries DB shortcuts and samples 4 for the home screen
- `apps/web/src/lib/prompts/stock.ts` — deleted (replaced by DB-backed defaults)
- `apps/web/src/routes/_protected.chat/index.tsx` — switch to `use-prompts` hook
- `apps/web/src/i18n/langs/en.json` (and other langs) — new keys under `knowledge.skills.*`

## DB Schema (sketch)

```ts
export const promptShortcuts = stella.table("prompt_shortcuts", {
  id: safeId("id", "shortcut"),
  organizationId: safeOrganizationId("organization_id").notNull(),
  userId: p.text("user_id").notNull(),   // always set; creator for team, owner for private
  scope: p.text("scope").notNull(),      // "team" | "private"
  name: p.text("name").notNull(),
  description: p.text("description"),
  command: p.text("command").notNull(),
  prompt: p.text("prompt").notNull(),
  isDefault: p.boolean("is_default").notNull().default(false),
  createdAt: p.timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: p.timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Team commands: unique per org
  p.uniqueIndex("prompt_shortcuts_org_team_command_idx")
    .on(table.organizationId, table.command)
    .where(sql`scope = 'team'`),
  // Private commands: unique per user
  p.uniqueIndex("prompt_shortcuts_user_private_command_idx")
    .on(table.userId, table.command)
    .where(sql`scope = 'private'`),
  p.index("prompt_shortcuts_org_scope_idx").on(table.organizationId, table.scope),
  p.index("prompt_shortcuts_user_idx").on(table.userId),
]);
```

## Test Cases

- Command validation rejects: whitespace, uppercase, leading hyphen/underscore, reserved words (`model`, `new`), empty string
- Command validation accepts: `summarize-nda`, `draft_response`, `q`, `find-risks`
- Creating two team shortcuts with the same command in the same org returns 409
- Creating two private shortcuts with the same command for the same user returns 409
- Private `/foo` + team `/foo` in the same org can coexist; list returns both with `shadowed: true` on the private one
- Team shortcut creation by a Member role returns 403; Admin succeeds
- Seed endpoint inserts 4 defaults for a new user; re-calling it is a no-op
- Delete removes the record; subsequent list does not include it
- Chat home screen renders at most 4 prompts

## Open Questions

None — all resolved above.
