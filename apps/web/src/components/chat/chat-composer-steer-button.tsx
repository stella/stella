import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { COMPOSER_CONTROL_BUTTON_SIZE } from "@stll/ui/composer";
import { SendIcon } from "@stll/ui/icons";

import type {
  ChatEditorController,
  ChatSend,
} from "@/components/chat-editor-provider";
import { detached } from "@/lib/detached";

/**
 * The member's explicit steer: `offered` while a turn works that can take a
 * message mid-turn (`isChatSteerOffered`); `send` hands it the draft.
 */
export type ChatComposerSteer = {
  offered: boolean;
  send: ChatSend;
};

type ChatComposerSteerButtonProps = {
  steer: ChatComposerSteer | undefined;
  controller: ChatEditorController;
  /** The draft can be sent: it holds something and sending is allowed. */
  canSend: boolean;
  onError: (error: unknown) => void;
};

/**
 * The steer, beside Stop while a turn works on the member's computer: the
 * draft goes to the agent's running turn instead of waiting for it to end.
 * Nothing while no steer is offered.
 */
export const ChatComposerSteerButton = ({
  steer,
  controller,
  canSend,
  onError,
}: ChatComposerSteerButtonProps) => {
  const t = useTranslations();
  if (steer === undefined || !steer.offered) {
    return null;
  }
  const label = t("chat.steerPrompt");
  const steerDraft = async () => {
    try {
      await controller.submit(steer.send);
    } catch (error) {
      onError(error);
    }
  };
  return (
    <Button
      aria-label={label}
      disabled={!canSend}
      onClick={() => {
        detached(steerDraft(), "chat-composer-steer-button.steer");
      }}
      size={COMPOSER_CONTROL_BUTTON_SIZE}
      tooltip={label}
      type="button"
      variant="ghost"
    >
      <SendIcon aria-hidden="true" className="size-3.5" />
    </Button>
  );
};
