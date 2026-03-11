import { convert } from "@kreuzberg/html-to-markdown";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { marked } from "marked";

import type { PropertyCondition } from "@/api/db/schema-validators";

const DOMPurify = createDOMPurify(new JSDOM().window);

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

  return DOMPurify.sanitize(unsafeHtml);
};

export const serializeAITool = (data: AITool): AITool => {
  const preprocessed = replaceMentionsWithAnchors(data.prompt);
  const markdown = convert(preprocessed);

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
