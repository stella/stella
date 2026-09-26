import * as cheerio from "cheerio";

import { SKILL_REF_HREF_PREFIX } from "@stll/api-contract";
import type { ConditionNode } from "@stll/conditions";

import { htmlToMarkdown } from "@/api/lib/markdown/html-to-markdown";
import { createHtmlSanitizer } from "@/api/lib/markdown/sanitize-html";

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

const sanitizeHtml = createHtmlSanitizer({
  allowedTags: ALLOWED_TAGS,
  allowedAttrs: ALLOWED_ATTRS,
  allowedHrefSchemes: ALLOWED_HREF_SCHEMES,
});

export type AITool = {
  version: 1;
  type: "ai-model";
  prompt: string;
  dependencies: {
    dependsOnPropertyId: string;
    condition: ConditionNode | null;
  }[];
};

const MENTION_TAG = "mention-component";
const ATTR_ID = "data-id";
const ATTR_LABEL = "data-label";
const ATTR_SUGGESTION_CHAR = "data-mention-suggestion-char";

// The prompt editor's skill chip element (the web `pastedText` node with the
// "skill" source): its text is the skill slug, its label the link text.
const SKILL_CHIP_TAG = "pasted-text";
const ATTR_SKILL_CHIP_SOURCE = "data-source";
const SKILL_CHIP_SOURCE = "skill";

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
        el.replace(
          `<a href="${Bun.escapeHTML(id)}">${Bun.escapeHTML(`${char}${label}`)}</a>`,
          { html: true },
        );
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
    const skillSlug = href.startsWith(SKILL_REF_HREF_PREFIX)
      ? href.slice(SKILL_REF_HREF_PREFIX.length)
      : "";
    if (skillSlug.length > 0) {
      const chip = $(`<${SKILL_CHIP_TAG}></${SKILL_CHIP_TAG}>`)
        .attr(ATTR_SKILL_CHIP_SOURCE, SKILL_CHIP_SOURCE)
        .attr(ATTR_LABEL, $(el).text())
        .text(skillSlug);
      $(el).replaceWith(chip);
      return;
    }
    if (!dependencyIds.has(href)) {
      // Non-dependency links render as inline content (no anchor wrapper),
      // mirroring marked's parseInline fallback.
      $(el).replaceWith($(el).contents());
      return;
    }

    const text = $(el).text();
    const mentionChar = text.charAt(0);
    const label = text.slice(1);
    const mention = $(`<${MENTION_TAG}></${MENTION_TAG}>`)
      .attr(ATTR_ID, href)
      .attr(ATTR_LABEL, label)
      .attr(ATTR_SUGGESTION_CHAR, mentionChar);
    $(el).replaceWith(mention);
  });

  return { ...data, prompt: $.html().trimEnd() };
};
