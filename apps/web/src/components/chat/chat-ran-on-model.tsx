import { useTranslations } from "use-intl";

import { chatLocalRunReroutedModel } from "@stll/api-contract/chat-run-target";

import type { ChatMessage } from "@/components/chat/chat-ui-tools";

/**
 * The model an answer on the member's computer ran on, shown only when the
 * harness rerouted it away from the model asked for.
 */
export const ChatRanOnModel = ({
  metadata,
}: {
  metadata: ChatMessage["metadata"];
}) => {
  const t = useTranslations();
  const model = chatLocalRunReroutedModel(metadata);
  if (model === null) {
    return null;
  }
  return (
    <p
      className="text-muted-foreground text-xs"
      data-chat-ran-on-model
      data-chat-copy-exclude
    >
      {t("chat.ranOnModel", { model })}
    </p>
  );
};
