import type { UiLocale } from "@stll/locales";

import { CHAT_THREAD_TITLE_MAX_LENGTH } from "@/api/db/schema";
import { isPlaceholderThreadTitle } from "@/api/handlers/chat/thread-title";

/**
 * "Forked" in every shipped UI language, matching the wording the web banner
 * (`chat.forkedFrom`) uses for the same relationship.
 *
 * A title is stored text, not a rendered string: it is written once and read
 * by every later viewer, so it cannot follow the reader's locale. The fork is
 * marked in the language of the request that created it, the same way a
 * generated title keeps the language of the conversation it summarizes.
 */
export const CHAT_FORK_TITLE_MARKERS = {
  ar: "مُفرَّعة",
  cs: "Větveno",
  de: "Verzweigt",
  en: "Forked",
  es: "Bifurcada",
  et: "Harutatud",
  fr: "Bifurquée",
  hu: "Elágazva",
  lt: "Atšakota",
  lv: "Atzarota",
  pl: "Rozgałęziono",
  "pt-BR": "Ramificada",
  sk: "Vetvené",
} as const satisfies Record<UiLocale, string>;

const FORK_TITLE_SEPARATOR = " - ";

const forkTitlePrefix = (locale: UiLocale): string =>
  `${CHAT_FORK_TITLE_MARKERS[locale]}${FORK_TITLE_SEPARATOR}`;

/**
 * A fork of a fork keeps the one marker it already carries, in whatever
 * language it was cut in, rather than stacking a second one per generation.
 */
const hasForkTitleMarker = (title: string): boolean =>
  Object.values(CHAT_FORK_TITLE_MARKERS).some((marker) =>
    title.startsWith(`${marker}${FORK_TITLE_SEPARATOR}`),
  );

type ForkedThreadTitleOptions = {
  locale: UiLocale;
  title: string;
};

/**
 * The title a fork is created with. The placeholder is returned untouched: it
 * is a sentinel the UI localizes and background titling still replaces, so a
 * marked one would strand the fork on a literal "New chat".
 */
export const forkedThreadTitle = ({
  locale,
  title,
}: ForkedThreadTitleOptions): string =>
  isPlaceholderThreadTitle(title) || hasForkTitleMarker(title)
    ? title
    : `${forkTitlePrefix(locale)}${title}`.slice(
        0,
        CHAT_THREAD_TITLE_MAX_LENGTH,
      );
