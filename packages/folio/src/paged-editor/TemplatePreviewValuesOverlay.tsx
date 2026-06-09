/**
 * Template Preview Values Overlay
 *
 * Paged-editor projection of the live fill preview: the hidden
 * editor's `templatePreviewValues` plugin hides each matched
 * `{{marker}}` and injects the typed value as decorations, but PM
 * decorations never reach the painted pages. This overlay re-creates
 * the substitution on the paged canvas: an opaque page-background
 * cover hides the painted marker text and the value renders at the
 * marker's first rect, styled by the same `.folio-template-preview-*`
 * classes the inline decorations use.
 *
 * Unlike the directive overlay (a translucent tint that tolerates
 * reflow misalignment), the covers here are deliberately opaque — the
 * preview's whole point is replacing the marker. The host re-projects
 * on every fresh layout, so covers track reflow the same way the
 * selection overlay does. Values longer than their marker overlap the
 * following painted text; acceptable for this transient preview state.
 *
 * Appearance lives in editor.css; only positioning (and the sampled
 * run font, so the value matches the surrounding text) is inline.
 */

import type { CSSProperties } from "react";

import type { SelectionRect } from "../core/layout-bridge/selectionRects";
import type {
  TemplatePreviewEntry,
  TemplatePreviewValues,
} from "../core/prosemirror/plugins/templatePreviewValues";
import type { ProjectedRunFont } from "./rangeProjection";

export type TemplatePreviewRectGroup = {
  entry: TemplatePreviewEntry;
  rects: SelectionRect[];
  /** Painted-run text style at the marker, when its DOM is rendered. */
  font: ProjectedRunFont | null;
};

export type TemplatePreviewValuesOverlayProps = {
  groups: TemplatePreviewRectGroup[];
  mode: TemplatePreviewValues["mode"];
};

const overlayStyles: CSSProperties = {
  position: "absolute",
  top: 0,
  left: "50%",
  width: "100vw",
  height: "100%",
  transform: "translateX(-50%)",
  pointerEvents: "none",
  // Same layer as the directives overlay; this one renders later in
  // the DOM so the covers hide the marker tint underneath, mirroring
  // how the inline preview supersedes the raw marker visual.
  zIndex: 10,
};

export const TemplatePreviewValuesOverlay = ({
  groups,
  mode,
}: TemplatePreviewValuesOverlayProps) => {
  if (groups.length === 0) {
    return null;
  }

  const valueClassName =
    mode === "highlighted"
      ? "folio-template-preview-value folio-template-preview-value--highlighted"
      : "folio-template-preview-value";

  return (
    <div style={overlayStyles} data-folio-template-preview-overlay="">
      {groups.map(({ entry, rects, font }, groupIdx) => {
        const anchor = rects.at(0);
        if (!anchor) {
          return null;
        }
        return (
          <span key={`p:${groupIdx}:${entry.expr}:${entry.from}`}>
            {rects.map((rect, idx) => (
              <span
                key={`c:${idx}`}
                className="folio-template-preview-cover"
                style={{
                  left: rect.x,
                  top: rect.y,
                  width: rect.width,
                  height: rect.height,
                }}
              />
            ))}
            <span
              className={valueClassName}
              style={{
                position: "absolute",
                left: anchor.x,
                top: anchor.y,
                lineHeight: `${anchor.height}px`,
                whiteSpace: "pre",
                ...(font !== null
                  ? {
                      fontFamily: font.fontFamily,
                      fontSize: font.fontSize,
                      fontWeight: font.fontWeight,
                      fontStyle: font.fontStyle,
                      letterSpacing: font.letterSpacing,
                      color: font.color,
                    }
                  : {}),
              }}
            >
              {entry.value}
            </span>
          </span>
        );
      })}
    </div>
  );
};
