import { load } from "cheerio";

const URL_ATTRIBUTES = new Set([
  "src",
  "href",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "data",
  "cite",
  "background",
  "longdesc",
  "manifest",
]);

export const inspectMcpAppHtml = (html: string): string[] => {
  const document = load(html);
  const issues: string[] = [];
  for (const element of document("*").toArray()) {
    if (
      element.type !== "tag" &&
      element.type !== "script" &&
      element.type !== "style"
    ) {
      continue;
    }
    const tag = element.tagName;
    if (
      (tag === "script" && element.attribs["src"] !== undefined) ||
      (tag === "link" &&
        element.attribs["rel"]?.toLowerCase() === "stylesheet") ||
      tag === "iframe"
    ) {
      issues.push(`External element: ${tag}`);
    }
    for (const [name, value] of Object.entries(element.attribs)) {
      if (
        URL_ATTRIBUTES.has(name) &&
        value !== "" &&
        !value.startsWith("data:")
      ) {
        issues.push(`Non-inline URL: ${tag}[${name}]`);
      }
      if (name === "srcset") {
        issues.push(`External source set: ${tag}`);
      }
      if (
        name === "style" &&
        [...value.matchAll(/url\(\s*["']?([^"')\s]+)/giu)].some(
          (match) => !match[1]?.startsWith("data:"),
        )
      ) {
        issues.push(`Non-inline style URL: ${tag}`);
      }
    }
  }
  return issues;
};
