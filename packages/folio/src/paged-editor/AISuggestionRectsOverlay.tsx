/**
 * AI Suggestion Rects Overlay
 *
 * Paged-editor projection of the `aiSuggestionDecorations` plugin:
 * pending suggestions get their dotted severity underline and the
 * focused suggestion previews its change in the text — the original
 * range reads as deleted (struck through, dimmed behind a translucent
 * wash) and the proposed text renders right after it, exactly like the
 * inline decorations in the non-paged editor.
 *
 * The rect spans reuse the same `.folio-ai-suggestion*` classes; the
 * paged-specific rules in ai-suggestions.css translate text-decoration
 * (which cannot paint on empty overlay rects) into borders/washes from
 * the same single-sourced custom properties. Replacement text longer
 * than the layout gap overlaps the following painted text; acceptable
 * for this transient review-preview state. The host re-projects on
 * every fresh layout so rects track reflow.
 */

import type { CSSProperties } from "react";

import type { AISuggestion } from "../core/ai-suggestions/types";
import type { SelectionRect } from "../core/layout-bridge/selectionRects";
import { AI_SUGGESTION_SEVERITY_CLASS } from "../core/prosemirror/plugins/aiSuggestionDecorations";
import type { ProjectedRunFont } from "./rangeProjection";

export type AISuggestionRectGroup = {
  suggestion: AISuggestion;
  rects: SelectionRect[];
  focused: boolean;
  /** Painted-run text style at the range start, for the replacement chip. */
  font: ProjectedRunFont | null;
};

export type AISuggestionRectsOverlayProps = {
  groups: AISuggestionRectGroup[];
};

const overlayStyles: CSSProperties = {
  position: "absolute",
  top: 0,
  left: "50%",
  width: "100vw",
  height: "100%",
  transform: "translateX(-50%)",
  pointerEvents: "none",
  zIndex: 2,
};

const rectClassName = (suggestion: AISuggestion, focused: boolean): string =>
  [
    "folio-ai-suggestion",
    AI_SUGGESTION_SEVERITY_CLASS[suggestion.severity],
    focused ? "folio-ai-suggestion--focused" : "",
    focused ? "folio-ai-suggestion--focused-original" : "",
  ]
    .filter(Boolean)
    .join(" ");

export const AISuggestionRectsOverlay = ({
  groups,
}: AISuggestionRectsOverlayProps) => {
  if (groups.length === 0) {
    return null;
  }

  return (
    <div style={overlayStyles} data-folio-ai-suggestions-overlay="">
      {groups.map(({ suggestion, rects, focused, font }) => {
        const replacementAnchor = rects.at(-1);
        const showReplacement =
          focused &&
          suggestion.suggestedText.length > 0 &&
          replacementAnchor !== undefined;
        return (
          <span key={suggestion.id}>
            {rects.map((rect, idx) => (
              <span
                key={`r:${idx}`}
                className={rectClassName(suggestion, focused)}
                data-folio-ai-suggestion-id={suggestion.id}
                style={{
                  position: "absolute",
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                }}
              />
            ))}
            {showReplacement && (
              <span
                className="folio-ai-suggestion--focused-replacement"
                data-folio-ai-suggestion-id={suggestion.id}
                style={{
                  position: "absolute",
                  left: replacementAnchor.x + replacementAnchor.width,
                  top: replacementAnchor.y,
                  lineHeight: `${replacementAnchor.height}px`,
                  whiteSpace: "pre",
                  ...(font !== null
                    ? {
                        fontFamily: font.fontFamily,
                        fontSize: font.fontSize,
                        fontWeight: font.fontWeight,
                        fontStyle: font.fontStyle,
                        letterSpacing: font.letterSpacing,
                      }
                    : {}),
                }}
              >
                {suggestion.suggestedText}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
};
