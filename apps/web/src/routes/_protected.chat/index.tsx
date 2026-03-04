import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { nanoid } from "nanoid";
import { useTranslations } from "use-intl";

import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { useDevStore } from "@/lib/dev-store";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
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
  const userContext = useChatUserContext();

  return (
    <div className="flex w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-end px-4 py-2">
        <ThreadsSheet />
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-6 px-4">
        <h1 className="text-2xl font-semibold text-foreground">
          {t("chat.greeting")}
        </h1>
        <div className="w-full">
          <PromptInput
            onSubmit={async ({ text }) => {
              const threadId = nanoid();

              const chat = await queryClient.ensureQueryData(
                chatThreadOptions({
                  threadId,
                  queryClient,
                  userContext,
                  getModelId,
                }),
              );

              chat.sendMessage({ text });

              await navigate({
                to: "/chat/$threadId",
                params: { threadId },
              });
            }}
          >
            <PromptInputTextarea />
            <PromptInputFooter className="justify-end">
              <PromptInputSubmit />
            </PromptInputFooter>
          </PromptInput>
        </div>
      </div>
    </div>
  );
}
