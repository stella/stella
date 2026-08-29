import type { ReactElement } from "react";

import type { ChatMessage } from "./runtime";

export type ChatMessageStreamProps<Metadata> = {
  className?: string | undefined;
  empty?: ReactElement | undefined;
  messages: readonly ChatMessage<Metadata>[];
  renderMessage: (message: ChatMessage<Metadata>) => ReactElement;
};

/** A semantic transcript container; hosts supply their own rich markdown,
 * citation, tool-call, and attachment renderers through `renderMessage`. */
export const ChatMessageStream = <Metadata,>({
  className,
  empty,
  messages,
  renderMessage,
}: ChatMessageStreamProps<Metadata>): ReactElement | null => {
  if (messages.length === 0) {
    return empty ?? null;
  }
  return (
    <ol className={className}>
      {messages.map((message) => (
        <li key={message.id}>{renderMessage(message)}</li>
      ))}
    </ol>
  );
};
