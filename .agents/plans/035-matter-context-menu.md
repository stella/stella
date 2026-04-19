# Plan: Matter Context Menu & Archive

Date: 2026-04-19

## Goal

Build a shared matter context menu (right-click) used in both the
matter card grid and the sidebar pinned items. Add archive as a new
matter lifecycle state. Add a flash animation when jumping to a group
via the alphabet index.

## Design Decisions

- **Shared `MatterContextMenu` component** over duplicating menu items.
  Both the matter card and sidebar need identical actions; a single
  component with a workspace prop keeps them in sync.

- **Extend the `status` enum** (`"active" | "deleting"` → add
  `"archived"`) rather than adding a separate `archivedAt` timestamp.
  The existing status field already drives the delete lifecycle; archive
  is another state in the same machine. Archived matters stay in the DB
  (no S3/Glacier move in v1; that's a follow-up per GOALS.md).

- **Archive = soft hide, not delete.** Archived matters disappear from
  the default list view but remain queryable with a filter toggle.
  All data, members, and documents are preserved.

- **Add-member uses a popover with combobox**, not a dialog. Context
  menu → popover keeps the user in flow. Reuse the member query and
  `UserIdentity` component from the existing `AddMemberDialog`.

- **Inline rename** via the existing `InlineEdit` component, triggered
  from the context menu. The card name swaps to an input; Enter commits,
  Escape cancels.

## Scope

**In scope:**

- Shared `MatterContextMenu` component with actions:
  Rename, Add member, Copy link, Pin/Unpin, Archive, Delete
- Backend: `POST /workspaces/:id/archive` + `POST /workspaces/:id/unarchive`
- DB: extend workspace status enum to include `"archived"`
- Frontend: archive/unarchive mutation, filter archived from default view
- Alphabet index: flash ring animation on the target group header
- Wire shared menu into matter card + sidebar pinned items

**Out of scope:**

- S3/Glacier tiering for archived matter files (GOALS.md follow-up)
- Bulk archive
- Archive retention policies
- Full matter lifecycle state machine (open/closed/archived)

## Implementation

### Backend

- `apps/api/src/db/schema.ts` — extend workspace status enum:
  `["active", "deleting", "archived"]`
- `apps/api/src/handlers/workspaces/archive.ts` — new handler: set
  status to `"archived"`, permission `workspace: ["update"]`
- `apps/api/src/handlers/workspaces/unarchive.ts` — new handler: set
  status back to `"active"`
- `apps/api/src/handlers/workspaces/routes.ts` — register new routes
- `apps/api/src/handlers/workspaces/read.ts` — filter out archived
  by default, accept `?status=archived` query param

### Frontend

- `apps/web/src/routes/_protected.workspaces/-components/matter-context-menu.tsx`
  — new shared component: renders menu items, handles all actions
- `apps/web/src/routes/_protected.workspaces/-components/matter-card.tsx`
  — consume shared menu, remove inline menu code
- `apps/web/src/components/app-sidebar.tsx` — wire shared menu into
  pinned workspace items
- `apps/web/src/routes/_protected.workspaces/-mutations.ts` — add
  `useArchiveWorkspace` / `useUnarchiveWorkspace`
- `apps/web/src/routes/_protected.workspaces/-components/alphabet-index.tsx`
  — call a flash callback on scroll-to; the group header receives a
  transient ring class via ref
- `apps/web/src/routes/_protected.workspaces/-components/client-group-header.tsx`
  — accept a `flash` prop or ref for the ring animation

### i18n

Keys already exist: `common.rename`, `common.copyLink`,
`workspaces.members.addMember`, `workspaces.archiveMatter`.
May need `workspaces.unarchiveMatter`, `workspaces.showArchived`.

## Test Cases

- Archive a matter → disappears from default list
- Toggle "show archived" → archived matters visible with visual badge
- Unarchive → returns to default list
- Right-click matter card → all 6 actions appear
- Right-click pinned sidebar item → same actions appear
- Rename from context menu → inline edit, Enter saves, Escape cancels
- Add member from context menu → popover with org member search
- Copy link → clipboard contains correct URL
- Alphabet index click → scrolls to group, ring flash on header
- Archived matters excluded from search results by default
- Permission check: members without `workspace:update` cannot
  archive/rename/add member

## Open Questions

- Should archived matters count in the sidebar badge / client group
  count? (Suggest: no)
- Should the archive action require confirmation? (Suggest: no,
  it's reversible — unlike delete)
