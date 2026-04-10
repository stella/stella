import { useEffectEvent, useRef } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";

import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatInputSurface } from "@/components/chat-input-surface";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import {
  chatThreadOptions,
  invalidateGroupedChatThreads,
} from "@/routes/_protected.chat/-queries";

export const Route = createFileRoute("/_protected/chat/")({
  component: ChatIndex,
});

function ChatIndex() {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const threadIdRef = useRef(uuidv7());
  const controller = useChatEditor({
    threadRef: { scope: "global", threadId: threadIdRef.current },
  });

  return (
    <div className="flex w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-end px-4 py-2">
        <ThreadsSheet />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
        <h1 className="text-foreground text-2xl font-semibold">
          {t("chat.greeting")}
        </h1>
        <div className="w-full">
          <ChatInputSurface
            autoFocus
            controller={controller}
            onSubmit={async (draft) => {
              const chat = await queryClient.ensureQueryData(
                chatThreadOptions({
                  key: { scope: "global", threadId: threadIdRef.current },
                  context: {
                    allowMissingThread: true,
                    getUserContext,
                  },
                }),
              );

              await chat.sendMessage(await buildChatRequestMessage(draft));
              await invalidateGroupedChatThreads(queryClient);
              await navigate({
                to: "/chat/$threadId",
                params: { threadId: threadIdRef.current },
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}
