import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import type { ChatSendMode } from "@stll/anonymize-chat";

const ANON_RESTORATIONS_PART_TYPE = "data-stella-anon-restorations";

type AnonymizationMessage = {
  parts: readonly { type: string }[];
};

export const messagesCarryAnonymizationRestorations = (
  messages: readonly AnonymizationMessage[],
): boolean =>
  messages.some((message) =>
    message.parts.some((part) => part.type === ANON_RESTORATIONS_PART_TYPE),
  );

export const shouldMarkThreadUsedAnonymization = ({
  messages,
  sendMode,
}: {
  messages: readonly AnonymizationMessage[];
  sendMode: ChatSendMode | null;
}): boolean =>
  sendMode === CHAT_SEND_MODE.anonymized ||
  messagesCarryAnonymizationRestorations(messages);
