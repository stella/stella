/**
 * Math Extension — inline/block math equation node (OMML)
 *
 * Represents Office Math Markup Language equations as atomic nodes.
 * Stores the raw OMML XML for round-trip fidelity and shows a plain
 * text fallback in the editor.
 */

import { createNodeExtension } from "../create";

export const MathExtension = createNodeExtension({
  name: "math",
  schemaNodeName: "math",
  nodeSpec: {
    inline: true,
    group: "inline",
    atom: true,
    selectable: true,
    attrs: {
      /** Whether this is a block (oMathPara) or inline (oMath) equation */
      display: { default: "inline" },
      /** Raw OMML XML for round-trip preservation */
      ommlXml: { default: "" },
      /** Plain text representation for fallback display */
      plainText: { default: "" },
    },
    parseDOM: [
      {
        tag: "span.docx-math",
        getAttrs(dom) {
          return {
            display: dom.dataset["display"] ?? "inline",
            ommlXml: dom.dataset["ommlXml"] ?? "",
            plainText: dom.textContent ?? "",
          };
        },
      },
    ],
    toDOM(node) {
      // SAFETY: Math node attrs always match this shape per schema
      const display = String(node.attrs["display"]);
      const ommlXml = String(node.attrs["ommlXml"]);
      const plainText = String(node.attrs["plainText"]);

      const text = plainText || "[equation]";

      return [
        "span",
        {
          class: `docx-math docx-math-${display}`,
          "data-display": display,
          "data-omml-xml": ommlXml,
          style:
            'font-style: italic; font-family: "Cambria Math", "Latin Modern Math", serif; ' +
            "background: rgba(200,200,255,0.1); padding: 0 2px; border-radius: 2px;",
        },
        text,
      ];
    },
  },
});
