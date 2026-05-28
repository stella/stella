# Plan: File Version Upload via Right-Click and Drag-and-Drop

Date: 2025-05-27

**Issue:** [#17](https://github.com/anthropics/stella/issues/17)

## Goal

Add two ways to upload a new version of an existing file:
1. Right-click context menu on file entities with "Upload new version" option
2. Drag-and-drop single file onto a document row with confirmation dialog

Multi-file drops onto any row create new files without a dialog (batch upload intent).

## Design Decisions

- **Strict extension matching:** Only allow uploads where extensions match exactly
  (`.doc` → `.docx` rejected). Prevents accidental format changes; users can
  always create a new file if they need a different format.

- **No folder-row drop target (for now):** Dropping onto a folder row is *not*
  a row-level drop target. The workspace-level `DropZone` catches the drop and
  creates new files at the workspace root. Reason: `useCreateFileEntities` /
  the upload endpoint don't accept a `parentId`, so files dropped on a folder
  would land at the root anyway — highlighting the folder row would be misleading
  UX ("looks like it goes in here, but it doesn't"). Enabling this needs the
  upload path to thread `parentId` through end-to-end first; tracked separately.

- **Row-level drop targets with coordinated visuals:** Use a shared context
  (`RowDropTargetContext`) so row drop targets can suppress the parent `DropZone`
  overlay. Pragmatic DnD's innermost-wins behavior handles the drop routing; the
  context only coordinates visual feedback.

- **Dialog for single-file document drops:** When dropping a single file onto a
  document row, show a dialog offering "Replace as new version" or "Create new
  file". This prevents accidental overwrites and handles extension mismatches
  gracefully.

- **Multi-file drops skip dialog:** Dragging multiple files signals batch upload
  intent, not version replacement. All files are created as new files in the
  target's parent folder (or workspace root if the target has no parent). No
  dialog shown — consistent with folder drop behavior.

- **Root-level documents:** If "Create new file" is chosen for a document at
  workspace root (no parent folder), the new file is created at root.

## Scope

**In scope:**

- Right-click → "Upload new version" menu item for file entities
- Single-file drag-and-drop onto document rows with confirmation dialog
- Multi-file drag-and-drop onto document rows creates new files (no dialog)
- Extension validation with user feedback
- Visual feedback (row background/shadow highlight, overlay suppression)

**Out of scope:**

- Folder-row drop targets — needs `parentId` plumbed through the upload
  endpoint and `useCreateFileEntities` first; otherwise the file lands at root
  and the row highlight lies about where the file ends up.
- Automatic format conversion (e.g., .doc → .docx)
- Drag from browser/other apps (external file drop only)
- Version history UI changes

## Implementation

### Backend

Already implemented: `apps/api/src/handlers/entities/upload-version.ts`

### Frontend

**New files:**

- `apps/web/.../−context/row-drop-target-context.tsx` — Shared context for
  coordinating row-level drop target state with parent `DropZone`

- `apps/web/.../−hooks/use-upload-version.ts` — Hook wrapping the upload-version
  API call with toast feedback

- `apps/web/.../−hooks/use-external-file-drop.ts` — Reusable hook encapsulating
  Pragmatic DnD's `dropTargetForExternal` with context coordination. Returns
  `{ ref, isDropTarget }` for attaching to row elements.

- `apps/web/.../−components/version-or-new-file-dialog.tsx` — Confirmation dialog
  for document row drops. Offers "Replace as new version" (disabled if extension
  mismatch) or "Create new file".

- `apps/web/.../−components/version-or-new-file-dialog.logic.ts` — Pure helper
  `extensionMatches(entity, file)` for testability.

**Modified files:**

- `apps/web/.../−components/drop-zone.tsx` — Wrap children with
  `RowDropTargetProvider`; suppress overlay when `activeRowId !== null`

- `apps/web/.../−components/row-actions.tsx` — Add hidden file input + "Upload
  new version" menu item (visible for non-folder, non-bulk, file entities)

- `apps/web/.../−components/table/workspace-table/row-cells.tsx` — Attach
  `useExternalFileDrop` to `DraggableRow` (file entities only, opens dialog).
  Folder rows fall through to the workspace `DropZone` — see "No folder-row
  drop target" above. Set `data-drop-target` on the row.

- `apps/web/.../−components/table/workspace-grid.tsx` — Apply the drop-target
  visual via the cells (`group-data-[drop-target]/row:` tint) plus a row-level
  `::after` pseudo-element for the primary-color outline. The row's own
  `background-color` / `box-shadow` can't be used because each cell has an
  opaque `bg-background` and its own stacking context (`relative z-0`), which
  paints over both. This is the same reason hover/selected states are also
  applied via `group-data-*/row:` selectors on the cells.

- `apps/web/src/i18n/langs/*.json` — Search `en.json` for existing reusable keys
  (e.g., `common.upload`, `common.replace`, `common.cancel`) before adding new
  ones. Add new keys to `en.json`, then add idiomatic translations to all target
  language files (cs, de, es, et, fr, hu, lt, lv, pl, pt-BR, sk). Run
  `i18n-typegen src/i18n/langs` from `apps/web` to regenerate types.

### Patterns to Follow

**Dialog pattern:** Mount body conditionally (`{open ? <Body /> : null}`) to
auto-discard state on close. Footer: Cancel (ghost) + Submit (primary). Use
interruptible CSS transitions for entry/exit animations.

**Drop target pattern:** Store callbacks in refs to avoid re-registering mid-drag.
Return cleanup function from `dropTargetForExternal`.

**Animation pattern (UX conventions):**
- Animate only `opacity` and `transform` (GPU-friendly); never animate `width`,
  `height`, `border-width`, or layout properties.
- Specify exact transition properties (`transition: opacity 150ms, background-color 150ms`);
  never use `transition: all`.
- Use ~150-200ms duration for state transitions.
- Drop target highlight: prefer `background-color` or layered `box-shadow` over
  ring/border changes for depth indication.

## Test Cases

**Unit tests:**

- `extensionMatches` helper: matching extensions, mismatched extensions,
  case-insensitive, entity without file

**Manual verification:**

1. Right-click → Upload new version → matching extension uploads successfully
2. Right-click → Upload new version → mismatched extension shows error toast
3. Drag single file over document row → row highlights, no overlay
4. Drop single file on document row → dialog appears with both options
5. "Replace as new version" disabled when extension mismatches
6. "Create new file" on document in subfolder → creates file in that subfolder
7. "Create new file" on document at root → creates file at workspace root
8. Drag multiple files over document row → row highlights
9. Drop multiple files on document row → all files created in parent folder (no dialog)
10. Drag file(s) over folder row → row does *not* highlight (no row-level drop
    target); workspace overlay appears instead and drop creates file(s) at root
11. Drag file(s) over empty space → overlay appears, drop creates file(s) at root
12. Drag leave from row to empty space → row highlight fades, overlay appears
