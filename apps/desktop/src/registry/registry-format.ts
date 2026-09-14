import { panic } from "better-result";

import { parseRegistryFormatMarkdown } from "@stll/business-registries/default-formats";

const escapeHtml = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "<br>");

/**
 * An inline HTML fragment for the pasteboard: rich targets keep the emphasis of
 * a company specification. No document wrapper is needed; the fragment travels
 * next to the plain-text representation of the same item.
 */
export const registryFormatHtml = (rendered: string): string =>
  parseRegistryFormatMarkdown(rendered)
    .map(({ text, style }) => {
      const escaped = escapeHtml(text);
      switch (style) {
        case "bold":
          return `<strong>${escaped}</strong>`;
        case "italic":
          return `<em>${escaped}</em>`;
        case "plain":
          return escaped;
        default:
          style satisfies never;
          return panic(`Unknown registry format run style: ${String(style)}`);
      }
    })
    .join("");
