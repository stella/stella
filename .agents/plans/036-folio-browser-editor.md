# Plan: In-Browser DOCX Editing with Folio

Date: 2026-04-24

## Goal

Add an "Edit in browser" button to the PDF viewer that opens the DOCX
in Folio's `<DocxEditor>`, using the same lock mechanism as desktop
editing. Users can edit DOCX files without leaving the browser; changes
auto-checkpoint and finalize as a new version on close.

## Design Decisions

- **Reuse desktop edit sessions, not a new lock type.** The existing
  `desktopEditSessions` table, token model, and force-takeover flow
  already solve file locking. Rename conceptually to "edit sessions"
  but keep the schema. The `createdBy` + `entityId` + `propertyId`
  unique constraint already enforces exclusive access.

- **"Edit in browser" replaces the PDF viewer, not a new route.** The
  PDF viewer route (`/$viewId/pdf?entity=...&field=...`) gains an
  `editing=true` search param. When active, `<DocxEditor>` renders in
  place of `<PDFViewport>`. The surrounding chrome (version sidebar,
  entity metadata panel) stays. No new route needed.

- **Auto-checkpoint on change, finalize on close.** Folio's `onChange`
  callback debounces and checkpoints to the session endpoint. "Done
  editing" button finalizes (creates version) and switches back to PDF
  view. Navigating away without finalizing leaves the session open
  (same as desktop — user can resume).

- **Button visibility: only for DOCX files with write permission.** The
  "Edit in browser" button shows only when `mimeType` is a DOCX type
  and the user has `entity:update` permission on the entity.

## Scope

**In scope:**

- "Edit in browser" button in the full PDF viewer toolbar
- Open desktop edit session on click (acquire lock)
- Fetch original DOCX via presigned URL, load into `<DocxEditor>`
- Auto-checkpoint on debounced changes
- "Done editing" button that finalizes session (new version)
- "Discard changes" that releases session (cancel)
- Lock indicator showing who is editing (already exists for desktop)
- Resume from checkpoint if session already open

**Out of scope:**

- Real-time collaboration (Yjs) — future
- Editing in the inspector peek view (too small)
- Editing non-DOCX files (PDF, images)
- Mobile/touch editing
- Offline editing

## Implementation

### Backend (minimal changes)

- `apps/api/src/handlers/entities/open-desktop-edit-session.ts` — no
  changes needed; the existing endpoint works for browser editing too.
  The session doesn't know or care if the client is desktop or browser.

- Consider adding an optional `source: "desktop" | "browser"` field to
  the session for analytics, but not blocking.

### Frontend

- `apps/web/src/routes/_protected.workspaces/$workspaceId/$viewId.pdf.tsx`
  — add `editing` boolean search param. When true, render
  `<DocxBrowserEditor>` instead of `<PDFViewport>`.

- `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/pdf/`
  — add "Edit in browser" button to the PDF toolbar (next to download,
  print). Only visible for DOCX mime types with write permission.

- `apps/web/src/routes/_protected.workspaces/$workspaceId/-components/docx/`
  — new directory with:
  - `docx-browser-editor.tsx` — wrapper that manages the edit session
    lifecycle (open → checkpoint → finalize/cancel) and renders
    `<DocxEditor>` from `@stella/folio`.
  - `use-edit-session.ts` — hook encapsulating session open/checkpoint/
    finalize/cancel API calls + debounced auto-save.

- `packages/folio` dependency added to `apps/web/package.json`.

### Data flow

```
User clicks "Edit in browser"
  → POST /desktop-edit-sessions/open (acquire lock, get token + URL)
  → fetch(presignedUrl) → ArrayBuffer
  → <DocxEditor documentBuffer={buffer} onSave={checkpoint} />
  → on change (debounced 5s): POST /checkpoint with DOCX buffer
  → "Done editing": POST /finalize → navigate back to PDF view
  → "Discard": POST /release → navigate back to PDF view
```

## Test Cases

- Open DOCX in browser editor, edit text, finalize → new version
  appears in version history
- Two users try to edit same file → second user sees lock indicator
  with first user's name
- Force takeover → first user's next checkpoint returns 409
- Navigate away without finalizing → session stays open, can resume
- Edit session checkpoint → crash → reopen → resumes from checkpoint
- Non-DOCX file → "Edit in browser" button not shown
- Read-only user → "Edit in browser" button not shown

## Open Questions

- Should auto-checkpoint interval be configurable? Default 5s seems
  reasonable but aggressive for large files.
- Should we show a diff between the original and edited version before
  finalizing? (Nice to have, not blocking.)
