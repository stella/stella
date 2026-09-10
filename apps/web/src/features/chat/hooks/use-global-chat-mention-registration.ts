import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";
import type { PublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";

import { useChatEditorExtensions } from "@/components/chat-editor-provider";
import type {
  ChatMentionOption,
  MentionCategory,
} from "@/components/chat-mention-extension";
import { useMentionProviders } from "@/components/chat-mention-providers";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";
import { useI18nStore } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { defaultCaseLawCountryForLocale } from "@/lib/case-law-route";
import {
  PublicLawUnavailableError,
  toPublicLawError,
  unwrapPublicLawEden,
} from "@/lib/public-law-api";
import { toSafeId } from "@/lib/safe-id";

const GLOBAL_CHAT_MENTION_EXTENSION_ID = "global-chat:org-mentions";

const GLOBAL_CHAT_MENTION_CATEGORIES: MentionCategory[] = ["workspace"];
const CASE_LAW_SEARCH_LIMIT = 5;
const CASE_LAW_SEARCH_MIN_LENGTH = 2;

type SearchCaseLawMentionsOptions = {
  country: PublicCaseLawCountry;
  query: string;
};

const searchCaseLawMentions = async ({
  country,
  query,
}: SearchCaseLawMentionsOptions): Promise<ChatMentionOption[]> => {
  const trimmed = query.trim();
  if (
    trimmed.length < CASE_LAW_SEARCH_MIN_LENGTH ||
    !/\p{Number}/u.test(trimmed)
  ) {
    return [];
  }

  const response = await api.case.decisions.search.post({
    country,
    query: trimmed,
    limit: CASE_LAW_SEARCH_LIMIT,
  });

  if (response.error) {
    const error = toPublicLawError(
      response.error,
      "searchPublicCaseLawMentions",
    );
    // A surface the deployment keeps off is the preview's expected answer,
    // not a defect to report on every keystroke; the picker simply has no
    // decisions to offer.
    if (!PublicLawUnavailableError.is(error)) {
      getAnalytics().captureError(error);
    }
    return [];
  }

  const data = unwrapPublicLawEden(response, "searchPublicCaseLawMentions");

  return data.hits.map((hit) => ({
    resource: resourceRef({
      type: RESOURCE_TYPE.CASE_LAW_DECISION,
      id: toSafeId<"caseLawDecision">(hit.decisionId),
    }),
    label: hit.caseNumber,
    category: "decision",
    kind: "decision",
    mimeType: null,
  }));
};

export const useGlobalChatMentionRegistration = () => {
  const { registerExtension } = useChatEditorExtensions();
  const mentionProviders = useMentionProviders();
  const publicLawPreviewEnabled = usePublicLawPreviewEnabled();
  const locale = useI18nStore((state) => state.loadedLang);
  const country = defaultCaseLawCountryForLocale(locale);

  useExternalSyncEffect(() => {
    const unregister = registerExtension(GLOBAL_CHAT_MENTION_EXTENSION_ID, {
      mentionSources: [
        {
          id: GLOBAL_CHAT_MENTION_EXTENSION_ID,
          getItems: async () =>
            await mentionProviders.getItems(GLOBAL_CHAT_MENTION_CATEGORIES),
          searchItems:
            publicLawPreviewEnabled && country !== null
              ? async (query) => await searchCaseLawMentions({ country, query })
              : undefined,
        },
      ],
    });

    return () => {
      unregister();
    };
  }, [country, mentionProviders, publicLawPreviewEnabled, registerExtension]);
};
