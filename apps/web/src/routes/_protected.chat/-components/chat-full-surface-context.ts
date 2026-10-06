import { createContext, use } from "react";

import { panic } from "better-result";

import type { PromptSuggestion } from "@/lib/prompts/types";

export const ChatFullSurfaceContext = createContext<{
  selectPrompt: (prompt: PromptSuggestion) => void;
  focusComposer: () => void;
} | null>(null);

export const useChatFullSurface = () =>
  use(ChatFullSurfaceContext) ??
  panic("Chat landing requires its persistent surface");
