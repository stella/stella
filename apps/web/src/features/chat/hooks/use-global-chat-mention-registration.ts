import { useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { RESOURCE_TYPE, resourceRef } from "@stll/api-contract";
import type { ChatCorpusScope } from "@stll/api-contract";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";
import type { PublicCaseLawCountry } from "@stll/api-contract/case-law-launch-readiness";
import { isPublicCountry } from "@stll/api-contract/public-country-capability";
import type { PublicCountry } from "@stll/api-contract/public-country-capability";

import {
  CHAT_MENTION_SOURCE_LABELS,
  useChatEditorExtensions,
} from "@/components/chat-editor-provider";
import type {
  ChatMentionOption,
  MentionCategory,
} from "@/components/chat-mention-extension";
import { useMentionProviders } from "@/components/chat-mention-providers";
import { buildSourceMentionOptions } from "@/features/chat/chat-source-mentions";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { usePublicLawPreviewEnabled } from "@/hooks/use-public-law-preview";
import { useFormatter } from "@/i18n/formatting-context";
import { useI18nStore } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  caseLawCountryName,
  defaultCaseLawCountryForLocale,
} from "@/lib/case-law-route";
import {
  mcpConnectionsOptions,
  mcpConnectorsOptions,
} from "@/lib/knowledge/queries";
import {
  PublicLawUnavailableError,
  toPublicLawError,
  unwrapPublicLawResponse,
} from "@/lib/public-law-api";
import { toSafeId } from "@/lib/safe-id";
import {
  isPublicStatuteCountry,
  STATUTE_COUNTRIES,
  statuteCountryName,
} from "@/lib/statutes/statute-route";

const GLOBAL_CHAT_MENTION_EXTENSION_ID = "global-chat:org-mentions";

const GLOBAL_CHAT_MENTION_CATEGORIES: MentionCategory[] = ["workspace"];
const CASE_LAW_SEARCH_LIMIT = 5;

/** The corpora a Sources chip can name: every public country of each. */
const CASE_LAW_SOURCE_COUNTRIES: readonly PublicCountry[] =
  PUBLIC_CASE_LAW_COUNTRIES;
const LEGISLATION_SOURCE_COUNTRIES = Object.keys(STATUTE_COUNTRIES)
  .filter(isPublicStatuteCountry)
  .map((segment) => segment.toUpperCase())
  .filter(isPublicCountry);
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

  const data = unwrapPublicLawResponse(response, "searchPublicCaseLawMentions");

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

/** "Case law · Czechia": the chip text of a corpus scope. */
const corpusLabelFor =
  (
    t: ReturnType<typeof useTranslations<"chat.mention.corpus">>,
    format: ReturnType<typeof useFormatter>,
  ) =>
  (scope: ChatCorpusScope): string =>
    scope.corpus === "case_law"
      ? t("caseLaw", { country: caseLawCountryName(format, scope.country) })
      : t("legislation", {
          country: statuteCountryName(format, scope.country.toLowerCase()),
        });

type LoadSourceMentionsOptions = {
  corpusLabel: (scope: ChatCorpusScope) => string;
  organizationId: string;
  publicLawPreviewEnabled: boolean;
  queryClient: QueryClient;
  userId: string;
};

/**
 * The Sources group: public corpora (when the public-law preview is on), the
 * organization's enabled registries and the user's active connectors, read
 * through the same cached queries the connector settings use. A failed read
 * leaves its sources out rather than the whole picker.
 */
const loadSourceMentions = async ({
  corpusLabel,
  organizationId,
  publicLawPreviewEnabled,
  queryClient,
  userId,
}: LoadSourceMentionsOptions): Promise<ChatMentionOption[]> => {
  const [catalog, connections] = await Promise.all([
    Result.tryPromise(
      async () => await queryClient.query(mcpConnectorsOptions(organizationId)),
    ),
    Result.tryPromise(
      async () =>
        await queryClient.query(mcpConnectionsOptions(organizationId, userId)),
    ),
  ]);
  if (Result.isError(catalog)) {
    getAnalytics().captureError(catalog.error);
  }
  if (Result.isError(connections)) {
    getAnalytics().captureError(connections.error);
  }
  const connectorCatalog = Result.isOk(catalog) ? catalog.value : null;
  return buildSourceMentionOptions({
    caseLawCountries: publicLawPreviewEnabled ? CASE_LAW_SOURCE_COUNTRIES : [],
    legislationCountries: publicLawPreviewEnabled
      ? LEGISLATION_SOURCE_COUNTRIES
      : [],
    corpusLabel,
    catalog: connectorCatalog,
    connections: Result.isOk(connections) ? connections.value.connections : [],
  });
};

export const useGlobalChatMentionRegistration = () => {
  const { registerExtension } = useChatEditorExtensions();
  const mentionProviders = useMentionProviders();
  const publicLawPreviewEnabled = usePublicLawPreviewEnabled();
  const locale = useI18nStore((state) => state.loadedLang);
  const country = defaultCaseLawCountryForLocale(locale);
  const queryClient = useQueryClient();
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const tCorpus = useTranslations("chat.mention.corpus");
  const format = useFormatter();

  useExternalSyncEffect(() => {
    const unregister = registerExtension(GLOBAL_CHAT_MENTION_EXTENSION_ID, {
      mentionSources: [
        {
          id: GLOBAL_CHAT_MENTION_EXTENSION_ID,
          labelKey: CHAT_MENTION_SOURCE_LABELS.context,
          // Matters, then the static Sources. Like every local item, a
          // source is offered once the reader types after "@".
          getItems: async () => {
            const [contextItems, sourceItems] = await Promise.all([
              mentionProviders.getItems(GLOBAL_CHAT_MENTION_CATEGORIES),
              loadSourceMentions({
                corpusLabel: corpusLabelFor(tCorpus, format),
                organizationId: activeOrganizationId,
                publicLawPreviewEnabled,
                queryClient,
                userId,
              }),
            ]);
            return [...contextItems, ...sourceItems];
          },
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
  }, [
    activeOrganizationId,
    country,
    format,
    mentionProviders,
    publicLawPreviewEnabled,
    queryClient,
    registerExtension,
    tCorpus,
    userId,
  ]);
};
