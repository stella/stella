import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon } from "lucide-react";

import { cn } from "@stella/ui/lib/utils";

import { Message, MessageContent } from "@/components/ai-elements/message";
import { useDevStore } from "@/lib/dev-store";
import { useSuspenseChatActor } from "@/routes/_protected.chat/-hooks/chat-actor-provider";

type SystemPromptMessageProps = {
  threadId: string;
};

/** Renders the system prompt as a collapsible dev-only
 *  message at the top of the conversation. */
export const SystemPromptMessage = ({ threadId }: SystemPromptMessageProps) => {
  const showToolCalls = useDevStore((s) => s.showToolCalls);
  const [expanded, setExpanded] = useState(false);
  const actor = useSuspenseChatActor();

  const { data: prompt } = useQuery({
    queryKey: ["chat", "system-prompt", threadId],
    queryFn: async () => {
      const result = await actor.connection.getSystemPrompt({
        threadId,
      });
      return result?.prompt ?? null;
    },
    enabled: showToolCalls,
  });

  if (!showToolCalls || !prompt) {
    return null;
  }

  return (
    <Message from="system">
      <MessageContent>
        <button
          className="flex w-full items-center gap-1.5 text-start"
          onClick={() => setExpanded((e) => !e)}
          type="button"
        >
          <span className="flex-1 font-medium">System prompt</span>
          <ChevronDownIcon
            className={cn(
              "size-3 shrink-0 transition-transform",
              expanded && "rotate-180",
            )}
          />
        </button>
        {expanded && (
          <pre className="mt-1 max-h-60 overflow-auto font-mono text-[11px] whitespace-pre-wrap">
            {prompt}
          </pre>
        )}
      </MessageContent>
    </Message>
  );
};
