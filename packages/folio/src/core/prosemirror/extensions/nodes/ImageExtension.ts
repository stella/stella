/**
 * Image Extension — inline/floating image node
 */

import { expectImageAttrs } from "../../attrs";
import type { ImageAttrs } from "../../schema/nodes";
import { createNodeExtension } from "../create";

export const ImageExtension = createNodeExtension({
  name: "image",
  schemaNodeName: "image",
  nodeSpec: {
    inline: true,
    group: "inline",
    draggable: true,
    attrs: {
      src: {},
      alt: { default: null },
      title: { default: null },
      width: { default: null },
      height: { default: null },
      rId: { default: null },
      wrapType: { default: "inline" },
      displayMode: { default: "inline" },
      cssFloat: { default: null },
      transform: { default: null },
      distTop: { default: null },
      distBottom: { default: null },
      distLeft: { default: null },
      distRight: { default: null },
      position: { default: null },
      borderWidth: { default: null },
      borderColor: { default: null },
      borderStyle: { default: null },
      wrapText: { default: null },
      hlinkHref: { default: null },
    },
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs(dom): ImageAttrs {
          const element = dom as HTMLImageElement;
          const alt = element.getAttribute("alt");
          const title = element.getAttribute("title");
          const cssFloat = element.dataset["cssFloat"] as
            | NonNullable<ImageAttrs["cssFloat"]>
            | undefined;
          const borderWidthRaw = element.dataset["borderWidth"];
          return {
            src: element.getAttribute("src") || "",
            ...(alt ? { alt } : {}),
            ...(title ? { title } : {}),
            ...(element.width ? { width: element.width } : {}),
            ...(element.height ? { height: element.height } : {}),
            ...(element.dataset["rid"] ? { rId: element.dataset["rid"] } : {}),
            wrapType:
              (element.dataset["wrapType"] as ImageAttrs["wrapType"]) ||
              "inline",
            displayMode:
              (element.dataset["displayMode"] as ImageAttrs["displayMode"]) ||
              "inline",
            ...(cssFloat ? { cssFloat } : {}),
            ...(element.dataset["transform"]
              ? { transform: element.dataset["transform"] }
              : {}),
            ...(borderWidthRaw ? { borderWidth: Number(borderWidthRaw) } : {}),
            ...(element.dataset["borderColor"]
              ? { borderColor: element.dataset["borderColor"] }
              : {}),
            ...(element.dataset["borderStyle"]
              ? { borderStyle: element.dataset["borderStyle"] }
              : {}),
          };
        },
      },
    ],
    toDOM(node) {
      const attrs = expectImageAttrs(node);
      const domAttrs: Record<string, string> = {
        src: attrs.src,
        class: "docx-image",
      };

      if (attrs.alt) {
        domAttrs["alt"] = attrs.alt;
      }
      if (attrs.title) {
        domAttrs["title"] = attrs.title;
      }
      if (attrs.rId) {
        domAttrs["data-rid"] = attrs.rId;
      }
      if (attrs.wrapType) {
        domAttrs["data-wrap-type"] = attrs.wrapType;
      }
      if (attrs.displayMode) {
        domAttrs["data-display-mode"] = attrs.displayMode;
      }
      if (attrs.cssFloat) {
        domAttrs["data-css-float"] = attrs.cssFloat;
      }
      if (attrs.transform) {
        domAttrs["data-transform"] = attrs.transform;
      }
      if (attrs.borderWidth) {
        domAttrs["data-border-width"] = String(attrs.borderWidth);
      }
      if (attrs.borderColor) {
        domAttrs["data-border-color"] = attrs.borderColor;
      }
      if (attrs.borderStyle) {
        domAttrs["data-border-style"] = attrs.borderStyle;
      }

      const styles: string[] = [];

      if (attrs.width) {
        domAttrs["width"] = String(attrs.width);
        styles.push(`width: ${attrs.width}px`);
      }
      if (attrs.height) {
        domAttrs["height"] = String(attrs.height);
        styles.push(`height: ${attrs.height}px`);
      }

      styles.push("max-width: 100%");

      if (attrs.width && attrs.height) {
        styles.push("object-fit: contain");
      } else {
        styles.push("height: auto");
      }

      if (
        attrs.displayMode === "float" &&
        attrs.cssFloat &&
        attrs.cssFloat !== "none"
      ) {
        styles.push(`float: ${attrs.cssFloat}`);
        domAttrs["class"] +=
          ` docx-image-float docx-image-float-${attrs.cssFloat}`;

        const marginTop = attrs.distTop ?? 0;
        const marginBottom = attrs.distBottom ?? 0;
        const marginLeft = attrs.distLeft ?? 0;
        const marginRight = attrs.distRight ?? 0;

        if (attrs.cssFloat === "left") {
          styles.push(
            `margin: ${marginTop}px ${marginRight || 12}px ${marginBottom}px ${marginLeft}px`,
          );
        } else {
          styles.push(
            `margin: ${marginTop}px ${marginRight}px ${marginBottom}px ${marginLeft || 12}px`,
          );
        }
      } else if (attrs.displayMode === "block") {
        styles.push("display: block");
        styles.push("margin-left: auto");
        styles.push("margin-right: auto");
        domAttrs["class"] += " docx-image-block";

        const marginTop = attrs.distTop ?? 0;
        const marginBottom = attrs.distBottom ?? 0;
        if (marginTop > 0) {
          styles.push(`margin-top: ${marginTop}px`);
        }
        if (marginBottom > 0) {
          styles.push(`margin-bottom: ${marginBottom}px`);
        }
      }

      if (attrs.transform) {
        styles.push(`transform: ${attrs.transform}`);
      }

      if (attrs.borderWidth && attrs.borderWidth > 0) {
        const bStyle = attrs.borderStyle || "solid";
        const bColor = attrs.borderColor || "#000000";
        styles.push(`border: ${attrs.borderWidth}px ${bStyle} ${bColor}`);
      }

      domAttrs["style"] = styles.join("; ");

      return ["img", domAttrs];
    },
  },
});
