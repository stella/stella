import type { UIMessage } from "@tanstack/ai-client";

/** A replay rebuilds the active assistant from its first event. Keep the
 * already displayed prefix until that same message catches up. */
export const keepShownRejoinMessages = <Message extends UIMessage>(
  shown: readonly Message[],
  replayed: Message[],
): Message[] => {
  const assistant = shown.at(-1);
  if (assistant?.role !== "assistant") {
    return replayed;
  }
  const candidate = replayed.find(({ id }) => id === assistant.id);
  if (candidate === undefined) {
    return [...replayed, assistant];
  }
  const text = (message: Message) =>
    message.parts
      .flatMap((part) =>
        part.type === "text" || part.type === "thinking" ? [part.content] : [],
      )
      .join("");
  const previousText = text(assistant);
  const nextText = text(candidate);
  if (
    nextText.length >= previousText.length ||
    !previousText.startsWith(nextText)
  ) {
    return replayed;
  }
  return replayed.map((message) =>
    message.id === assistant.id ? assistant : message,
  );
};
