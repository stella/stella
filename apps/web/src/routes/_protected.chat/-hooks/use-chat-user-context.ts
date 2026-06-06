import { useLocale } from "use-intl";

import { useAuthenticatedUser } from "@/lib/authenticated-user-context";

export type ChatUserContext = {
  userName: string;
  locale: string;
  timezone: string;
  wordEditAuthorName: string;
  wordEditShortcut: string;
};

const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

type WordEditUser = {
  name?: string | null | undefined;
  preferredName?: string | null | undefined;
  wordEditShortcut?: string | null | undefined;
};

export const getWordEditAuthorName = (user: WordEditUser): string => {
  const preferredName = user.preferredName?.trim();
  if (preferredName) {
    return preferredName;
  }

  return user.name?.trim() ?? "";
};

export const getWordEditShortcut = (user: WordEditUser): string =>
  user.wordEditShortcut?.trim() ?? "";

/** Collect user context for the chat transport. */
export const useChatUserContext = (): ChatUserContext => {
  const user = useAuthenticatedUser();
  const locale = useLocale();
  return {
    userName: user.name ?? "",
    locale,
    timezone: BROWSER_TIMEZONE,
    wordEditAuthorName: getWordEditAuthorName(user),
    wordEditShortcut: getWordEditShortcut(user),
  };
};
