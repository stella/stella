import type { ChatMiddleware, ModelMessage } from "@tanstack/ai";
import { Result } from "better-result";

import {
  CHAT_STEP_LEDGER_JSON_KEY,
  withoutChatStepLedger,
} from "@stll/api-contract/chat-step-ledger";

// A step's ledger is for the person reading the step. The model wrote the
// script and already has whatever it returned, so the provider copy of every
// message reads each tool result without the ledger: the same bytes a run
// without ledgers would send, and no matter document id on the way.

const withoutLedgerContent = (content: string): string => {
  if (!content.includes(CHAT_STEP_LEDGER_JSON_KEY)) {
    return content;
  }
  const parsed = Result.try((): unknown => JSON.parse(content));
  if (Result.isError(parsed)) {
    return content;
  }
  const stripped = withoutChatStepLedger(parsed.value);
  return stripped === parsed.value ? content : JSON.stringify(stripped);
};

/**
 * `messages` with every tool result read without its step ledger. Returns
 * the same array when no result carries one.
 */
const stepLedgerFreeProviderMessages = (
  messages: readonly ModelMessage[],
): readonly ModelMessage[] => {
  const copy = messages.map((message) => {
    if (message.role !== "tool" || typeof message.content !== "string") {
      return message;
    }
    const content = withoutLedgerContent(message.content);
    return content === message.content ? message : { ...message, content };
  });
  return copy.some((message, index) => message !== messages[index])
    ? copy
    : messages;
};

/**
 * Keeps step ledgers out of each provider request. It runs last, on the
 * provider copy the middleware before it settled on, and never touches the
 * canonical messages that the stream and persistence read.
 */
export const stepLedgerProviderMiddleware: ChatMiddleware = {
  name: "stella-step-ledger-provider-copy",
  onConfig: (_context, config) => {
    const provider = config.providerMessages ?? config.messages;
    const stripped = stepLedgerFreeProviderMessages(provider);
    return stripped === provider
      ? undefined
      : { providerMessages: [...stripped] };
  },
};
