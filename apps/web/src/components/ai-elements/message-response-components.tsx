import {
  AnswerTable,
  AnswerTableBody,
  AnswerTableCell,
  AnswerTableHead,
  AnswerTableHeaderCell,
  AnswerTableRow,
} from "@/components/ai-elements/answer-table";
import type { MessageResponseProps } from "@/components/ai-elements/message-response";
import { AnswerQuote } from "@/components/chat/answer-quote";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";

export const messageComponents = {
  a: (props) => <StreamdownMentionLink {...props} interactive={false} />,
  // Every answer surface draws its tables through one shell; chat puts its
  // chart into the same shell (`ChatTableChart`) and keeps these cells.
  table: AnswerTable,
  thead: AnswerTableHead,
  tbody: AnswerTableBody,
  tr: AnswerTableRow,
  th: AnswerTableHeaderCell,
  td: AnswerTableCell,
  // A quotation is usually verbatim source text; `AnswerQuote` sets it apart
  // and, against the decisions the answer cites, verifies and attributes it.
  blockquote: (props) => <AnswerQuote>{props.children}</AnswerQuote>,
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
