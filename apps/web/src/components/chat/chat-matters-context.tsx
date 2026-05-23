import { createContext, use } from "react";

import { panic } from "better-result";

import type { NeedsMatterMatter } from "@/components/chat/needs-matter-card";

/**
 * Read-only matter list shared by every leaf that resolves a
 * `tool-create-document` part (currently `NeedsMatterCard`).
 *
 * The list is workspace-scoped and lives on whichever component
 * owns the chat surface — `ChatThreadPage`, `ChatTabPanel`,
 * `FileChatOverlay` — so the picker can stay in the leaf without
 * those owners having to drill `createDocumentMatters` and
 * `isLoadingCreateDocumentMatters` through three intermediate
 * relays.
 *
 * `value` is `null` when no provider is mounted, which lets
 * `useChatMatters()` throw a descriptive error rather than handing
 * back undefined fields.
 */
type ChatMattersContextValue = {
  createDocumentMatters: readonly NeedsMatterMatter[];
  isLoadingCreateDocumentMatters: boolean;
};

export const ChatMattersContext = createContext<ChatMattersContextValue | null>(
  null,
);

export const useChatMatters = (): ChatMattersContextValue => {
  const value = use(ChatMattersContext);
  if (value === null) {
    panic("useChatMatters must be used inside a <ChatMattersContext> provider");
  }
  return value;
};
