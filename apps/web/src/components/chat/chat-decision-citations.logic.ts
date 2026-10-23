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
import type { ExternalSourceReference } from "@/components/chat/external-source-store";
import { referenceFromHref } from "@/components/references/reference.logic";
import type { ChatMessage } from "@/lib/api-contract";

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
    // Only these three node types carry a link; every other mdast node is
    // walked for its children alone.
    if (node.type === "definition") {
      if (!definitions.has(node.identifier)) {
        definitions.set(node.identifier, node.url);
      }
    } else if (node.type === "link") {
      hrefs.push(node.url);
    } else if (node.type === "linkReference") {
      references.push(node.identifier);
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

/**
 * One key per cited destination. Relative links resolve against the app
 * origin, and a fragment (a paragraph anchor) names the same document. A
 * fragment-only reference (`#stella-entity=...`) is the resource itself, so
 * it keeps its fragment.
 */
export const citationUrlKey = (
  url: string,
  appOrigins: ReadonlySet<string>,
): string => {
  if (url.startsWith("#")) {
    return url;
  }
  const base = appOrigins.values().next().value;
  if (!URL.canParse(url, base)) {
    return url;
  }
  const parsed = new URL(url, base);
  parsed.hash = "";
  return parsed.href;
};

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
        [entry.url, entry.sourceUrl].some(
          (url) =>
            url !== undefined &&
            citationUrlKey(url, appOrigins) ===
              citationUrlKey(href, appOrigins),
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
        url: href,
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

const askUserAnalysis = (input: unknown) =>
  typeof input === "object" &&
  input !== null &&
  "analysis" in input &&
  typeof input.analysis === "string"
    ? input.analysis
    : undefined;

/** Only fields actually handed to a Markdown renderer contribute links. */
export const chatAnswerMarkdownDocuments = (
  message: Pick<ChatMessage, "parts">,
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
        (part.state === "complete" && part.output !== undefined))
    ) {
      const analysis = askUserAnalysis(part.input);
      if (analysis) {
        text.push(analysis);
      }
    }
  }
  return text;
};
