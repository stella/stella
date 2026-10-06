import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import {
  createCaseLawDecisionPath,
  extractCaseLawDecisionIdFromIdRouteParam,
  isCaseLawDecisionId,
} from "@stll/api-contract/case-law-decision-route";
import type { CaseLawDecisionRouteParams } from "@stll/api-contract/case-law-decision-route";
import { resolveLegalCitationLinks } from "@stll/api-contract/legal-citation-links";

import { isOpaquePersistedChatToolCallPart } from "@/components/chat/chat-ui-tools";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import type { ExternalSourceReference } from "@/components/chat/external-source-store";
import { referenceFromHref } from "@/components/references/reference.logic";

/** Uses the same CommonMark/GFM link grammar as the answer renderer, excluding code and unused definitions. */
export const chatAnswerCitationHrefs = (markdown: string) => {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const nodes = tree.children.toReversed();
  const definitions = new Map<string, string>();
  const references: string[] = [];
  const hrefs: string[] = [];
  for (let node = nodes.pop(); node !== undefined; node = nodes.pop()) {
    switch (node.type) {
      case "definition":
        if (!definitions.has(node.identifier)) {
          definitions.set(node.identifier, node.url);
        }
        break;
      case "link":
        hrefs.push(node.url);
        break;
      case "linkReference":
        references.push(node.identifier);
        break;
    }
    if ("children" in node) {
      nodes.push(...node.children.toReversed());
    }
  }
  for (const identifier of references) {
    const href = definitions.get(identifier);
    if (href !== undefined) {
      hrefs.push(href);
    }
  }
  return hrefs;
};

const citationUrlKey = (url: string) =>
  URL.canParse(url) ? new URL(url).href : url;

type ChatAnswerDecisionTargetsOptions = {
  markdownDocuments: readonly string[];
  sources: readonly ExternalSourceReference[];
  appOrigins: ReadonlySet<string>;
};

/** Returned search hits are metadata; only a link actually cited in this answer contributes identity. */
export const chatAnswerDecisionTargets = ({
  markdownDocuments,
  sources,
  appOrigins,
}: ChatAnswerDecisionTargetsOptions) => {
  const targets = new Map<string, ChatAnswerDecisionTarget>();
  for (const document of markdownDocuments) {
    for (const href of chatAnswerCitationHrefs(document)) {
      const parsed = referenceFromHref(href, "");
      if (
        parsed?.type === "reference" &&
        parsed.reference.type === "decision" &&
        parsed.reference.locator.type === "ref"
      ) {
        const decisionId = parsed.reference.locator.ref;
        targets.set(decisionId, { type: "id", decisionId });
        continue;
      }
      const source = sources.find((entry) =>
        [entry.url, entry.appUrl, entry.sourceUrl].some(
          (url) =>
            url !== undefined && citationUrlKey(url) === citationUrlKey(href),
        ),
      );
      if (source?.caseLawDecision !== undefined) {
        targets.set(source.caseLawDecision.decisionId, {
          type: "id",
          decisionId: source.caseLawDecision.decisionId,
        });
        continue;
      }
      const link = resolveLegalCitationLinks({
        appUrl: href,
        sourceUrl: null,
        appOrigins,
      });
      if (link.type !== "decision") {
        continue;
      }
      const id = extractCaseLawDecisionIdFromIdRouteParam(link.params.slug);
      if (id !== null && isCaseLawDecisionId(id)) {
        targets.set(id, { type: "id", decisionId: id });
      } else {
        targets.set(createCaseLawDecisionPath(link.params), {
          type: "route",
          params: link.params,
        });
      }
    }
  }
  return [...targets.values()];
};

export type ChatAnswerDecisionTarget =
  | { type: "id"; decisionId: string }
  | { type: "route"; params: CaseLawDecisionRouteParams };

/** Only fields actually handed to a Markdown renderer contribute links. */
export const chatAnswerMarkdownDocuments = (
  message: ChatUIMessage,
  isAwaitingUser = false,
) => {
  const text: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      text.push(part.content);
      continue;
    }
    if (
      part.type === "tool-call" &&
      !isOpaquePersistedChatToolCallPart(part) &&
      part.name === "ask-user" &&
      part.state !== "input-streaming" &&
      (isAwaitingUser ||
        (part.state === "complete" &&
          part.output !== undefined &&
          part.output !== null)) &&
      part.input?.analysis
    ) {
      text.push(part.input.analysis);
    }
  }
  return text;
};
