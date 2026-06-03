import { useEffect } from "react";

import { useChatEditorExtensions } from "@/components/chat-editor-provider";
import type {
  ChatMentionOption,
  MentionCategory,
} from "@/components/chat-mention-extension";
import { useMentionProviders } from "@/components/chat-mention-providers";
import { api } from "@/lib/api";
import { assertPublicLawApiData } from "@/lib/public-law-api";

const GLOBAL_CHAT_MENTION_EXTENSION_ID = "global-chat:org-mentions";

const GLOBAL_CHAT_MENTION_CATEGORIES: MentionCategory[] = ["workspace"];
const CASE_LAW_SEARCH_LIMIT = 5;
const CASE_LAW_SEARCH_MIN_LENGTH = 2;

const searchCaseLawMentions = async (
  query: string,
): Promise<ChatMentionOption[]> => {
  const trimmed = query.trim();
  if (
    trimmed.length < CASE_LAW_SEARCH_MIN_LENGTH ||
    !/\p{Number}/u.test(trimmed)
  ) {
    return [];
  }

  const response = await api.case.decisions.search.post({
    query: trimmed,
    limit: CASE_LAW_SEARCH_LIMIT,
  });

  if (response.error) {
    return [];
  }
  const data = response.data;
  assertPublicLawApiData(data, "searchPublicCaseLawMentions");

  return data.hits.map((hit) => ({
    id: hit.decisionId,
    label: hit.caseNumber,
    category: "decision",
    kind: "decision",
    mimeType: null,
  }));
};

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
          searchItems: searchCaseLawMentions,
        },
      ],
    });

    return () => {
      unregister();
    };
  }, [mentionProviders, registerExtension]);
};
