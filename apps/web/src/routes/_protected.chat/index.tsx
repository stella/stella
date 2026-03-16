import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { nanoid } from "nanoid";
import { useTranslations } from "use-intl";

import { ChatEditor } from "@/components/mentionable-prompt-input";
import { GLOBAL_MENTION_CONTEXT } from "@/lib/chat-mention-context";
import { useDevStore } from "@/lib/dev-store";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useSuspenseChatActor } from "@/routes/_protected.chat/-hooks/chat-actor-provider";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { chatThreadOptions } from "@/routes/_protected.chat/-queries";

const getModelId = () => useDevStore.getState().chatModelId;

export const Route = createFileRoute("/_protected/chat/")({
  component: ChatIndex,
});

function ChatIndex() {
  const t = useTranslations();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { connection } = useSuspenseChatActor();
  const userContext = useChatUserContext();

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
          <ChatEditor
            autoFocus
            className="min-h-16 rounded-lg border px-3 py-2"
            mentionContext={GLOBAL_MENTION_CONTEXT}
            // eslint-disable-next-line typescript/no-misused-promises
            onSubmit={async (text) => {
              const threadId = nanoid();
              const chat = await queryClient.ensureQueryData(
                chatThreadOptions({
                  key: { threadId },
                  context: {
                    connection,
                    userContext,
                    getModelId,
                  },
                }),
              );

              // eslint-disable-next-line typescript/no-floating-promises
              chat.sendMessage({ text });

              await navigate({
                to: "/chat/$threadId",
                params: { threadId },
              });
            }}
          />
        </div>
      </div>
    </div>
  );
}
