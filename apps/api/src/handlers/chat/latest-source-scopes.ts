import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

import {
  type ChatSourceScope,
  chatSourceScopeKey,
  parseChatSourceScopeHref,
} from "@stll/api-contract";
import { isChatPastedTextPart } from "@stll/api-contract/chat";

import { isChatTextPart } from "@/api/handlers/chat/chat-message-parts";
import type { PersistableChatMessage } from "@/api/handlers/chat/types";

/** Uses the renderer's CommonMark/GFM grammar, so only rendered links become chips. */
const sourceScopesInMarkdown = (markdown: string): ChatSourceScope[] => {
  const tree = fromMarkdown(markdown, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  const definitions = new Map<string, string>();
  const nodes = tree.children.toReversed();
  for (let node = nodes.pop(); node !== undefined; node = nodes.pop()) {
    if (node.type === "definition" && !definitions.has(node.identifier)) {
      definitions.set(node.identifier, node.url);
    }
    if ("children" in node) {
      nodes.push(...node.children.toReversed());
    }
  }

  const scopes: ChatSourceScope[] = [];
  nodes.push(...tree.children.toReversed());
  for (let node = nodes.pop(); node !== undefined; node = nodes.pop()) {
    let href: string | undefined;
    if (node.type === "link") {
      href = node.url;
    } else if (node.type === "linkReference") {
      href = definitions.get(node.identifier);
    }
    const scope = href === undefined ? null : parseChatSourceScopeHref(href);
    if (scope !== null) {
      scopes.push(scope);
    }
    if ("children" in node) {
      nodes.push(...node.children.toReversed());
    }
  }
  return scopes;
};

/**
 * The source chips (public corpora, registries, connectors) of the thread's
 * latest user message, read back from the links it was persisted with. A turn that continues after a tool approval
 * carries no new user message, so the scope comes from history rather than
 * from the incoming message, and the whole turn stays scoped. Pasted text is
 * the user's verbatim text, not composer chips, so it is not read.
 */
export const sourceScopesOfLatestUserMessage = (
  messages: readonly Pick<PersistableChatMessage, "parts" | "role">[],
): ChatSourceScope[] => {
  const latest = messages.findLast((message) => message.role === "user");
  if (latest === undefined) {
    return [];
  }
  const scopes = new Map<string, ChatSourceScope>();
  for (const part of latest.parts) {
    if (isChatPastedTextPart(part) || !isChatTextPart(part)) {
      continue;
    }
    for (const scope of sourceScopesInMarkdown(part.content)) {
      scopes.set(chatSourceScopeKey(scope), scope);
    }
  }
  return [...scopes.values()];
};
