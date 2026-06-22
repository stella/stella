// New chat threads are persisted with an English sentinel title until
// their first message generates a real one (see the backend
// `CHAT_THREAD_PLACEHOLDER_TITLE` in
// apps/api/src/handlers/chat/thread-title.ts). The UI must show the
// localized `t("chat.newChat")` in its place rather than the raw "New
// chat". This is the single mirror of that sentinel on the client.
const CHAT_THREAD_PLACEHOLDER_TITLE = "New chat";

/** True when `title` is the untitled-thread sentinel (or empty). */
export const isPlaceholderThreadTitle = (
  title: string | null | undefined,
): boolean => !title || title === CHAT_THREAD_PLACEHOLDER_TITLE;
