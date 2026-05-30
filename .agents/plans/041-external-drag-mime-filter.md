# Plan: Filter Row Drop Targets by External Drag Contents

Date: 2026-05-30

**Follows:** [040-new-file-version.md](./040-new-file-version.md)

## Goal

When the user drags external files into the workspace, only show a row-level
drop target on file rows where the drop would be meaningful:

- Single file with a MIME type matching the row's file → row highlights;
  drop opens the "replace as new version or create new file" dialog.
- Multiple files dragged at once → no row highlight; workspace-level
  `DropZone` overlay catches the drop and batch-creates new files.
- Single file whose MIME does not match the row → no row highlight;
  workspace-level overlay catches it and creates a new file.

Currently every file row lights up during any external drag, then the
on-drop handler in row-cells/tree-view inspects the files and decides
between dialog vs. batch-create. The visual affordance lies about routing
in the multi-file and mismatched-MIME cases.

## Problem

Pragmatic DnD's `dropTargetForExternal` exposes a `canDrop` callback, but
the `source.items` passed to it is **deliberately empty during drag**.
See `node_modules/@atlaskit/pragmatic-drag-and-drop/dist/esm/adapter/external-adapter.js:90-96`:

```js
var locked = {
  types: types,
  items: [],    // <-- empty during drag
  getStringData: function getStringData() { return null; }
};
```

Items are only populated in `getDropPayload(event)`, which runs at drop
time. Pragmatic's design choice — not a browser limitation. The native
`DragEvent.dataTransfer.items` array fully exposes `item.kind` and
`item.type` for every item during `dragenter`/`dragover` per spec.
Verified in this codebase via a native `dragenter` listener on the
DropZone element (`itemCount: 2, items: Array(2)` while Pragmatic's
`source.items` simultaneously reports `length: 0`).

A prior attempt (commit `fc59f901`, since reverted) tried to filter inside
`canDrop` using Pragmatic's `source.items`. It always rejected because the
array was always empty. Don't repeat that approach.

## Design Decisions

- **One window-level native listener owns "what's being dragged in".**
  A single module-scoped singleton tracks the current external drag's
  `{ fileCount, mimeTypes }` by listening to native `dragenter`/`dragend`/
  `drop` on `window`. Per-row hooks read from this singleton; they do not
  attach their own native listeners. Avoids N listeners for N rows and
  avoids subtle re-entry bugs with bubbling dragenter events.

- **Synchronous read API for Pragmatic `canDrop` callbacks.**
  Pragmatic's `canDrop` runs outside React's render cycle and must return
  a boolean synchronously. The drag info module exposes a plain
  `getCurrentExternalDrag()` function (reads a module-scoped ref) in
  addition to the React hook. The hook is for components that need to
  re-render when drag state changes; the function is for callbacks.

- **Provider mounts the listener; consumers read.**
  A `ExternalDragInfoProvider` component (mounted once, near the workspace
  root or inside `DropZone`) is the sole owner of the window listener and
  the cleanup. Mount-twice or no-mount cases are safe: the singleton
  ref-counts subscribers.

- **`useExternalFileDrop` gains an `accept` predicate.**
  The hook accepts an optional `accept: (drag: ExternalDragInfo) => boolean`
  callback wired into Pragmatic's `canDrop`. When the predicate returns
  false, Pragmatic does not fire `onDragEnter` for this target, and the
  drag falls through to the parent `DropZone` (Pragmatic's innermost-wins
  routing handles this naturally — same mechanism that already lets the
  workspace overlay take over when row drop targets are disabled).

- **Workspace `DropZone` accepts everything.**
  When a row rejects, the drop lands on the workspace overlay. The
  existing batch `createFileEntities` behavior is correct for both
  multi-file and mismatched single-file drops. No changes to `DropZone`'s
  routing logic.

- **Row drop handlers can drop their fallback branches.**
  Once `canDrop` enforces "single file + matching MIME," the on-drop
  handlers in `row-cells.tsx` and `tree-view.tsx` only need to handle
  that one case. Multi-file and missing-entity-file branches become
  unreachable and should be deleted (not commented out).

- **MIME comparison is case-insensitive and exact.**
  Browsers report MIME types in lowercase (e.g. `image/png`), but we
  normalize defensively. No prefix/wildcard matching — the row's file is
  `image/png`, the dragged file must be `image/png`. Extension matching
  remains the source of truth at drop time inside the dialog (the
  existing `extensionMatches` helper); MIME is only a pre-drop heuristic.

- **The drag info ref is the only source of truth.**
  React state inside the provider is what triggers re-renders for hook
  consumers. The mutable ref is what Pragmatic callbacks read. The
  provider keeps the two in sync; consumers never touch the ref directly.

## Scope

**In scope:**

- New module: `external-drag-info.tsx` (provider + hook + sync read)
- Modify `use-external-file-drop.ts` to accept an `accept` predicate
- Wire the predicate at both call sites (`row-cells.tsx`, `tree-view.tsx`)
- Mount the provider inside `DropZone` (single mount point covers both
  views since both render inside the same workspace `DropZone`)
- Delete debug logging added during investigation
- Delete now-unreachable branches in row-cells/tree-view drop handlers

**Out of scope:**

- Changing `DropZone`'s drop handling (it already does the right thing
  for batch + fallback cases)
- Changing the `VersionOrNewFileDialog` (it only ever sees single +
  matching-MIME drops now, which is what it was designed for)
- Folder-row drop targets (still blocked by missing `parentId` plumbing —
  see 040)
- Generalizing the predicate beyond MIME/count (no current need)
- Falling back gracefully if the native `dragenter` listener doesn't fire
  before Pragmatic's (in practice it always does — native bubbling order
  is deterministic and Pragmatic binds to `window` too; if this ever
  bites, the symptom is "row briefly highlights then unhighlights" which
  is visible in development)

## Implementation

### 1. New module — `external-drag-info.tsx`

Path: `apps/web/src/routes/_protected.workspaces/$workspaceId/-context/external-drag-info.tsx`

Exports:

```ts
type ExternalDragInfo = {
  fileCount: number;
  mimeTypes: string[];  // lowercase, in DataTransferItem order
};

// Component: mounts native window listeners while at least one is mounted.
export const ExternalDragInfoProvider: React.FC<PropsWithChildren>;

// React hook: subscribes consumer to drag state changes.
// Returns null when no external drag is active.
export const useExternalDragInfo: () => ExternalDragInfo | null;

// Synchronous read for use inside Pragmatic DnD callbacks
// (which fire outside React's render cycle).
export const getCurrentExternalDrag: () => ExternalDragInfo | null;
```

Implementation sketch:

```tsx
// Module-scoped state (singleton across the app).
let current: ExternalDragInfo | null = null;
const subscribers = new Set<() => void>();
let mountCount = 0;

const notify = () => {
  for (const cb of subscribers) cb();
};

const onDragEnter = (event: DragEvent) => {
  const dt = event.dataTransfer;
  if (!dt) return;
  const fileItems = Array.from(dt.items).filter((i) => i.kind === "file");
  if (fileItems.length === 0) return;
  const next: ExternalDragInfo = {
    fileCount: fileItems.length,
    mimeTypes: fileItems.map((i) => i.type.toLowerCase()),
  };
  // Skip notify if shallow-equal to avoid re-render storms during
  // bubbling dragenter events.
  if (current && shallowEqual(current, next)) return;
  current = next;
  notify();
};

const reset = () => {
  if (current === null) return;
  current = null;
  notify();
};

const attach = () => {
  if (mountCount === 0) {
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragend", reset);
    window.addEventListener("drop", reset);
  }
  mountCount += 1;
};

const detach = () => {
  mountCount -= 1;
  if (mountCount === 0) {
    window.removeEventListener("dragenter", onDragEnter);
    window.removeEventListener("dragend", reset);
    window.removeEventListener("drop", reset);
    current = null;
  }
};

export const ExternalDragInfoProvider = ({ children }: PropsWithChildren) => {
  useEffect(() => {
    attach();
    return detach;
  }, []);
  return <>{children}</>;
};

export const getCurrentExternalDrag = () => current;

export const useExternalDragInfo = () => {
  return useSyncExternalStore(
    (cb) => {
      subscribers.add(cb);
      return () => subscribers.delete(cb);
    },
    () => current,
    () => null, // SSR fallback
  );
};
```

Notes:
- `useSyncExternalStore` is the canonical React 18+ pattern for
  module-scoped stores; gives correct tearing semantics.
- The "subscribers + ref-counted mount" pattern survives provider
  remounts (e.g. workspace switching) without leaking listeners.
- `shallowEqual` avoids re-renders when the same drag bubbles through
  many elements (every nested dragenter fires another window event).

### 2. Modify `use-external-file-drop.ts`

Add an optional `accept` predicate:

```ts
type ExternalFileDropOptions = {
  id: string;
  onDrop: (files: File[]) => void;
  enabled?: boolean;
  externalRef?: React.RefObject<HTMLDivElement | null>;
  /**
   * Optional pre-drop filter. Called inside `canDrop`. Receives the
   * current external drag info (file count + per-item MIME types) read
   * synchronously from the `ExternalDragInfoProvider`. Returning false
   * makes Pragmatic DnD skip this drop target, letting the parent
   * DropZone catch the drop instead.
   *
   * If omitted or info is null, defaults to accepting any external
   * file drag (current behavior).
   */
  accept?: (info: ExternalDragInfo) => boolean;
};
```

Wire it into `canDrop`:

```ts
canDrop: ({ source }) => {
  if (!containsFiles({ source })) return false;
  const acceptFn = acceptRef.current;
  if (!acceptFn) return true;
  const info = getCurrentExternalDrag();
  if (!info) return false; // listener hasn't fired yet — refuse
  return acceptFn(info);
},
```

Store `accept` in a ref (same pattern as `onDropRef`) so changes don't
re-register the drop target mid-drag.

Delete the debug logging (`debugLabel`, `debugExpectedMimeType`, all
`console.log` calls) added during investigation.

### 3. Mount the provider in `DropZone`

`drop-zone.tsx` already wraps everything in `RowDropTargetProvider`. Add
`ExternalDragInfoProvider` alongside it:

```tsx
export const DropZone = ({ workspaceId, children }: DropZoneProps) => (
  <ExternalDragInfoProvider>
    <RowDropTargetProvider>
      <DropZoneInner workspaceId={workspaceId}>{children}</DropZoneInner>
    </RowDropTargetProvider>
  </ExternalDragInfoProvider>
);
```

Delete the native `dragenter` debug listener and all `console.log` calls
added during investigation.

### 4. Wire predicate at call sites

`row-cells.tsx`:

```ts
const expectedMimeType = file?.mimeType.toLowerCase() ?? null;

const { isDropTarget } = useExternalFileDrop({
  id: entity.entityId,
  onDrop: handleFileDrop,
  enabled: canAcceptDrop,
  externalRef: rowRef,
  accept: (info) =>
    info.fileCount === 1 &&
    expectedMimeType !== null &&
    info.mimeTypes[0] === expectedMimeType,
});
```

Same shape in `tree-view.tsx`. Both files: simplify `handleFileDrop` to
the single-file-matching-MIME case only (the predicate guarantees
nothing else reaches it):

```ts
const handleFileDrop = (files: File[]) => {
  const droppedFile = files[0];
  if (droppedFile) {
    setVersionDialogFile(droppedFile);
  }
};
```

Drop the `files.length > 1`, `isFolder`, and `!file` branches — they are
all unreachable.

### 5. Verify `DropZone` fall-through still works

No code change needed, just confirm: when the row's `canDrop` returns
false, the drop bubbles up to the workspace `DropZone`. Pragmatic's
innermost-wins logic skips the row and the next eligible drop target
(the DropZone) handles the drop. The DropZone's `containsFiles`-only
`canDrop` accepts everything.

### 6. Cleanup

Files to revert / clean (all debug additions from this investigation):

- `apps/web/src/routes/_protected.workspaces/$workspaceId/-hooks/use-external-file-drop.ts`:
  remove `debugLabel`, `debugExpectedMimeType`, all `console.log` calls.
- `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/drop-zone.tsx`:
  remove the native `dragenter` debug listener, all `console.log` calls
  in `canDrop`/`onDragEnter`/`onDragLeave`/`onDrop` and in render.
- `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/table/workspace-table/row-cells.tsx`:
  remove `debugLabel`/`debugExpectedMimeType` props from the
  `useExternalFileDrop` call.
- `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/filesystem/tree-view.tsx`:
  same.

## Test Cases

**Manual verification (Chrome, Safari, Firefox):**

1. Drag a single PNG file over a PNG row → row highlights, workspace
   overlay does not appear, drop opens version dialog.
2. Drag a single PDF file over a PNG row → row does not highlight,
   workspace overlay appears, drop creates new file at workspace root.
3. Drag two PNG files over a PNG row → row does not highlight, workspace
   overlay appears, drop creates two new files at workspace root.
4. Drag a single PNG over a folder row → row does not highlight (folder
   rows don't enable the drop target), workspace overlay appears.
5. Drag from the OS file manager directly to the workspace, never
   crossing a row → workspace overlay appears, drop creates files.
6. Drag over a PNG row, then move to a different PNG row → first row
   un-highlights, second highlights (no overlay flicker).
7. Drag over a PNG row, then move to empty space within the workspace →
   row un-highlights, workspace overlay appears.
8. Cancel a drag mid-flight (Escape, or drag back out of the window) →
   no lingering highlight, drag info resets (verified by next drag
   showing correct count).
9. Repeat all of the above in both the workspace table view and the
   tree view.

**Edge cases:**

- File with no MIME (browser reports empty string): row predicate
  returns false (no match), drop falls through to workspace.
- Workspace switch mid-drag: provider unmounts, listener detaches,
  next drag in new workspace starts fresh.
- Row whose file's `mimeType` is null (entity edge case): predicate
  returns false, drop falls through to workspace.

## Notes

- The `getCurrentExternalDrag` synchronous read is the part that needs
  the most care during code review. It's a module-scoped mutable ref,
  which is unusual in this codebase. The justification is in the
  "Design decisions" above: Pragmatic's `canDrop` is synchronous and
  fires outside React renders. There is no clean way to thread context
  into it. The ref is only written by one place (the window listener)
  and only read by one place (`useExternalFileDrop`'s `canDrop`).
- If a future requirement adds another predicate (e.g. file-size
  rejection, extension filter), extend `ExternalDragInfo` rather than
  adding parallel singletons.
- This plan does not change anything about the on-drop side of the
  flow. The existing dialog, upload-version hook, and create-file-
  entities hook are untouched.
