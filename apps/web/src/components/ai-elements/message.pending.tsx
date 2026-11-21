import type { UIMessage } from "@tanstack/ai-client";

import { FaceLabelPending } from "@stll/ui/control-face";
import { cn } from "@stll/ui/utils";

/*
 * The chat message's box (`Message`, `MessageContent` in ./message.tsx) and
 * its loading placeholder, from the same classes, so a transcript's pending
 * view draws its turns in the boxes the messages arrive in.
 */

/** Who wrote a message, as its box styles it. */
export type MessageAuthor = UIMessage["role"] | "system";

/** A message's row: the full column, its parts stacked. */
export const messageClassName = (from: MessageAuthor): string =>
  cn(
    "group flex w-full flex-col gap-2",
    from === "user" && "is-user",
    from === "assistant" && "is-assistant",
    from === "system" && "is-system mx-auto",
  );

/** A message's body: a bubble for the member, flowing text for the answer. */
export const MESSAGE_CONTENT_CLASS = cn(
  "flex w-fit max-w-full min-w-0 flex-col gap-2",
  "overflow-hidden text-sm",
  // A sent message is a bubble that hugs its text at the end of the
  // reading column, so the answer below it keeps the column to itself.
  // It stays unclipped: its edit action sits just outside its start edge.
  "group-[.is-user]:relative group-[.is-user]:ms-auto group-[.is-user]:max-w-[85%]",
  "group-[.is-user]:overflow-visible group-[.is-user]:wrap-break-word",
  "group-[.is-user]:bg-secondary group-[.is-user]:rounded-2xl",
  "group-[.is-user]:px-4 group-[.is-user]:py-2.5",
  "group-[.is-user]:text-foreground group-[.is-user]:text-base/6",
  // Editing in place needs the column's width, not the text's.
  "group-[.is-user]:has-data-chat-message-edit:w-full group-[.is-user]:has-data-chat-message-edit:max-w-full",
  "group-[.is-assistant]:text-foreground",
  "group-[.is-system]:w-full group-[.is-system]:rounded-lg",
  "group-[.is-system]:border group-[.is-system]:border-dashed",
  "group-[.is-system]:bg-muted/50 group-[.is-system]:px-3",
  "group-[.is-system]:py-2 group-[.is-system]:text-xs",
  "group-[.is-system]:text-muted-foreground",
);

// Line widths of the placeholder text, so the turns do not read as a grid.
// Fixed lengths, capped at the column: a bar sits in a box as wide as its
// content, so a share of that box would be no width at all.
const LINE_WIDTHS = {
  // The member's bubble hugs its text: its one line sets the bubble's width.
  user: ["w-72"],
  assistant: ["w-176", "w-160", "w-120"],
} as const satisfies Record<"user" | "assistant", readonly string[]>;

/** One `text-sm` line of a message, its text still to come. */
const MessageLinePending = ({ width }: { width: string }) => (
  <span className="flex leading-5">
    <FaceLabelPending className={cn("max-w-full", width)} />
  </span>
);

/**
 * A message while the transcript loads: the member's bubble with one line,
 * or an answer's lines, in the box the message will have.
 */
export const ChatMessageSkeleton = ({
  from,
}: {
  from: "user" | "assistant";
}) => (
  <div
    aria-hidden="true"
    className={cn(messageClassName(from))}
    data-slot="chat-message-skeleton"
  >
    <div
      className={cn(MESSAGE_CONTENT_CLASS, from === "assistant" && "w-full")}
    >
      {LINE_WIDTHS[from].map((width) => (
        <MessageLinePending key={width} width={width} />
      ))}
    </div>
  </div>
);
