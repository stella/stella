import type { MessageComponents } from "@/components/ai-elements/message-response";
import { AnswerQuote } from "@/components/chat/answer-quote";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";

export const messageComponents = {
  a: (props) => <StreamdownMentionLink {...props} interactive={false} />,
  // A quotation is usually verbatim source text; `AnswerQuote` sets it apart
  // and, against the decisions the answer cites, verifies and attributes it.
  blockquote: (props) => <AnswerQuote>{props.children}</AnswerQuote>,
} satisfies MessageComponents;
