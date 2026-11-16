import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { NewChatIcon, QuoteIcon } from "@stll/ui/icons";

import { CHAT_SELECTION_ACTION } from "@/components/chat/chat-selection-branch.logic";
import type { ChatSelectionAction } from "@/components/chat/chat-selection-branch.logic";
import { CopyControlButton } from "@/components/copy-control";
import type { CopyControlState } from "@/components/copy-control";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";

const ACTION_LABEL_CLASS = "max-sm:sr-only";

export const ChatSelectionActions = ({
  actions,
  askInNewChat,
  quoteInReply,
  copy,
  copyText,
}: ChatSelectionActionsProps) => {
  const t = useTranslations();
  return (
    <>
      {" "}
      {actions.map((action) => {
        switch (action) {
          case CHAT_SELECTION_ACTION.askInNewChat: {
            return (
              <CapabilityAction
                action={{ capability: "ai" }}
                key={action}
                surface="control"
              >
                {(capabilityProps) => (
                  <Button
                    onClick={askInNewChat}
                    onMouseDown={(event) => event.preventDefault()}
                    size="sm"
                    variant="ghost"
                    {...capabilityProps}
                  >
                    <NewChatIcon className="size-3.5" />
                    <span className={ACTION_LABEL_CLASS}>
                      {t("chat.selection.askInNewChat")}
                    </span>
                  </Button>
                )}
              </CapabilityAction>
            );
          }
          case CHAT_SELECTION_ACTION.quoteInReply: {
            return (
              <CapabilityAction
                action={{ capability: "ai" }}
                key={action}
                surface="control"
              >
                {(capabilityProps) => (
                  <Button
                    onClick={quoteInReply}
                    onMouseDown={(event) => event.preventDefault()}
                    size="sm"
                    variant="ghost"
                    {...capabilityProps}
                  >
                    <QuoteIcon className="size-3.5" />
                    <span className={ACTION_LABEL_CLASS}>
                      {t("chat.selection.quoteInReply")}
                    </span>
                  </Button>
                )}
              </CapabilityAction>
            );
          }
          case CHAT_SELECTION_ACTION.copy: {
            return (
              <CopyControlButton
                content={copyText}
                control={copy}
                key={action}
                labelClassName={ACTION_LABEL_CLASS}
                // Pressing it keeps the words selected.
                onMouseDown={(event) => event.preventDefault()}
                size="sm"
                variant="ghost"
              />
            );
          }
          default: {
            action satisfies never;
            return panic(`Unhandled selection action: ${String(action)}`);
          }
        }
      })}
    </>
  );
};

type ChatSelectionActionsProps = {
  actions: ChatSelectionAction[];
  askInNewChat: () => void;
  quoteInReply: () => void;
  /** The bar's copy owner, which also confirms the reader's own copy. */
  copy: CopyControlState<"selection">;
  copyText: string;
};
