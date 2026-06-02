/**
 * BlockSdt Extension — block-level content control node.
 *
 * Mirrors OOXML's block `w:sdt` wrapping paragraphs/tables. `isolating: true`
 * keeps user edits scoped to the control (a backspace at the start of an
 * inner paragraph cannot merge through the boundary into a sibling), and
 * `defining: true` preserves the wrapper across split/lift.
 *
 * Attributes:
 * - `sdtType` / `alias` / `tag` / `lock` / `placeholder` /
 *   `showingPlaceholder` / `dateFormat` / `listItems` / `checked` — modeled
 *   projection of `w:sdtPr`; drives addressing and widget UX.
 * - `rawPropertiesXml` / `rawEndPropertiesXml` — verbatim original strings
 *   so unmodeled OOXML features (`w:dataBinding`, `w15:repeatingSection`,
 *   etc.) round-trip without being enumerated here.
 */

import { createNodeExtension } from "../create";

export const BlockSdtExtension = createNodeExtension({
  name: "blockSdt",
  schemaNodeName: "blockSdt",
  nodeSpec: {
    group: "block",
    content: "block+",
    isolating: true,
    defining: true,
    attrs: {
      sdtType: { default: "richText" },
      alias: { default: null },
      tag: { default: null },
      id: { default: null },
      lock: { default: null },
      placeholder: { default: null },
      showingPlaceholder: { default: false },
      dateFormat: { default: null },
      listItems: { default: null },
      checked: { default: null },
      rawPropertiesXml: { default: null },
      rawEndPropertiesXml: { default: null },
    },
    parseDOM: [
      {
        tag: "div.docx-block-sdt",
        getAttrs(dom) {
          if (!(dom instanceof HTMLElement)) {
            return false;
          }
          const checkedRaw = dom.dataset["checked"];
          let checked: boolean | null = null;
          if (checkedRaw === "true") {
            checked = true;
          } else if (checkedRaw === "false") {
            checked = false;
          }
          const idRaw = dom.dataset["sdtId"];
          const id = idRaw ? Number.parseInt(idRaw, 10) : null;
          return {
            sdtType: dom.dataset["sdtType"] ?? "richText",
            alias: dom.dataset["alias"] ?? null,
            tag: dom.dataset["tag"] ?? null,
            id: id !== null && !Number.isNaN(id) ? id : null,
            lock: dom.dataset["lock"] ?? null,
            placeholder: dom.dataset["placeholder"] ?? null,
            showingPlaceholder: dom.dataset["showingPlaceholder"] === "true",
            dateFormat: dom.dataset["dateFormat"] ?? null,
            listItems: dom.dataset["listItems"] ?? null,
            checked,
            // Raw XML is preserved on the model, not the DOM; consumers that
            // round-trip through PM must re-attach it from the source.
            rawPropertiesXml: null,
            rawEndPropertiesXml: null,
          };
        },
      },
    ],
    toDOM(node) {
      const attrs = node.attrs;
      const data: Record<string, string> = {
        class: `docx-block-sdt docx-block-sdt-${String(attrs["sdtType"])}`,
        "data-sdt-type": String(attrs["sdtType"]),
      };
      if (attrs["alias"]) {
        data["data-alias"] = String(attrs["alias"]);
      }
      if (attrs["tag"]) {
        data["data-tag"] = String(attrs["tag"]);
      }
      if (attrs["id"] !== null && attrs["id"] !== undefined) {
        data["data-sdt-id"] = String(attrs["id"]);
      }
      if (attrs["lock"]) {
        data["data-lock"] = String(attrs["lock"]);
      }
      if (attrs["placeholder"]) {
        data["data-placeholder"] = String(attrs["placeholder"]);
      }
      if (attrs["showingPlaceholder"]) {
        data["data-showing-placeholder"] = "true";
      }
      if (attrs["dateFormat"]) {
        data["data-date-format"] = String(attrs["dateFormat"]);
      }
      if (attrs["listItems"]) {
        data["data-list-items"] = String(attrs["listItems"]);
      }
      if (attrs["checked"] !== null && attrs["checked"] !== undefined) {
        data["data-checked"] = String(attrs["checked"]);
      }
      return ["div", data, 0];
    },
  },
});
