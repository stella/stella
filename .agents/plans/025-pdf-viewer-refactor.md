# Plan: PDF Viewer Refactor

Date: 2026-03-18

## Goal

Refactor the PDF viewer into a generic, reusable component that
uses React context + Suspense instead of a global Zustand store
and double buffering. The viewer should render a PDF from a `file`
prop, support controlled `page`/`onPageChanged`, and fit-to-width
via prop; callers decide what chrome (topbar, controls) to add.

## Design Decisions

- **Kill the Zustand PDF store; use React context.** The current
  `usePdfStore` is a global singleton mixing document state,
  render queues, LRU buffers, scale, scroll targets, and password
  dialogs. A context provider scoped to each viewer instance is
  cleaner: no cross-file ID juggling, no cleanup-on-leave
  ceremonies, no stale state from previous navigations. The
  context holds the `PDFDocumentProxy`, page proxies, render
  queue state, and scale. LRU buffer management stays outside
  React (module-scoped), keyed by context identity.

- **Viewer is pure / package-ready.** The PDF viewer component
  and all its internal modules must have zero imports from
  `@/` (app-specific hooks, stores, queries, routes). It only
  depends on `pdfjs-dist`, React, and its own internal modules
  (context, utils, consts). All app-specific behaviour
  (route navigation, PostHog, entity queries, theme detection)
  is handled by the caller via props and children. This means
  the viewer can be extracted to a `packages/pdf` workspace
  package later without changes.

- **Kill double buffering; use `useDeferredValue` + Suspense.**
  The current double-buffer approach (create hidden back canvas,
  render offscreen, swap in, remove old) is complex and fragile.
  Instead: each `PdfPage` renders its canvas via a promise. Wrap
  pages in `<Suspense>`. Use `useDeferredValue` on the scale so
  React keeps showing the old UI (old-scale canvas) until the new
  render resolves. This gives us the same "no flicker" behaviour
  with React managing the transition, not manual DOM manipulation.

- **Restore 3-page immediate rendering.** Revert the change from
  commit `5e3f02f` that reduced immediate pages from 3 (current
  ±1) to 1. The original behaviour is better for perceived
  performance. Remove the `memo()` wrappers added in that commit
  (React Compiler handles memoization).

- **Detach the topbar / controls.** The viewer component accepts
  `page?: number` and `onPageChanged?: (page: number) => void`
  props. If not provided, the viewer manages page state
  internally. The fullscreen route puts page number in URL search
  params via `onPageChanged`; the peek view doesn't need a page
  counter at all. `PdfViewerControls` becomes a standalone
  component that receives page/scale state and callbacks as props.

- **Fit-to-width as a prop, following Mozilla's approach.** The
  viewer accepts `fitToWidth?: boolean` (default false). When
  true, on mount it measures container width and calculates:
  `scale = containerWidth / viewport.width` (viewport at scale
  1.0). This is the Mozilla pdf.js formula. Each page can have
  its own scale if page sizes differ, but for simplicity we use
  the first page's width as the reference (matching current
  behaviour).

- **Keep progressive rendering architecture.** The "render N
  pages, advance queue on completion" pattern works well. Keep
  `getOrderedPages` for spiral ordering. The queue lives in
  context state. `advancePageRendering` is called when a page's
  render promise resolves, pulling the next page from the queue.
  Suspense integration: each page component throws a promise
  (cached) while rendering; Suspense shows the placeholder div.

- **Preserve existing features as overlays.** Anonymisation,
  citation, text selection, password dialog, XFA detection, PDF
  Portfolio support: all stay, but consume from context instead
  of the global store.

## Scope

**In scope:**

- New `PdfViewer` component with context provider, accepting
  `file: Blob | ArrayBuffer`, `page?`, `onPageChanged?`,
  `fitToWidth?`, `invertColors?`, `className?`, `children?`
  (for overlays like `CreatingBBoxes` mounted by the caller)
- `PdfViewerContext` with document, pages, render queue, scale
- Page rendering with Suspense + `useDeferredValue` for zoom
- Restore 3-page immediate rendering from before `5e3f02f`
- Remove `memo()` calls added in `5e3f02f` (React Compiler)
- Remove `perf.ts` instrumentation (already done in `e617e9bb`)
- Controlled/uncontrolled page navigation pattern
- Fit-to-width calculation (Mozilla formula)
- Refactored `PdfViewerControls` as standalone component
- Update fullscreen route (`$viewId.pdf.tsx`) to use new viewer
- Update peek route (`peek-pdf-viewer.tsx`) to use new viewer
- Delete `pdf-store.ts`
- Keep: text selection, anonymisation overlay, citation overlay,
  password dialog, XFA banner, PDF Portfolio support
- `CreatingBBoxes` moves out of the viewer; caller mounts it
  as a child or wraps the viewer in a relative container
- `invertColors` is a plain prop (no persistence); the caller
  manages the toggle state and persistence if desired

**Out of scope:**

- Per-page fit-to-width (different scales per page)
- Changing the anonymisation/redaction architecture
- Backend changes
- New features (annotations, search-in-PDF, etc.)

## Implementation

### New files

- `apps/web/src/lib/pdf/pdf-context.tsx` — React context
  provider: holds `PDFDocumentProxy`, page map, render queue,
  scale, and actions. Replaces `pdf-store.ts`.

### Modified files

- `apps/web/src/lib/pdf/utils.ts` — Revert `getOrderedPages`
  to return 3 immediate pages (current ±1) instead of 1.
- `apps/web/src/routes/…/pdf/pdf-page.tsx` — Remove double
  buffering. Single canvas rendered via promise, integrated
  with Suspense. Remove `memo()`. Consume from context.
- `apps/web/src/routes/…/pdf/pdf-viewer.tsx` — Rewrite as
  generic component. Accept props instead of reading route
  params. Wrap in context provider. Use `useDeferredValue`
  for scale transitions.
- `apps/web/src/routes/…/peek/peek-pdf-viewer.tsx` — Simplify
  to mount the new `PdfViewer` with `fitToWidth` prop. Remove
  `memo()` on `PeekPageWithBanner`.
- `apps/web/src/routes/…/$viewId.pdf.tsx` — Wire new viewer
  with controlled page (from search params) and `onPageChanged`
  that navigates.
- `apps/web/src/routes/…/pdf-viewer-controls.tsx` — Accept
  props for page, totalPages, scale, onZoom, onPageChange
  instead of reading from store/route directly.
- `apps/web/src/routes/…/pdf/page-anonymisation.tsx` — Read
  from context instead of store.
- `apps/web/src/routes/…/pdf/page-citation.tsx` — Read from
  context instead of store.
- `apps/web/src/routes/…/pdf/pdf-password-dialog.tsx` — Read
  from context instead of store.
- `apps/web/src/routes/…/pdf/creating-citations.tsx` — Mounted
  by the caller as a child of the viewer; reads page coords
  from the viewer's exposed context hook.
- `apps/web/src/routes/…/-hooks/pdf/use-pdf-current-page.ts`
  — Simplify or remove; page tracking moves to
  `onPageChanged` callback from IntersectionObserver.
- `apps/web/src/lib/pdf/pdf-store.ts` — Delete.

### No DB schema changes.

## Test Cases

- PDF loads and renders first 3 pages immediately
- Scrolling renders adjacent pages progressively
- Zoom uses `useDeferredValue`: old canvas stays visible until
  new scale renders
- Fit-to-width correctly scales PDF to container width
- Controlled mode: `page` prop + `onPageChanged` callback work
- Uncontrolled mode: internal page state works without props
- PDF Portfolio renders all embedded documents
- Password-protected PDF shows dialog
- XFA form shows banner
- Text selection works across pages
- Anonymisation overlay renders correctly
- Citation overlay + scroll-to works
- Dark mode invert toggle works
- LRU eviction cleans up canvases beyond buffer size
- No memory leaks on unmount (documents destroyed, canvases
  removed)

## Resolved Questions

- `invertColors` is a plain prop; no persistence in the viewer.
- `CreatingBBoxes` is mounted by the caller as a child/overlay,
  not inside the viewer. The viewer exposes a context hook for
  page coordinates that external overlays can consume.
