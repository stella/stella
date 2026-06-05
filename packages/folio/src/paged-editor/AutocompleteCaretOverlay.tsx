/**
 * Autocomplete Caret Overlay
 *
 * Paints the inline ghost-text and the streaming "stella" caret
 * badge for the {@link autocompleteSuggestionPlugin}. Like
 * {@link AnonymizationRectsOverlay}, this component lives above
 * the visible paged document because PM decorations attached in
 * folio's hidden editor never reach the visible page DOM. The
 * host (PagedEditor) reads the plugin state, projects the
 * suggestion anchor to a container-relative coordinate via
 * {@link selectionToRects}, and passes it down.
 *
 * The overlay is intentionally passive: it does not subscribe
 * to PM state directly, does not own any caret position math,
 * and never intercepts pointer events. The "stella" badge is
 * a decorative label only — accept/dismiss keybindings live on
 * the editor's keymap, not here.
 */

import React from "react";

export type AutocompleteCaretRect = {
  /** Container-relative pixel x. */
  x: number;
  /** Container-relative pixel y (top of the cursor line). */
  y: number;
  /** Line height in pixels at the anchor. */
  lineHeight: number;
};

export type AutocompleteCaretOverlayProps = {
  /**
   * Position of the autocomplete anchor, projected into the
   * overlay's container space. `null` while idle.
   */
  caret: AutocompleteCaretRect | null;
  /** The full streamed ghost text so far. */
  text: string;
  /** Whether tokens are still arriving from the model. */
  isStreaming: boolean;
};

const overlayStyles: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  zIndex: 1,
};

export const AutocompleteCaretOverlay = ({
  caret,
  text,
  isStreaming,
}: AutocompleteCaretOverlayProps) => {
  if (!caret || text.length === 0) {
    return null;
  }
  return (
    <div style={overlayStyles} data-folio-autocomplete-overlay="">
      <span
        className="folio-autocomplete-ghost"
        style={{
          position: "absolute",
          left: caret.x,
          top: caret.y,
          lineHeight: `${caret.lineHeight}px`,
        }}
      >
        {text}
        <span
          className={
            isStreaming
              ? "folio-autocomplete-caret folio-autocomplete-caret--streaming"
              : "folio-autocomplete-caret"
          }
          aria-hidden="true"
        >
          stella
        </span>
      </span>
    </div>
  );
};
