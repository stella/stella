import type { MessageResponseProps } from "@/components/ai-elements/message-response";

export const messageComponents = {
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
