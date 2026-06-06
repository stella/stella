/**
 * TextBox Extension — editable text box node
 *
 * An isolating block node that contains paragraphs (and tables).
 * Rendered as a positioned container with optional fill, outline, and margins.
 * Supports inline and floating positioning.
 */

import type { ImageWrap } from "../../../types/document";
import {
  IMAGE_WRAP_TYPE_VALUES,
  type OutlineStyleAttr,
} from "../../../types/documentEnumValues";
import { expectTextBoxAttrs } from "../../attrs";
import type { ImagePositionAttrs } from "../../schema/nodes";
import { createNodeExtension } from "../create";

export type TextBoxAttrs = {
  /** Width in pixels */
  width?: number;
  /** Height in pixels */
  height?: number;
  /** Unique identifier */
  textBoxId?: string;
  /** Fill color as CSS color */
  fillColor?: string;
  /** Outline width in pixels */
  outlineWidth?: number;
  /** Outline color as CSS color */
  outlineColor?: string;
  /** Outline dash style, or `"none"` for an explicit no-outline. */
  outlineStyle?: OutlineStyleAttr;
  /** Internal margin top in pixels */
  marginTop?: number;
  /** Internal margin bottom in pixels */
  marginBottom?: number;
  /** Internal margin left in pixels */
  marginLeft?: number;
  /** Internal margin right in pixels */
  marginRight?: number;
  /** Vertical text alignment */
  verticalAlign?: string;
  /** Display mode */
  displayMode?: "inline" | "float" | "block";
  /** CSS float direction */
  cssFloat?: "left" | "right" | "none";
  /** Wrap type */
  wrapType?: ImageWrap["type"];
  /** OOXML wrapText direction for anchored text boxes (eigenpal #474). */
  wrapText?: "bothSides" | "left" | "right" | "largest";
  /** Wrap distance from top edge, in pixels (OOXML distT, EMU-converted). */
  distTop?: number;
  /** Wrap distance from bottom edge, in pixels. */
  distBottom?: number;
  /** Wrap distance from left edge, in pixels. */
  distLeft?: number;
  /** Wrap distance from right edge, in pixels. */
  distRight?: number;
  /** Position for floating/anchored text boxes. */
  position?: ImagePositionAttrs;
  /** Original DOCX placement hint for save-path reconstruction. */
  _docxPlacement?: "standalone" | "inlineWithPrevious";
  /** Original DOCX paragraph group for standalone text-box reconstruction. */
  _docxGroupId?: string;
};

function parseTextBoxPosition(
  raw: string | undefined,
): ImagePositionAttrs | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }
    return parsed as ImagePositionAttrs;
  } catch {
    return undefined;
  }
}

function parseTextBoxWrapType(
  raw: string | undefined,
): ImageWrap["type"] | undefined {
  for (const value of IMAGE_WRAP_TYPE_VALUES) {
    if (value === raw) {
      return value;
    }
  }
  return undefined;
}

export const TextBoxExtension = createNodeExtension({
  name: "textBox",
  schemaNodeName: "textBox",
  nodeSpec: {
    group: "block",
    content: "(paragraph | table)+",
    isolating: true,
    draggable: true,
    attrs: {
      width: { default: 200 },
      height: { default: null },
      textBoxId: { default: null },
      fillColor: { default: null },
      outlineWidth: { default: null },
      outlineColor: { default: null },
      outlineStyle: { default: null },
      marginTop: { default: 4 },
      marginBottom: { default: 4 },
      marginLeft: { default: 7 },
      marginRight: { default: 7 },
      verticalAlign: { default: null },
      displayMode: { default: "inline" },
      cssFloat: { default: null },
      wrapType: { default: "inline" },
      wrapText: { default: null },
      distTop: { default: null },
      distBottom: { default: null },
      distLeft: { default: null },
      distRight: { default: null },
      position: { default: null },
      _docxPlacement: { default: null },
      _docxGroupId: { default: null },
    },
    parseDOM: [
      {
        tag: "div.docx-textbox",
        getAttrs(dom): TextBoxAttrs | false {
          if (!(dom instanceof HTMLElement)) {
            return false;
          }
          const el = dom;
          const d = el.dataset;
          const position = parseTextBoxPosition(d["position"]);
          const wrapType = parseTextBoxWrapType(d["wrapType"]);
          return {
            ...(d["width"] ? { width: Number(d["width"]) } : {}),
            ...(d["height"] ? { height: Number(d["height"]) } : {}),
            ...(d["textboxId"] ? { textBoxId: d["textboxId"] } : {}),
            ...(d["fillColor"] ? { fillColor: d["fillColor"] } : {}),
            ...(d["outlineWidth"]
              ? { outlineWidth: Number(d["outlineWidth"]) }
              : {}),
            ...(d["outlineColor"] ? { outlineColor: d["outlineColor"] } : {}),
            ...(d["outlineStyle"]
              ? {
                  outlineStyle: d["outlineStyle"] as NonNullable<
                    TextBoxAttrs["outlineStyle"]
                  >,
                }
              : {}),
            ...(d["marginTop"] ? { marginTop: Number(d["marginTop"]) } : {}),
            ...(d["marginBottom"]
              ? { marginBottom: Number(d["marginBottom"]) }
              : {}),
            ...(d["marginLeft"] ? { marginLeft: Number(d["marginLeft"]) } : {}),
            ...(d["marginRight"]
              ? { marginRight: Number(d["marginRight"]) }
              : {}),
            ...(d["verticalAlign"]
              ? { verticalAlign: d["verticalAlign"] }
              : {}),
            ...(d["displayMode"]
              ? {
                  displayMode: d["displayMode"] as NonNullable<
                    TextBoxAttrs["displayMode"]
                  >,
                }
              : {}),
            ...(d["cssFloat"]
              ? {
                  cssFloat: d["cssFloat"] as NonNullable<
                    TextBoxAttrs["cssFloat"]
                  >,
                }
              : {}),
            ...(wrapType ? { wrapType } : {}),
            ...(d["wrapText"]
              ? {
                  wrapText: d["wrapText"] as NonNullable<
                    TextBoxAttrs["wrapText"]
                  >,
                }
              : {}),
            ...(d["distTop"] ? { distTop: Number(d["distTop"]) } : {}),
            ...(d["distBottom"] ? { distBottom: Number(d["distBottom"]) } : {}),
            ...(d["distLeft"] ? { distLeft: Number(d["distLeft"]) } : {}),
            ...(d["distRight"] ? { distRight: Number(d["distRight"]) } : {}),
            ...(position ? { position } : {}),
          };
        },
      },
    ],
    toDOM(node) {
      const attrs = expectTextBoxAttrs(node);
      const domAttrs: Record<string, string> = {
        class: "docx-textbox",
      };

      // Data attributes for round-trip
      if (attrs.width) {
        domAttrs["data-width"] = String(attrs.width);
      }
      if (attrs.height) {
        domAttrs["data-height"] = String(attrs.height);
      }
      if (attrs.textBoxId) {
        domAttrs["data-textbox-id"] = attrs.textBoxId;
      }
      if (attrs.fillColor) {
        domAttrs["data-fill-color"] = attrs.fillColor;
      }
      if (attrs.outlineWidth) {
        domAttrs["data-outline-width"] = String(attrs.outlineWidth);
      }
      if (attrs.outlineColor) {
        domAttrs["data-outline-color"] = attrs.outlineColor;
      }
      if (attrs.outlineStyle) {
        domAttrs["data-outline-style"] = attrs.outlineStyle;
      }
      if (typeof attrs.marginTop === "number") {
        domAttrs["data-margin-top"] = String(attrs.marginTop);
      }
      if (typeof attrs.marginBottom === "number") {
        domAttrs["data-margin-bottom"] = String(attrs.marginBottom);
      }
      if (typeof attrs.marginLeft === "number") {
        domAttrs["data-margin-left"] = String(attrs.marginLeft);
      }
      if (typeof attrs.marginRight === "number") {
        domAttrs["data-margin-right"] = String(attrs.marginRight);
      }
      if (attrs.verticalAlign) {
        domAttrs["data-vertical-align"] = attrs.verticalAlign;
      }
      if (attrs.displayMode) {
        domAttrs["data-display-mode"] = attrs.displayMode;
      }
      if (attrs.cssFloat) {
        domAttrs["data-css-float"] = attrs.cssFloat;
      }
      if (attrs.wrapType) {
        domAttrs["data-wrap-type"] = attrs.wrapType;
      }
      if (attrs.wrapText) {
        domAttrs["data-wrap-text"] = attrs.wrapText;
      }
      if (typeof attrs.distTop === "number") {
        domAttrs["data-dist-top"] = String(attrs.distTop);
      }
      if (typeof attrs.distBottom === "number") {
        domAttrs["data-dist-bottom"] = String(attrs.distBottom);
      }
      if (typeof attrs.distLeft === "number") {
        domAttrs["data-dist-left"] = String(attrs.distLeft);
      }
      if (typeof attrs.distRight === "number") {
        domAttrs["data-dist-right"] = String(attrs.distRight);
      }
      if (attrs.position) {
        domAttrs["data-position"] = JSON.stringify(attrs.position);
      }

      // Build inline styles
      const styles: string[] = [];

      if (attrs.width) {
        styles.push(`width: ${attrs.width}px`);
      }
      if (attrs.height) {
        styles.push(`min-height: ${attrs.height}px`);
      }

      // Background
      if (attrs.fillColor) {
        styles.push(`background-color: ${attrs.fillColor}`);
      }

      // Border/outline. `outlineStyle === "none"` is the explicit no-outline
      // sentinel: skip even the default editor border so it stays border-free
      // like its export.
      if (attrs.outlineWidth && attrs.outlineWidth > 0) {
        const style = attrs.outlineStyle || "solid";
        const color = attrs.outlineColor || "#000000";
        styles.push(`border: ${attrs.outlineWidth}px ${style} ${color}`);
      } else if (attrs.outlineStyle !== "none") {
        // Default thin border for text boxes
        styles.push("border: 1px solid var(--doc-border, #d1d5db)");
      }

      // Internal margins/padding
      const mt = attrs.marginTop ?? 4;
      const mb = attrs.marginBottom ?? 4;
      const ml = attrs.marginLeft ?? 7;
      const mr = attrs.marginRight ?? 7;
      styles.push(`padding: ${mt}px ${mr}px ${mb}px ${ml}px`);

      // Vertical alignment
      if (
        attrs.verticalAlign === "middle" ||
        attrs.verticalAlign === "center"
      ) {
        styles.push("display: flex");
        styles.push("flex-direction: column");
        styles.push("justify-content: center");
      } else if (attrs.verticalAlign === "bottom") {
        styles.push("display: flex");
        styles.push("flex-direction: column");
        styles.push("justify-content: flex-end");
      }

      // Float/positioning
      if (
        attrs.displayMode === "float" &&
        attrs.cssFloat &&
        attrs.cssFloat !== "none"
      ) {
        styles.push(`float: ${attrs.cssFloat}`);
        styles.push("margin: 4px 8px");
      } else if (attrs.displayMode === "block") {
        styles.push("margin-left: auto");
        styles.push("margin-right: auto");
      }

      // Box sizing
      styles.push("box-sizing: border-box");
      styles.push("overflow: hidden");
      styles.push("position: relative");

      domAttrs["style"] = styles.join("; ");

      return ["div", domAttrs, 0];
    },
  },
});
