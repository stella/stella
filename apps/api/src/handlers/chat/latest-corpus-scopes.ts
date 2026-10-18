import {
  formatChatCorpusId,
  parseChatCorpusHref,
  type ChatCorpusScope,
} from "@stll/api-contract";
import { isChatPastedTextPart } from "@stll/api-contract/chat";

import { isChatTextPart } from "@/api/handlers/chat/chat-message-parts";
import type { PersistableChatMessage } from "@/api/handlers/chat/types";

/** The markdown link opener; a chip persists as `[label](#stella-corpus=…)`. */
const LINK_TARGET_OPENER = "](";

const corpusScopesInMarkdown = (markdown: string): ChatCorpusScope[] =>
  markdown
    .split(LINK_TARGET_OPENER)
    .slice(1)
    .flatMap((segment) => {
      const end = segment.indexOf(")");
      const scope =
        end === -1 ? null : parseChatCorpusHref(segment.slice(0, end));
      return scope === null ? [] : [scope];
    });

/**
 * The corpus chips of the thread's latest user message, read back from the
 * links it was persisted with. A turn that continues after a tool approval
 * carries no new user message, so the scope comes from history rather than
 * from the incoming message, and the whole turn stays scoped. Pasted text is
 * the user's verbatim text, not composer chips, so it is not read.
 */
export const corpusScopesOfLatestUserMessage = (
  messages: readonly Pick<PersistableChatMessage, "parts" | "role">[],
): ChatCorpusScope[] => {
  const latest = messages.findLast((message) => message.role === "user");
  if (latest === undefined) {
    return [];
  }
  const scopes = new Map<string, ChatCorpusScope>();
  for (const part of latest.parts) {
    if (isChatPastedTextPart(part) || !isChatTextPart(part)) {
      continue;
    }
    for (const scope of corpusScopesInMarkdown(part.content)) {
      scopes.set(formatChatCorpusId(scope), scope);
    }
  }
  return [...scopes.values()];
};
