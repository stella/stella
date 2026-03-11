# Plan: PDF Page Buffer (Mozilla-style cleanup)

Date: 2026-02-24

## Goal

Large PDFs lag when scrolling after all pages have been rendered,
because every page keeps its canvas and text layer alive in the
DOM. We adopt the same strategy Mozilla PDF.js uses: keep a
bounded buffer of rendered pages and destroy canvases outside
that buffer, leaving empty placeholder divs with correct
dimensions.

## Design Decisions

- **Bounded page buffer instead of full virtualization.**
  Full virtualization (react-window / tanstack-virtual) would
  remove DOM nodes entirely, breaking IntersectionObserver
  tracking and native text selection across pages. Mozilla
  keeps all page divs in the DOM but only populates a fixed
  window of them with canvases. This preserves scroll position
  stability, text selection, and the existing
  IntersectionObserver-based current-page tracking.

- **LRU-like buffer with visibility protection.** Buffer size
  is `max(DEFAULT_CACHE_SIZE, 2 * visiblePages + 1)`. Visible
  pages are always protected from eviction. Oldest non-visible
  pages are evicted first. `DEFAULT_CACHE_SIZE = 10` matches
  Mozilla's default; this caps memory at ~10 canvases
  regardless of document length.

- **Cleanup removes canvas content, not the component.**
  When a page is evicted from the buffer, its canvas is cleared
  (`width = 0; height = 0`), its text layer is emptied, and its
  `PDFPageProxy.cleanup()` is called to release the operator
  list. The outer `<div>` retains its CSS-driven dimensions, so
  layout and scroll position are stable. The page stays mounted
  in React; only its rendered content is stripped.

- **Re-render on scroll back.** When a cleaned-up page becomes
  visible again, the existing render effect re-fires because
  the page transitions from "cleaned" to "should render" state.
  The user sees a brief blank page (the placeholder div) before
  the canvas paints; this matches Mozilla's behavior.

- **Rendering queue stays as-is for initial load.** The current
  bidirectional render queue (from current page outward) works
  well for initial load. The buffer eviction layer is orthogonal:
  it runs after rendering completes and on scroll, cleaning up
  pages that have drifted far from the viewport.

## Scope

**In scope:**

- Page buffer manager (bounded set, LRU eviction, visibility
  protection)
- Canvas/text layer cleanup when a page is evicted
- Re-render trigger when a cleaned page becomes visible
- Integration with existing `usePdfCurrentPage`
  IntersectionObserver to drive visibility tracking
- Rendering queue awareness: buffer should re-queue cleaned
  pages that become visible, respecting proximity priority

**Out of scope:**

- Full DOM virtualization (removing page divs from the DOM)
- Thumbnail rendering
- Idle timeout cleanup (30s timer; can add later)
- `maxCanvasPixels` cap (already reasonable at current scale)
- Streaming / range-request loading
- Changes to zoom, text selection, or citation overlays

## Implementation

### New dependency: `lru-cache`

Well-maintained LRU library (isaacs, 40M+ weekly downloads).
Used instead of a hand-rolled buffer. The `dispose` callback
fires on eviction, which drives canvas cleanup.

### Modified: pdf-store.ts (page buffer integration)

The `lru-cache` instance lives inside the store. Per-file
`LRUCache<string, true>` with `max` set to
`DEFAULT_PAGE_BUFFER_SIZE` (from `lib/limits.ts`) and a
`dispose` callback that marks evicted pages as `idle`.

### Modified: pdf-store.ts

- Add a `pageStates` map tracking each page as `idle | rendering
| rendered | cleaning`. The existing `renderMap` continues to
  drive the initial rendering queue; `pageStates` is the new
  source of truth for whether a page's canvas is alive.
- On `advancePageRendering` (page finishes rendering), push the
  page into the buffer. If the buffer evicts an old page, mark
  it as `idle` (triggering cleanup).
- Add a `updateVisiblePages(fileId, visiblePageIds[])` action
  called from the IntersectionObserver. This resizes the buffer
  and protects visible pages from eviction. Any newly-visible
  page that is `idle` gets re-queued for rendering.

### Modified: pdf-page.tsx

- Subscribe to `pageStates` to know if this page is `idle` vs
  `rendered`.
- When the page transitions to `idle` (evicted), clear the
  canvas (`canvas.width = 0`) and empty the text layer. Call
  `proxy.cleanup()`.
- When the page transitions from `idle` to `rendering` (re-entered
  viewport), the existing render effect fires and repaints.
- The outer div always renders with correct CSS dimensions
  (already the case via `--total-scale-factor` and original
  width/height), so placeholder behavior is free.

### Modified: use-pdf-current-page.ts

- In the IntersectionObserver callback, call
  `updateVisiblePages()` with the set of currently visible page
  IDs. This drives buffer resizing and re-render queueing.

### Modified: pdf-viewer.tsx

- No structural changes. Pages are still rendered via
  `pageIds.map(...)`. The buffer operates below this level.

## Test Cases

- Open a 100+ page PDF. After initial render completes, only
  ~10 page canvases should exist in the DOM (inspect via
  DevTools: canvases with non-zero dimensions).
- Scroll quickly through the document. Scroll position should
  remain stable (no layout jumps from pages changing size).
- Scroll back to a previously-evicted page. It should re-render
  within a frame or two.
- Text selection across multiple pages should still work for
  pages within the buffer.
- Zoom in/out should re-render visible pages and update the
  buffer accordingly.
- Current page number in the URL should still update correctly
  while scrolling.
- Memory usage (DevTools Performance Monitor) should plateau
  after initial load, not grow linearly with page count.
- Citation overlays on rendered pages should display correctly.
  Evicted pages' citations are hidden (acceptable; they re-appear
  on re-render).

## Open Questions

- Should the buffer size be configurable (e.g., via a constant
  in `lib/limits.ts`) or hardcoded to 10? Mozilla uses 10 as
  default. Suggestion: constant in `lib/limits.ts`, default 10.
- Should we add a visual loading indicator (skeleton/spinner)
  on placeholder pages, or leave them blank like Mozilla does?
