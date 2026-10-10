import type { MessageResponseProps } from "@/components/ai-elements/message-response";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";

export const messageComponents = {
  a: (props) => <StreamdownMentionLink {...props} interactive={false} />,
  img: (props: unknown) => {
    if (
      typeof props !== "object" ||
      props === null ||
      !("alt" in props) ||
      typeof props.alt !== "string"
    ) {
      return <span />;
    }
    return <span>{props.alt}</span>;
  },
} satisfies NonNullable<MessageResponseProps["components"]>;
