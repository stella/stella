import { Result, TaggedError } from "better-result";
import { load } from "cheerio";
import { isTag } from "domhandler";
import * as v from "valibot";

import {
  VISUAL_SANDBOX_LIMITS,
  visualLinkSchema,
} from "@stll/api-contract/visual-sandbox";

export class VisualMarkupError extends TaggedError("VisualMarkupError")<{
  message: string;
  reason: "size" | "depth" | "nodes" | "input";
}> {}

const PRESENTATION_TAGS = new Set([
  "a",
  "abbr",
  "article",
  "aside",
  "b",
  "blockquote",
  "br",
  "button",
  "caption",
  "code",
  "col",
  "colgroup",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "i",
  "img",
  "input",
  "label",
  "li",
  "main",
  "mark",
  "ol",
  "option",
  "p",
  "pre",
  "s",
  "script",
  "section",
  "select",
  "small",
  "span",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "textarea",
  "th",
  "thead",
  "time",
  "tr",
  "u",
  "ul",
]);

const PRESENTATION_ATTRIBUTES = new Set([
  "class",
  "id",
  "title",
  "lang",
  "dir",
  "role",
  "aria-label",
  "aria-describedby",
  "aria-labelledby",
]);
const PRESENTATION_PROPERTIES = new Set([
  "color",
  "background-color",
  "border-color",
  "border-width",
  "border-style",
  "border-radius",
  "border-collapse",
  "border-spacing",
  "padding",
  "padding-inline",
  "padding-block",
  "margin",
  "margin-inline",
  "margin-block",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "white-space",
  "overflow-wrap",
  "word-break",
  "vertical-align",
  "display",
  "gap",
  "row-gap",
  "column-gap",
  "flex-direction",
  "flex-wrap",
  "align-items",
  "justify-content",
  "grid-template-columns",
  "grid-column",
  "list-style-type",
]);

// This value language contains no escapes, strings, functions or URL tokens.
const PRESENTATION_VALUE = /^[a-zA-Z0-9#.%\s+-]+$/u;
const DATA_IMAGE =
  /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/u;
const TABLE_ATTRIBUTES = new Set(["colspan", "rowspan", "scope"]);
const INPUT_TYPES = new Set([
  "text",
  "search",
  "number",
  "range",
  "checkbox",
  "radio",
  "date",
  "color",
]);
const CONTROL_ATTRIBUTES = new Set([
  "value",
  "min",
  "max",
  "step",
  "checked",
  "selected",
  "disabled",
]);
const CONTROL_TAGS = new Set([
  "button",
  "input",
  "select",
  "textarea",
  "option",
]);

const sanitizeStyle = (style: string) => {
  const declarations: string[] = [];
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) {
      continue;
    }
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).trim();
    if (
      PRESENTATION_PROPERTIES.has(property) &&
      value.length > 0 &&
      PRESENTATION_VALUE.test(value)
    ) {
      declarations.push(`${property}:${value}`);
    }
  }
  return declarations.join(";");
};

type PresentationAttributeOptions = {
  tag: string;
  name: string;
  value: string;
};

const presentationAttribute = ({
  tag,
  name,
  value,
}: PresentationAttributeOptions) => {
  if (PRESENTATION_ATTRIBUTES.has(name)) {
    return [name, value] as const;
  }
  if (name === "style") {
    const style = sanitizeStyle(value);
    return style ? ([name, style] as const) : null;
  }
  if (tag === "a" && (name === "href" || name === "data-stella-link")) {
    const link = v.safeParse(visualLinkSchema, value);
    return link.success ? (["data-stella-link", link.output] as const) : null;
  }
  if (tag === "img" && name === "src" && DATA_IMAGE.test(value)) {
    return [name, value] as const;
  }
  if (tag === "img" && name === "alt") {
    return [name, value] as const;
  }
  if ((tag === "th" || tag === "td") && TABLE_ATTRIBUTES.has(name)) {
    return [name, value] as const;
  }
  if (tag === "details" && name === "open") {
    return [name, ""] as const;
  }
  if (tag === "label" && name === "for") {
    return [name, value] as const;
  }
  if (CONTROL_TAGS.has(tag) && CONTROL_ATTRIBUTES.has(name)) {
    return [name, value] as const;
  }
  return null;
};

export const sanitizeVisualHtml = (html: string) => {
  if (Buffer.byteLength(html, "utf-8") > VISUAL_SANDBOX_LIMITS.htmlBytes) {
    return Result.err(
      new VisualMarkupError({
        reason: "size",
        message: "Visual markup exceeds the size limit",
      }),
    );
  }
  const $ = load(html);
  const elements = $("*").toArray();
  if (elements.length > VISUAL_SANDBOX_LIMITS.nodes) {
    return Result.err(
      new VisualMarkupError({
        reason: "nodes",
        message: "Visual markup exceeds the element limit",
      }),
    );
  }
  const credentialInput = $("input, textarea, select")
    .toArray()
    .some((element) => {
      if (!isTag(element)) {
        return false;
      }
      return Object.entries(element.attribs).some(
        ([name, value]) =>
          (name === "type" && value.trim().toLowerCase() === "password") ||
          ((name === "name" || name === "id" || name === "autocomplete") &&
            /password|passwd|credential|one-time-code/iu.test(value)),
      );
    });
  if (credentialInput) {
    return Result.err(
      new VisualMarkupError({
        reason: "input",
        message: "Visual markup cannot request credentials",
      }),
    );
  }
  for (const element of elements) {
    let depth = 0;
    let ancestor = element.parent;
    while (ancestor) {
      depth++;
      if (depth > VISUAL_SANDBOX_LIMITS.depth) {
        return Result.err(
          new VisualMarkupError({
            reason: "depth",
            message: "Visual markup exceeds the nesting limit",
          }),
        );
      }
      ancestor = ancestor.parent;
    }
  }
  for (const element of elements) {
    if (!isTag(element)) {
      continue;
    }
    const tag = element.name;
    if (tag === "html" || tag === "head" || tag === "body") {
      continue;
    }
    if (
      !PRESENTATION_TAGS.has(tag) ||
      (element.namespace &&
        element.namespace !== "http://www.w3.org/1999/xhtml")
    ) {
      $(element).remove();
      continue;
    }
    if (
      tag === "script" &&
      element.attribs["type"] &&
      element.attribs["type"].toLowerCase() !== "text/javascript"
    ) {
      $(element).remove();
      continue;
    }
    const inputType = (element.attribs["type"] ?? "text").trim().toLowerCase();
    if (tag === "input" && !INPUT_TYPES.has(inputType)) {
      $(element).remove();
      continue;
    }
    const attributes = new Map<string, string>();
    for (const [name, value] of Object.entries(element.attribs)) {
      const attribute = presentationAttribute({ tag, name, value });
      if (attribute) {
        attributes.set(...attribute);
      }
    }
    if (tag === "button") {
      attributes.set("type", "button");
    }
    if (tag === "input") {
      attributes.set("type", inputType);
    }
    element.attribs = Object.fromEntries(attributes);
  }
  // Only the body fragment enters the composer; document metadata is owned by it.
  // The HTML parser moves leading scripts into head. Keep those scripts in
  // source order while excluding every other piece of document metadata.
  const sanitized =
    $("head script")
      .toArray()
      .map((element) => $.html(element))
      .join("") + ($("body").html() ?? "");
  if (Buffer.byteLength(sanitized, "utf-8") > VISUAL_SANDBOX_LIMITS.htmlBytes) {
    return Result.err(
      new VisualMarkupError({
        reason: "size",
        message: "Normalized visual markup exceeds the size limit",
      }),
    );
  }
  return Result.ok(sanitized);
};
