import { load } from "cheerio";
import { isTag } from "domhandler";

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

const decodeCssToken = (token: string): string =>
  token
    .replace(/\\(?:\r\n|[\r\n\f])/gu, "")
    .replace(
      /\\([\da-f]{1,6})[\t\n\f\r ]?|\\([^\r\n\f])/giu,
      (_, hex: string | undefined, literal: string | undefined) => {
        if (hex === undefined) {
          return literal ?? "";
        }
        const codePoint = Number.parseInt(hex, 16);
        return codePoint === 0 || codePoint > 0x10_ff_ff
          ? "�"
          : String.fromCodePoint(codePoint);
      },
    );

const startsInline = (value: string): boolean =>
  /^\s*["']?\s*data:/iu.test(value);

/**
 * Fails closed: every reference-shaped construct counts, even inside a CSS
 * string or comment. The guard checks our own built apps, so a false positive
 * only fails the build.
 */
const hasExternalCssReference = (css: string): boolean => {
  const decoded = decodeCssToken(css);
  if (/@import/iu.test(decoded)) {
    return true;
  }
  for (const match of decoded.matchAll(/(?:url|src)\s*\(/giu)) {
    if (!startsInline(decoded.slice(match.index + match[0].length))) {
      return true;
    }
  }
  // Every string from the first image-set on must be inline.
  const imageSet = /image-set\s*\(/iu.exec(decoded);
  if (imageSet === null) {
    return false;
  }
  for (const [, double, single] of decoded
    .slice(imageSet.index)
    .matchAll(/"([^"]*)"?|'([^']*)'?/gu)) {
    if (!startsInline(double ?? single ?? "")) {
      return true;
    }
  }
  return false;
};

export const inspectMcpAppHtml = (html: string): string[] => {
  const document = load(html);
  const issues: string[] = [];
  for (const element of document("*").toArray()) {
    if (!isTag(element)) {
      continue;
    }
    const tag = element.tagName;
    if (tag === "style" && hasExternalCssReference(document(element).text())) {
      issues.push("Non-inline stylesheet URL: style");
    }
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
      if (name === "style" && hasExternalCssReference(value)) {
        issues.push(`Non-inline style URL: ${tag}`);
      }
    }
  }
  return issues;
};
