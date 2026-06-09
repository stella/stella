/**
 * Scroll the visible paged layout to a ProseMirror position.
 *
 * The paged editor's editing PM view is hidden off-screen
 * (HiddenProseMirror); only the painted pages are visible. Scrolling
 * therefore cannot use `view.coordsAtPos` — those coordinates belong
 * to the hidden, unpaginated mirror, not the pages the user sees.
 * This module owns the painted-DOM scroll path: per-run anchors when
 * the target is in the rendered buffer, page shells (always present
 * under virtualization) when it is not.
 *
 * `PagedEditor` delegates its `scrollToPosition` ref method here;
 * external hosts that only hold the hidden `EditorView` (e.g. the AI
 * suggestion thread) use {@link scrollFolioPositionIntoView}.
 */

import type { EditorView } from "prosemirror-view";

import {
  findBodyPmAnchor,
  findBodyPmAnchors,
} from "../core/layout-bridge/findBodyPmSpans";
import { findPageShellForPmPos } from "../core/layout-painter/renderPage";
import {
  isValidPmScrollPosition,
  prefersReducedMotionBehavior,
} from "./scrollNavigation";

/** Class on the pages container `PagedEditor` paints into. */
export const PAGES_CONTAINER_CLASS = "paged-editor__pages";

/** Scroll visible pages to a ProseMirror position. */
export const scrollPagesToPmPosition = (
  pageContainer: HTMLElement,
  pmPos: number,
): void => {
  if (!isValidPmScrollPosition(pmPos)) {
    return;
  }

  // Phase 1: locate the target via per-run DOM if it's already
  // rendered, otherwise via the page shell (always present
  // under virtualization). The shell-based path was added to
  // fix the "many clicks to arrive" bug — a per-run query on a
  // virtualized doc only sees runs in the currently-rendered
  // buffer, so each click stepped one buffer-width forward
  // instead of jumping straight to the target.
  const exact = findBodyPmAnchor(pageContainer, pmPos);
  if (exact) {
    exact.scrollIntoView({
      behavior: prefersReducedMotionBehavior(),
      block: "center",
    });
    return;
  }

  // Walk all currently-rendered runs to see if pmPos falls
  // inside one of them (block-node positions never match
  // exactly but usually live inside a known run).
  let runMatch: HTMLElement | null = null;
  for (const el of findBodyPmAnchors(pageContainer)) {
    const start = Number(el.dataset["pmStart"]);
    if (Number.isNaN(start)) {
      continue;
    }
    const endAttr = el.dataset["pmEnd"];
    const end = endAttr === undefined ? start : Number(endAttr);
    if (start <= pmPos && pmPos <= end) {
      runMatch = el;
      break;
    }
  }
  if (runMatch) {
    runMatch.scrollIntoView({
      behavior: prefersReducedMotionBehavior(),
      block: "center",
    });
    return;
  }

  // Target lives outside the rendered buffer. Scroll to its
  // page shell (which exists with correct dimensions even when
  // empty), then refine to the exact run once the
  // IntersectionObserver populates the page content.
  //
  // TODO: when the AI review session opens, pre-warm the page
  // shells that contain pending suggestions (one-shot
  // populate of ~30 pages instead of 200). Lets this scroll
  // become single-phase again — no rAF refine — and makes
  // navigation feel instant for long documents.
  const shellHit = findPageShellForPmPos(pageContainer, pmPos);
  if (!shellHit) {
    return;
  }
  const { element: shell } = shellHit;
  shell.scrollIntoView({
    behavior: prefersReducedMotionBehavior(),
    block: "center",
  });

  let attempts = 0;
  const refine = () => {
    attempts++;
    const exactInShell = findBodyPmAnchor(shell, pmPos);
    if (exactInShell) {
      exactInShell.scrollIntoView({
        behavior: prefersReducedMotionBehavior(),
        block: "center",
      });
      return;
    }
    let bestEl: HTMLElement | null = null;
    let bestStart = Number.NEGATIVE_INFINITY;
    for (const el of findBodyPmAnchors(shell)) {
      const start = Number(el.dataset["pmStart"]);
      if (Number.isNaN(start)) {
        continue;
      }
      const endAttr = el.dataset["pmEnd"];
      const end = endAttr === undefined ? start : Number(endAttr);
      if (start <= pmPos && pmPos <= end) {
        bestEl = el;
        break;
      }
      if (start <= pmPos && start > bestStart) {
        bestStart = start;
        bestEl = el;
      }
    }
    if (bestEl) {
      bestEl.scrollIntoView({
        behavior: prefersReducedMotionBehavior(),
        block: "center",
      });
      return;
    }
    // IntersectionObserver populates on the next tick; give it
    // a few frames before giving up. ~20 frames covers slow
    // initial paint on long pages without spinning indefinitely
    // if the page genuinely has no run at this position.
    if (attempts < 20) {
      requestAnimationFrame(refine);
    }
  };
  requestAnimationFrame(refine);
};

/**
 * Scroll the paged layout that mirrors `view` so `pmPos` is centered
 * in the viewport. The hidden editing view sits inside the editor's
 * scroll container, so the painted pages are reachable from its DOM.
 * Returns false when no paged layout is found (non-paged host) so
 * callers can fall back to coordinate-based scrolling.
 */
export const scrollFolioPositionIntoView = (
  view: EditorView,
  pmPos: number,
): boolean => {
  const scrollContainer = view.dom.closest("[data-folio-scroll]");
  const pageContainer =
    scrollContainer?.querySelector<HTMLElement>(`.${PAGES_CONTAINER_CLASS}`) ??
    null;
  if (!pageContainer) {
    return false;
  }
  scrollPagesToPmPosition(pageContainer, pmPos);
  return true;
};
