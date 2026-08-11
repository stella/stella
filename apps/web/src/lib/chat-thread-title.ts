import { CHAT_THREAD_PLACEHOLDER_TITLE } from "@stll/api-contract";

/**
 * True when `title` is the untitled-thread sentinel (or empty). The UI shows
 * the localized `t("chat.newChat")` in its place rather than the raw
 * English sentinel the thread was persisted with.
 */
export const isPlaceholderThreadTitle = (
  title: string | null | undefined,
): boolean => !title || title === CHAT_THREAD_PLACEHOLDER_TITLE;
