import { useTranslations } from "use-intl";

import { CHAT_MEMBER_SEND_ACTION } from "@stll/api-contract/chat-send-intent";
import { Button } from "@stll/ui/button";
import { COMPOSER_CONTROL_BUTTON_SIZE } from "@stll/ui/composer";
import { ClockIcon } from "@stll/ui/icons";
import { Kbd } from "@stll/ui/kbd";

import type { ChatComposerSubmitHandler } from "@/components/chat-editor-provider";
import { detached } from "@/lib/detached";

type ChatComposerQueueButtonProps = {
  /** The queue action does something a plain send does not (`isChatQueueOffered`). */
  offered: boolean | undefined;
  /** The surface's submit, as Enter and Cmd/Ctrl+Enter reach it. */
  submitDraft: ChatComposerSubmitHandler;
  /** The draft can be sent: it holds something and sending is allowed. */
  canSend: boolean;
};

/**
 * The member's queue action, beside the primary button while a plain send
 * would steer the turn: the draft waits for the turn's end instead.
 * Cmd/Ctrl+Enter does the same. Nothing while it is not offered.
 */
export const ChatComposerQueueButton = ({
  offered,
  submitDraft,
  canSend,
}: ChatComposerQueueButtonProps) => {
  const t = useTranslations();
  if (offered !== true) {
    return null;
  }
  const label = t("chat.queuePrompt");
  return (
    <Button
      aria-label={label}
      disabled={!canSend}
      onClick={() => {
        detached(
          submitDraft(CHAT_MEMBER_SEND_ACTION.queue),
          "chat-composer-queue-button.queue",
        );
      }}
      size={COMPOSER_CONTROL_BUTTON_SIZE}
      tooltip={
        <span className="flex items-center gap-2">
          {label}
          <Kbd keys={["mod", "enter"]} />
        </span>
      }
      type="button"
      variant="ghost"
    >
      <ClockIcon aria-hidden="true" className="size-3.5" />
    </Button>
  );
};
