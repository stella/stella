import { useEffect } from "react";

import { useChatEditorExtensions } from "@/components/chat-editor-provider";
import type { MentionCategory } from "@/components/chat-mention-extension";
import { useMentionProviders } from "@/components/chat-mention-providers";

const GLOBAL_CHAT_MENTION_EXTENSION_ID = "global-chat:org-mentions";

const GLOBAL_CHAT_MENTION_CATEGORIES: MentionCategory[] = ["workspace"];

export const useGlobalChatMentionRegistration = () => {
  const { registerExtension } = useChatEditorExtensions();
  const mentionProviders = useMentionProviders();

  useEffect(() => {
    const unregister = registerExtension(GLOBAL_CHAT_MENTION_EXTENSION_ID, {
      mentionSources: [
        {
          id: GLOBAL_CHAT_MENTION_EXTENSION_ID,
          getItems: () =>
            mentionProviders.getItems(GLOBAL_CHAT_MENTION_CATEGORIES),
        },
      ],
    });

    return () => {
      unregister();
    };
  }, [mentionProviders, registerExtension]);
};
