/**
 * SDT Extension — inline content control node (Structured Document Tag)
 *
 * Represents OOXML inline SDTs as an inline node wrapping text content.
 * Supports: richText, plainText, date, dropdown, comboBox, checkbox.
 */

import { expectSdtAttrs } from "../../attrs";
import { createNodeExtension } from "../create";

export const SdtExtension = createNodeExtension({
  name: "sdt",
  schemaNodeName: "sdt",
  nodeSpec: {
    inline: true,
    group: "inline",
    content: "inline*",
    attrs: {
      /** SDT type: richText, plainText, date, dropdown, comboBox, checkbox, etc. */
      sdtType: { default: "richText" },
      /** Alias (friendly name) */
      alias: { default: null },
      /** Tag (developer identifier) */
      tag: { default: null },
      /** Lock setting */
      lock: { default: null },
      /** Placeholder text */
      placeholder: { default: null },
      /** Whether showing placeholder */
      showingPlaceholder: { default: false },
      /** Date format for date controls */
      dateFormat: { default: null },
      /** Dropdown/combobox list items as JSON string */
      listItems: { default: null },
      /** Checkbox checked state */
      checked: { default: null },
    },
    parseDOM: [
      {
        tag: "span.docx-sdt",
        getAttrs(dom) {
          if (!(dom instanceof HTMLElement)) {
            return false;
          }
          const el = dom;
          return {
            sdtType: el.dataset["sdtType"] || "richText",
            alias: el.dataset["alias"] || null,
            tag: el.dataset["tag"] || null,
            lock: el.dataset["lock"] || null,
            placeholder: el.dataset["placeholder"] || null,
            showingPlaceholder: el.dataset["showingPlaceholder"] === "true",
            dateFormat: el.dataset["dateFormat"] || null,
            listItems: el.dataset["listItems"] || null,
            checked: (() => {
              if (el.dataset["checked"] === "true") {
                return true;
              }
              if (el.dataset["checked"] === "false") {
                return false;
              }
              return null;
            })(),
          };
        },
      },
    ],
    toDOM(node) {
      const attrs = expectSdtAttrs(node);
      const dataAttrs: Record<string, string> = {
        class: `docx-sdt docx-sdt-${attrs.sdtType}`,
        "data-sdt-type": attrs.sdtType,
      };

      if (attrs.alias) {
        dataAttrs["data-alias"] = attrs.alias;
      }
      if (attrs.tag) {
        dataAttrs["data-tag"] = attrs.tag;
      }
      if (attrs.lock) {
        dataAttrs["data-lock"] = attrs.lock;
      }
      if (attrs.placeholder) {
        dataAttrs["data-placeholder"] = attrs.placeholder;
      }
      if (attrs.showingPlaceholder) {
        dataAttrs["data-showing-placeholder"] = "true";
      }
      if (attrs.dateFormat) {
        dataAttrs["data-date-format"] = attrs.dateFormat;
      }
      if (attrs.listItems) {
        dataAttrs["data-list-items"] = attrs.listItems;
      }
      if (attrs.checked !== undefined) {
        dataAttrs["data-checked"] = String(attrs.checked);
      }

      // Checkbox renders with a checkbox-like indicator
      if (attrs.sdtType === "checkbox") {
        dataAttrs["style"] =
          "border: 1px solid #ccc; border-radius: 3px; padding: 0 2px; display: inline;";
      } else {
        dataAttrs["style"] =
          "border-bottom: 1px dashed #999; padding: 0 1px; display: inline;";
      }

      return ["span", dataAttrs, 0];
    },
  },
});
