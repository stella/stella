import * as cheerio from "cheerio";
import { marked } from "marked";

import type { PropertyCondition } from "@/api/db/schema-validators";
import { htmlToMarkdown } from "@/api/lib/markdown/html-to-markdown";

/**
 * Allowlist-based HTML sanitizer using cheerio.
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

const ALLOWED_HREF_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

const sanitizeHtml = (html: string): string => {
  const $ = cheerio.load(html, undefined, false);

  $("script, style, iframe, object, embed, form, textarea").remove();

  // Walk bottom-up so that unwrapping a disallowed parent
  // never leaves unvisited disallowed children behind.
  // `$("*").get().reverse()` gives us a leaf-first order.
  for (const el of $("*").get().toReversed()) {
    if (!("tagName" in el)) {
      continue;
    }
    const tagName = el.tagName.toLowerCase();

    if (!ALLOWED_TAGS.has(tagName)) {
      $(el).replaceWith($(el).contents());
      continue;
    }

    const allowed = ALLOWED_ATTRS[tagName];
    for (const attr of Object.keys(el.attribs)) {
      if (!allowed?.has(attr)) {
        $(el).removeAttr(attr);
      }
    }

    if (tagName === "a" && el.attribs["href"]) {
      if (!URL.canParse(el.attribs["href"], "https://placeholder.invalid")) {
        $(el).removeAttr("href");
        continue;
      }

      const url = new URL(el.attribs["href"], "https://placeholder.invalid");
      if (!ALLOWED_HREF_SCHEMES.has(url.protocol)) {
        $(el).removeAttr("href");
      }
    }
  }

  return $.html();
};

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
  // eslint-disable-next-line no-undef
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

  const renderer = new marked.Renderer();
  renderer.link = ({ href, text, tokens }) => {
    if (!dependencyIds.has(href)) {
      return renderer.parser.parseInline(tokens);
    }

    const mentionChar = text.charAt(0);
    const label = text.slice(1);

    return `<${MENTION_TAG} ${ATTR_ID}="${href}" ${ATTR_LABEL}="${label}" ${ATTR_SUGGESTION_CHAR}="${mentionChar}"></${MENTION_TAG}>`;
  };

  const html = marked.parse(data.prompt, { renderer, async: false });

  return { ...data, prompt: html.trimEnd() };
};
