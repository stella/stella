import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

/*
 * The transcript's boxes (`Conversation`, `ConversationContent` in
 * ./conversation.tsx) and their stand-in for a loading view: the same
 * classes, with plain boxes where the live transcript has its scroll area,
 * since nothing in a placeholder scrolls.
 */

/** The transcript's log box: it takes the height the page leaves it. */
export const CONVERSATION_CLASS = "relative flex-1 overflow-y-hidden";

/** The column the turns stack in, inside the scroll area. */
export const CONVERSATION_CONTENT_CLASS = "flex flex-col gap-8 p-3";

/**
 * The transcript before it loads: the log box, the scroll area's root and
 * viewport boxes without the scrolling, and the column, holding the
 * placeholder turns.
 */
export const ConversationPending = ({
  children,
  className,
  contentClassName,
}: {
  children: ReactNode;
  className?: string | undefined;
  contentClassName?: string | undefined;
}) => (
  <div aria-hidden="true" className={cn(CONVERSATION_CLASS, className)}>
    <div className="flex size-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className={cn(CONVERSATION_CONTENT_CLASS, contentClassName)}>
          {children}
        </div>
      </div>
    </div>
  </div>
);
