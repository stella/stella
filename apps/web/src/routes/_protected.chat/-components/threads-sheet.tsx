import { useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useMatch, useNavigate } from "@tanstack/react-router";
import { MessageSquareIcon, TrashIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import {
  Sheet,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
  SheetTrigger,
} from "@stella/ui/components/sheet";

import type { ChatActor } from "@/lib/api";
import { eventHandlerV2 } from "@/lib/rivet";
import { useSuspenseChatActor } from "@/routes/_protected.chat/-hooks/chat-actor-provider";
import {
  chatKeys,
  chatThreadsOptions,
} from "@/routes/_protected.chat/-queries";

export const ThreadsSheet = () => {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const actor = useSuspenseChatActor();
  const [isOpen, setIsOpen] = useState(false);

  const threadMatch = useMatch({
    from: "/_protected/chat/$threadId",
    shouldThrow: false,
  });

  const { data: threads } = useQuery(chatThreadsOptions(queryClient));

  const sortedThreads = threads
    ? [...threads].toSorted((a, b) => b.createdAt - a.createdAt)
    : [];

  const chatEvent = eventHandlerV2<ChatActor>();

  actor.useEvent(
    ...chatEvent("thread-created", (data) => {
      queryClient.setQueryData(
        chatThreadsOptions(queryClient).queryKey,
        (prev) => prev && [...prev, data],
      );
    }),
  );

  actor.useEvent(
    ...chatEvent("thread-deleted", async (data) => {
      queryClient.setQueryData(
        chatThreadsOptions(queryClient).queryKey,
        (prev) => prev?.filter((thread) => thread.id !== data.threadId),
      );
      queryClient.removeQueries({
        queryKey: chatKeys.thread(data.threadId),
      });

      if (threadMatch?.params.threadId === data.threadId) {
        await navigate({ to: "/chat" });
      }
    }),
  );

  const handleDelete = (threadId: string) => {
    // eslint-disable-next-line typescript/no-floating-promises
    actor.connection.deleteThread({ threadId });
  };

  return (
    <Sheet onOpenChange={setIsOpen} open={isOpen}>
      <SheetTrigger
        render={
          <Button aria-label={t("chat.threads")} size="sm" variant="ghost" />
        }
      >
        <MessageSquareIcon className="size-4" />
        {t("chat.threads")}
      </SheetTrigger>
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>{t("chat.threads")}</SheetTitle>
        </SheetHeader>
        <SheetPanel>
          <div className="flex flex-col gap-1">
            {sortedThreads.length === 0 && (
              <p className="text-muted-foreground py-4 text-center text-sm">
                {t("chat.noThreads")}
              </p>
            )}
            {sortedThreads.map((thread) => (
              <div
                className="group hover:bg-muted flex items-center gap-1 rounded-lg transition-colors"
                key={thread.id}
              >
                <Link
                  className="flex flex-1 flex-col gap-0.5 overflow-hidden px-3 py-2 text-start"
                  onClick={() => setIsOpen(false)}
                  params={{ threadId: thread.id }}
                  to="/chat/$threadId"
                >
                  <span className="truncate text-sm font-medium">
                    {thread.title}
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {new Date(thread.createdAt).toLocaleDateString()}
                  </span>
                </Link>
                <Button
                  aria-label={t("chat.deleteThread")}
                  className="me-1 opacity-0 group-hover:opacity-100"
                  onClick={() => handleDelete(thread.id)}
                  size="icon-sm"
                  variant="ghost"
                >
                  <TrashIcon />
                </Button>
              </div>
            ))}
          </div>
        </SheetPanel>
      </SheetPopup>
    </Sheet>
  );
};
