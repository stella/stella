import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

type AnonymizationMessage = {
  metadata?: { anonRestorations?: unknown } | undefined;
};

export const messagesCarryAnonymizationRestorations = (
  messages: readonly AnonymizationMessage[],
): boolean =>
  messages.some((message) => message.metadata?.anonRestorations !== undefined);

export const shouldMarkThreadUsedAnonymization = ({
  messages,
  sendMode,
}: {
  messages: readonly AnonymizationMessage[];
  sendMode: ChatSendMode | null;
}): boolean =>
  sendMode === CHAT_SEND_MODE.anonymized ||
  messagesCarryAnonymizationRestorations(messages);
