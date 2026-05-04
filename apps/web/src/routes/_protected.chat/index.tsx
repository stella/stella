import { useEffectEvent, useRef } from "react";

import { Button } from "@stll/ui/components/button";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Maximize2Icon } from "lucide-react";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";

import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatInputSurface } from "@/components/chat-input-surface";
import { PromptSuggestions } from "@/components/chat/prompt-suggestions";
import { useAIKeyGate } from "@/components/require-ai-key";
import Tooltip from "@/components/tooltip";
import {
  getChatAnonymized,
  useChatAnonymized,
  useSetChatAnonymized,
} from "@/lib/chat-anonymized-store";
import type { ChatThreadRef } from "@/lib/chat-thread-ref";
import { useSavedPrompts } from "@/lib/prompts/use-saved-prompts";
import { ChatAnonymizedToggle } from "@/routes/_protected.chat/-components/chat-anonymized-toggle";
import { ThreadsSheet } from "@/routes/_protected.chat/-components/threads-sheet";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import {
  chatThreadOptions,
  invalidateGroupedChatThreads,
} from "@/routes/_protected.chat/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

export const Route = createFileRoute("/_protected/chat/")({
  component: ChatIndex,
});

function ChatIndex() {
  const t = useTranslations();
  const { byokDialog, ensureAIAvailable } = useAIKeyGate();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const threadIdRef = useRef(uuidv7());
  const threadRef: ChatThreadRef = {
    scope: "global",
    threadId: threadIdRef.current,
  };
  const controller = useChatEditor({ threadRef });
  const stockPrompts = useSavedPrompts();
  const anonymized = useChatAnonymized(threadRef);
  const setAnonymized = useSetChatAnonymized(threadRef);
  const getAnonymized = useEffectEvent(() => getChatAnonymized(threadRef));
  const openInspectorChat = useInspectorStore((s) => s.openChat);

  const moveToSide = () => {
    openInspectorChat({ id: threadIdRef.current });
    void navigate({ to: "/chat" });
  };

  return (
    <div className="flex w-full max-w-2xl flex-1 flex-col overflow-hidden">
      <div className="flex items-center justify-end gap-1 px-4 py-2">
        <ChatAnonymizedToggle enabled={anonymized} onChange={setAnonymized} />
        <Tooltip
          content={t("chat.moveToSide")}
          render={
            <Button onClick={moveToSide} size="icon-sm" variant="ghost">
              <Maximize2Icon className="size-4" />
            </Button>
          }
        />
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
              if (!ensureAIAvailable()) {
                return;
              }
              // Build the request payload first, then resolve the
              // Chat<> instance from the cache; the thread route
              // reads the *same* cached instance, so kicking off
              // `sendMessage` here lets the thread page observe
              // the in-flight stream as soon as it mounts.
              const message = await buildChatRequestMessage(draft);
              const { chat } = await queryClient.ensureQueryData(
                chatThreadOptions({
                  key: threadRef,
                  context: {
                    allowMissingThread: true,
                    getUserContext,
                    getAnonymized,
                  },
                }),
              );

              // Fire-and-forget: don't block navigation on the
              // streaming response. The thread page picks up the
              // same Chat instance from cache and renders the
              // user message + streaming reply as it arrives.
              void chat.sendMessage(message);

              await navigate({
                to: "/chat/$threadId",
                params: { threadId: threadIdRef.current },
              });
              void invalidateGroupedChatThreads(queryClient);
            }}
          />
          {byokDialog}
        </div>
        <PromptSuggestions
          onSelect={(prompt) => {
            const editor = controller.editor;
            if (!editor) {
              return;
            }
            editor.commands.setContent(prompt.body);
            editor.commands.focus("end");
          }}
          prompts={stockPrompts}
        />
      </div>
    </div>
  );
}
