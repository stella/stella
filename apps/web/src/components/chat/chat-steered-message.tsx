import { useTranslations } from "use-intl";

import { steeredMessageText } from "@/components/chat/chat-steered-message.logic";

type ChatSteeredMessageProps = {
  /** The call's raw arguments, as the answer stores them. */
  arguments: string;
};

/**
 * A message the member sent while a turn ran on their computer, which the
 * agent took into that turn. It sits in the answer where the agent took it,
 * shown as the member's own words rather than as a step the agent ran.
 * `null` when the stored call does not carry readable text.
 */
export const ChatSteeredMessage = ({
  arguments: args,
}: ChatSteeredMessageProps) => {
  const t = useTranslations();
  const text = steeredMessageText(args);
  if (text === null) {
    return null;
  }
  return (
    <figure className="bg-secondary text-foreground flex w-full min-w-0 flex-col gap-1 rounded-lg px-2.5 py-2 text-sm">
      <figcaption className="text-muted-foreground text-xs">
        {t("chat.tool.user_message")}
      </figcaption>
      <p className="wrap-break-word whitespace-pre-wrap">{text}</p>
    </figure>
  );
};
