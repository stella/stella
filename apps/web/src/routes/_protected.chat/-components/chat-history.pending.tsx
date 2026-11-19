import type { ReactNode } from "react";

import { InputFace } from "@stll/ui/control-face";
import { SearchIcon } from "@stll/ui/icons";
import {
  List,
  ListGroup,
  ListGroupHeader,
  ListGroupTitlePending,
  ListItemSkeleton,
} from "@stll/ui/list-shell";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The page's scroll area (`ScrollArea` on the page): the frame's height. */
const CHAT_HISTORY_SCROLL_CLASS = "min-h-0 w-full flex-1";

/**
 * The search field's face: its share of the toolbar row and its touch
 * height on narrow screens, as the page's `SearchField` takes them.
 */
const SEARCH_FIELD_FACE_CLASS = "min-h-11 sm:min-h-0 sm:flex-1";

/** The matter filter's column in the toolbar row. */
export const CHAT_HISTORY_MATTER_FIELD_CLASS =
  "flex min-w-0 flex-col gap-1 sm:w-64";

/** Placeholder rows while the chats load, about a screen of them. */
const CHAT_HISTORY_ROWS_PENDING = [
  { key: "a" },
  { key: "b" },
  { key: "c" },
  { key: "d" },
  { key: "e" },
  { key: "f" },
] as const;

/**
 * The history's rows while the chats load: a group whose title waits on the
 * data (pinned, today, earlier) over `ListItemSkeleton`s at the rows'
 * geometry (the title, the line naming where the chat came from, the date).
 */
export const ChatHistoryRowsPending = () => (
  <div aria-hidden="true" className="flex flex-col gap-6">
    <ListGroup>
      <ListGroupHeader>
        <ListGroupTitlePending />
      </ListGroupHeader>
      <List>
        {CHAT_HISTORY_ROWS_PENDING.map((row, index) => (
          <ListItemSkeleton index={index} key={row.key} trailing="text" />
        ))}
      </List>
    </ListGroup>
  </div>
);

type ChatHistoryShellProps = {
  /** The search field and the matter filter, and clearing them. */
  toolbar: ReactNode;
  /** The lists, or what stands in for them. */
  children: ReactNode;
};

/**
 * The chat history's one layout, drawn by both phases: the heading, the
 * toolbar row and the lists under it. The loaded page fills the toolbar
 * with the live fields and the lists with the chats; the pending phase with
 * the fields' faces and placeholder rows.
 */
export const ChatHistoryShell = ({
  children,
  toolbar,
}: ChatHistoryShellProps) => (
  <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
    <h1 className="text-foreground text-lg font-semibold text-balance">
      <PendingText barClassName="w-20" id="common.history" />
    </h1>
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
      {toolbar}
    </div>
    {children}
  </div>
);

/**
 * The chat history in its pending phase: the heading, the search field and
 * the matter filter in their faces, and placeholder rows where the chats
 * load, inside the scroll area's boxes (nothing in a placeholder scrolls).
 */
const ChatHistoryPendingView = () => (
  <div
    className={cn("flex size-full min-h-0 flex-col", CHAT_HISTORY_SCROLL_CLASS)}
  >
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <ChatHistoryShell
        toolbar={
          <>
            <InputFace
              className={SEARCH_FIELD_FACE_CLASS}
              icon={<SearchIcon />}
            >
              <PendingText barClassName="w-16" id="common.search" />
            </InputFace>
            <div className={CHAT_HISTORY_MATTER_FIELD_CLASS}>
              <InputFace icon={<SearchIcon />}>
                <PendingText barClassName="w-28" id="common.selectAMatter" />
              </InputFace>
            </div>
          </>
        }
      >
        <ChatHistoryRowsPending />
      </ChatHistoryShell>
    </div>
  </div>
);

export const ChatHistoryPending = framePendingView(ChatHistoryPendingView);
