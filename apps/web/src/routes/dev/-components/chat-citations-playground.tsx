import { useState } from "react";
import type { ComponentProps } from "react";

import { Button } from "@stll/ui/button";
import { RotateCcwIcon } from "@stll/ui/icons";

import { AnonymizedSpan } from "@/components/chat/anonymized-span";
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import { projectCanonicalChatUIMessages } from "@/components/chat/chat-ui-tools";
import type {
  ChatUIMessage,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { createPlaygroundChatApproval } from "@/routes/dev/-components/playground-chat-approval";

import { CHAT_CITATIONS_CASSETTE } from "./chat-citations-cassette";

const PART_INTERVAL_MS = 700;
const TEXT_CHUNKS = 24;
const TEXT_CHUNK_MS = 90;

type Frame = { isGenerating: boolean; messages: ChatUIMessage[] };

type Cassette = readonly PersistedChatMessage[];

// What the stream had delivered at each step: every process part one at a
// time, then the answer text in chunks, then the settled turn.
const buildFrames = (cassette: Cassette): Frame[] => {
  const [question, answer] = cassette;
  if (question === undefined || answer === undefined) {
    return [];
  }
  const frames: Frame[] = [];
  const withParts = (parts: PersistedChatMessage["parts"]) =>
    projectCanonicalChatUIMessages([question, { ...answer, parts }]);
  const textIndex = answer.parts.findIndex((part) => part.type === "text");
  const processParts =
    textIndex === -1 ? answer.parts : answer.parts.slice(0, textIndex);
  for (let count = 0; count <= processParts.length; count += 1) {
    frames.push({
      isGenerating: true,
      messages: withParts(processParts.slice(0, count)),
    });
  }
  const textPart = textIndex === -1 ? undefined : answer.parts[textIndex];
  if (textPart?.type === "text") {
    for (let chunk = 1; chunk <= TEXT_CHUNKS; chunk += 1) {
      const length = Math.ceil((textPart.content.length * chunk) / TEXT_CHUNKS);
      frames.push({
        isGenerating: true,
        messages: withParts([
          ...processParts,
          { ...textPart, content: textPart.content.slice(0, length) },
        ]),
      });
    }
  }
  frames.push({
    isGenerating: false,
    messages: projectCanonicalChatUIMessages([...cassette]),
  });
  return frames;
};

const noop = () => {
  /* no-op in playground */
};

// The chat page's own markdown components (`useChatSession`), so decision
// links render as the citations a real answer shows.
const STREAMDOWN_COMPONENTS = {
  a: (props: ComponentProps<"a">) => (
    <StreamdownMentionLink {...props} interactive workspaceId={undefined} />
  ),
  "stll-anon": (props: ComponentProps<"button"> & { ph?: string }) => (
    <AnonymizedSpan {...props} />
  ),
};

/**
 * A recorded answer through the real transcript renderer: inline citations,
 * quoted passages, the source tray, and the process run before them. The
 * default is the case-law turn. "Settled" is what a reload shows; "Replay"
 * streams the same turn.
 */
export function ChatCitationsPlayground({
  cassette = CHAT_CITATIONS_CASSETTE,
}: {
  cassette?: Cassette;
}) {
  const [frames] = useState(() => buildFrames(cassette));
  const lastFrame = frames.length - 1;
  const [replaying, setReplaying] = useState(false);
  const [run, setRun] = useState(0);
  const [frameIndex, setFrameIndex] = useState(lastFrame);
  const [activitySession] = useState(() => ({
    reportedUnknownActivityTypes: new Set<string>(),
  }));

  useExternalSyncEffect(() => {
    // The replay's clock is the external system.
    if (!replaying || frameIndex >= lastFrame) {
      return undefined;
    }
    const inText =
      frames[frameIndex + 1]?.messages[1]?.parts.some(
        (part) => part.type === "text",
      ) === true;
    const timeout = setTimeout(
      () => {
        setFrameIndex((index) => index + 1);
      },
      inText ? TEXT_CHUNK_MS : PART_INTERVAL_MS,
    );
    return () => {
      clearTimeout(timeout);
    };
  }, [frameIndex, frames, lastFrame, replaying, run]);

  const frame = frames[frameIndex];
  if (frame === undefined) {
    return null;
  }

  return (
    <ChatMattersContext
      value={{ createDocumentMattersView: { type: "empty" } }}
    >
      <ChatApprovalContext
        value={createPlaygroundChatApproval("dev-active-organization")}
      >
        <div className="flex max-w-4xl flex-col gap-4">
          <div className="flex items-center gap-2">
            <Button
              onClick={() => {
                setReplaying(true);
                setFrameIndex(0);
                setRun((value) => value + 1);
              }}
              size="sm"
              variant="outline"
            >
              <RotateCcwIcon />
              Replay
            </Button>
            <Button
              onClick={() => {
                setReplaying(false);
                setFrameIndex(lastFrame);
              }}
              size="sm"
              variant="ghost"
            >
              Settled
            </Button>
          </div>
          <div
            className="flex flex-col gap-3 rounded-2xl border p-4"
            data-testid="cassette-thread"
          >
            <ChatThreadMessages
              activitySession={activitySession}
              approvalPendingMessageId={null}
              isGenerating={frame.isGenerating}
              key={`run-${run}`}
              messages={frame.messages}
              onAskUserSubmit={noop}
              onCreateDocumentResolve={noop}
              onOpenCreatedDocument={noop}
              onResend={noop}
              showThinkingIndicator
              streamdownComponents={STREAMDOWN_COMPONENTS}
            />
          </div>
        </div>
      </ChatApprovalContext>
    </ChatMattersContext>
  );
}
