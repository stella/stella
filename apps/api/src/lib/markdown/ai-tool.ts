import * as cheerio from "cheerio";

import type { PropertyCondition } from "@/api/db/schema-validators";
import { htmlToMarkdown } from "@/api/lib/markdown/html-to-markdown";

/**
 * Allowlist-based HTML sanitizer using HTMLRewriter.
 * Strips all tags and attributes not explicitly listed.
 */
const ALLOWED_TAGS = new Set([
  "a",
  "b",
  "blockquote",
  "br",
  "caption",
  "code",
  "col",
  "colgroup",
  "del",
  "em",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "li",
  "ol",
  "p",
  "pre",
  "s",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
]);

const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  td: new Set(["colspan", "rowspan"]),
  th: new Set(["colspan", "rowspan"]),
};

const REMOVE_ENTIRELY = new Set([
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "textarea",
]);

const ALLOWED_HREF_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

const sanitizeHtml = (html: string): string =>
  new HTMLRewriter()
    .on("*", {
      element(el) {
        const tagName = el.tagName;
        if (REMOVE_ENTIRELY.has(tagName)) {
          el.remove();
          return;
        }
        if (!ALLOWED_TAGS.has(tagName)) {
          el.removeAndKeepContent();
          return;
        }
        const allowed = ALLOWED_ATTRS[tagName];
        const toRemove: string[] = [];
        for (const [name] of el.attributes) {
          if (!allowed?.has(name)) {
            toRemove.push(name);
          }
        }
        for (const name of toRemove) {
          el.removeAttribute(name);
        }
        if (tagName !== "a") {
          return;
        }
        const href = el.getAttribute("href");
        if (!href) {
          return;
        }
        if (!URL.canParse(href, "https://placeholder.invalid")) {
          el.removeAttribute("href");
          return;
        }
        const url = new URL(href, "https://placeholder.invalid");
        if (!ALLOWED_HREF_SCHEMES.has(url.protocol)) {
          el.removeAttribute("href");
        }
      },
    })
    .transform(html);

export type AITool = {
  version: 1;
  type: "ai-model";
  prompt: string;
  dependencies: {
    dependsOnPropertyId: string;
    condition: PropertyCondition | null;
  }[];
};

const MENTION_TAG = "mention-component";
const ATTR_ID = "data-id";
const ATTR_LABEL = "data-label";
const ATTR_SUGGESTION_CHAR = "data-mention-suggestion-char";

const replaceMentionsWithAnchors = (html: string): string => {
  const unsafeHtml = new HTMLRewriter()
    .on(MENTION_TAG, {
      element(el) {
        const id = el.getAttribute(ATTR_ID);
        const label = el.getAttribute(ATTR_LABEL);
        const char = el.getAttribute(ATTR_SUGGESTION_CHAR);
        if (!id || !label || !char) {
          return;
        }
        el.replace(`<a href="${id}">${char}${label}</a>`, { html: true });
      },
    })
    .transform(html);

  return sanitizeHtml(unsafeHtml);
};

export const serializeAITool = (data: AITool): AITool => {
  const preprocessed = replaceMentionsWithAnchors(data.prompt);
  const markdown = htmlToMarkdown(preprocessed);

  return {
    ...data,
    prompt: markdown,
  };
};

export const deserializeAITool = (data: AITool): AITool => {
  const dependencyIds = new Set(
    data.dependencies.map((d) => d.dependsOnPropertyId),
  );

  const html = Bun.markdown.html(data.prompt);
  const $ = cheerio.load(html, undefined, false);

  $("a").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    if (!dependencyIds.has(href)) {
      // Non-dependency links render as inline content (no anchor wrapper),
      // mirroring marked's parseInline fallback.
      $(el).replaceWith($(el).contents());
      return;
    }

    const text = $(el).text();
    const mentionChar = text.charAt(0);
    const label = text.slice(1);
    $(el).replaceWith(
      `<${MENTION_TAG} ${ATTR_ID}="${href}" ${ATTR_LABEL}="${label}" ${ATTR_SUGGESTION_CHAR}="${mentionChar}"></${MENTION_TAG}>`,
    );
  });

  return { ...data, prompt: $.html().trimEnd() };
};
