import { useState } from "react";

import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";

import { Button } from "@stll/ui/components/button";

import { SuggestedActions } from "@/components/suggested-actions";

// A user + assistant exchange is the minimum to have something to suggest from.
const SUGGESTIONS_MIN_MESSAGE_COUNT = 2;

type SuggestedFollowupChipsProps = {
  isGenerating: boolean;
  isEmpty: boolean;
  lastMessageId: string | null;
  lastMessageRole: "user" | "assistant" | "system" | "tool" | null;
  messageCount: number;
  prompts: string[];
  /**
   * Called when a chip is clicked. The caller is responsible for setting the
   * editor content and submitting via `controller.submit` so the normal
   * `clearDraft` / `clearContent` path runs.
   */
  onSelect: (prompt: string) => void;
};

/**
 * Suggested follow-up prompts above the chat composer, shown when the
 * composer is empty, the AI has just responded, and no generation is in
 * progress. Only the first prompt is shown; a toggle reveals the rest.
 * They disappear once the user starts typing or submits a message.
 */
export const SuggestedFollowupChips = ({
  isGenerating,
  isEmpty,
  lastMessageId,
  lastMessageRole,
  messageCount,
  prompts,
  onSelect,
}: SuggestedFollowupChipsProps) => {
  const [expanded, setExpanded] = useState(false);

  const eligible =
    isEmpty &&
    !isGenerating &&
    lastMessageId !== null &&
    lastMessageRole === "assistant" &&
    messageCount >= SUGGESTIONS_MIN_MESSAGE_COUNT;

  if (!eligible) {
    return null;
  }

  const visiblePrompts = expanded ? prompts : prompts.slice(0, 1);
  const hiddenCount = prompts.length - visiblePrompts.length;

  return (
    <SuggestedActions
      actions={visiblePrompts.map((prompt) => ({ id: prompt, label: prompt }))}
      className="pb-2"
      footer={
        prompts.length > 1 ? (
          <Button
            aria-expanded={expanded}
            aria-label={
              expanded ? "Show fewer suggestions" : "Show more suggestions"
            }
            className="text-muted-foreground hover:text-foreground bg-background/70 h-7 gap-1 rounded-full px-2.5 text-xs backdrop-blur-sm"
            onClick={() => setExpanded((value) => !value)}
            size="sm"
            type="button"
            variant="ghost"
          >
            {expanded ? (
              <ChevronUpIcon className="size-3.5" />
            ) : (
              <>
                <ChevronDownIcon className="size-3.5" />
                {hiddenCount}
              </>
            )}
          </Button>
        ) : undefined
      }
      label="Suggested follow-up prompts"
      onSelect={onSelect}
      surface="overlay"
    />
  );
};
