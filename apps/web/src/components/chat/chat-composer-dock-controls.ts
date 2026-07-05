import type { ChatContextUsage } from "@/components/chat/chat-context-meter";

/**
 * The minimal slice of a `chatThreadOptions` result that drives the
 * composer status row. Every chat surface already holds this (from the
 * thread query, or the pre-thread draft-meta fetch on the new-chat
 * hero), so the dock derives the standard control set from it instead
 * of each surface hand-picking which toggles to render.
 */
export type ChatComposerDockData = {
  webSearchAvailable: boolean;
  webSearchEnabled: boolean;
  context: ChatContextUsage | null;
};

/**
 * Which of the derived controls the dock renders for a given thread.
 * The anonymize shield and the context meter are intentionally absent:
 * both render unconditionally on every surface (the shield because the
 * privacy affordance must never disappear; the meter because the ring
 * is present from the first empty thread, showing 0% until an estimate
 * exists), so their presence is an invariant, not a decision.
 */
export type ChatComposerDockControls = {
  showWebSearch: boolean;
};

// Single source of truth for the presence rules so the component and
// its test can never drift: the globe follows web-search availability.
export const resolveChatComposerDockControls = ({
  webSearchAvailable,
}: Pick<
  ChatComposerDockData,
  "webSearchAvailable"
>): ChatComposerDockControls => ({
  showWebSearch: webSearchAvailable,
});
