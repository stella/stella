import { skipToken, useQuery } from "@tanstack/react-query";
import { useLocale, useNow, useTimeZone } from "use-intl";

import { Temporal } from "@stll/time";

import {
  chatCitationAnswerText,
  chatCitationAsOf,
  chatCitationCountries,
  chatCitationLinkPairs,
  chatCitationTextKey,
} from "@/components/chat/chat-legal-citation-links.logic";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import type { LegalCitationLinkPair } from "@/components/chat/rehype-legal-citation-links";
import { api } from "@/lib/api";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { unwrapPublicLawEden } from "@/lib/public-law-api";
import { useQueryView } from "@/lib/use-query-view";
import { optionalOrganizationSettingsOptions } from "@/queries/organization-settings";

const NO_PAIRS: readonly LegalCitationLinkPair[] = [];

/** Characters the server reads; a longer answer is left unlinked. */
const ANSWER_TEXT_MAX_CHARS = 64_000;

const answerTextOf = (message: ChatUIMessage): string =>
  chatCitationAnswerText(
    message.parts.flatMap((part) =>
      part.type === "text" && part.content.trim() !== "" ? [part.content] : [],
    ),
  );

/**
 * The statute and decision citations a finished assistant answer makes,
 * resolved once by the server and kept by message id and text: a streamed
 * answer and the same answer reloaded link the same words to the same pages.
 * Nothing is fetched while the answer is still streaming, and a failed read
 * leaves the answer as written.
 */
export const useChatLegalCitationLinks = ({
  finished,
  message,
}: {
  finished: boolean;
  message: ChatUIMessage;
}): readonly LegalCitationLinkPair[] => {
  const locale = useLocale();
  const now = useNow();
  const timeZone = useTimeZone() ?? Temporal.Now.timeZoneId();
  const user = useMaybeAuthenticatedUser();
  const organizationId = user?.activeOrganizationId ?? null;
  const practice = useQueryView(
    useQuery({
      ...optionalOrganizationSettingsOptions({
        organizationId,
        userId: user?.id ?? "",
      }),
      select: (settings) => settings.practiceJurisdictions,
    }),
  );
  // A signed-in reader's jurisdictions decide before the UI language does, so
  // the answer is read once, against them, rather than first against a guess.
  // Settings that fail to load fall back to the UI language.
  const jurisdictionsSettled =
    organizationId === null || practice.type !== "pending";
  const text = answerTextOf(message);
  const countries = chatCitationCountries({
    locale,
    practiceJurisdictions: practice.type === "items" ? practice.items : [],
  });
  const asOf = chatCitationAsOf({
    createdAt: message.createdAt,
    now,
    timeZone,
  });
  const readable =
    finished &&
    jurisdictionsSettled &&
    text !== "" &&
    text.length <= ANSWER_TEXT_MAX_CHARS &&
    countries.length > 0;
  const links = useQueryView(
    useQuery({
      queryKey: [
        "chat-legal-citation-links",
        message.id,
        chatCitationTextKey(text),
        asOf,
        countries,
      ],
      queryFn: readable
        ? async ({ signal }) => {
            const response = await api.law.citations.links.post(
              { text, asOf, countries },
              { fetch: { signal } },
            );
            return unwrapPublicLawEden(response, "resolveChatCitationLinks")
              .links;
          }
        : skipToken,
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
      select: (resolved) => chatCitationLinkPairs(text, resolved),
    }),
  );
  // A failed read is not reported: the answer reads the same unlinked, and a
  // deployment with the public corpus off answers every read that way.
  return links.type === "items" ? links.items : NO_PAIRS;
};
