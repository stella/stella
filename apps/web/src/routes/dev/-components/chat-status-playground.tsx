import { useState } from "react";

import {
  CHAT_STEP_LEDGER_KEY,
  type ChatStepLedger,
} from "@stll/api-contract/chat-step-ledger";
import { Button } from "@stll/ui/button";
import { RotateCcwIcon } from "@stll/ui/icons";

import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import { projectCanonicalChatUIMessages } from "@/components/chat/chat-ui-tools";
import type {
  ChatToolCallPart,
  ChatUIMessage,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { StreamdownMentionLink } from "@/components/chat/streamdown-mention-link";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { createPlaygroundChatApproval } from "@/routes/dev/-components/playground-chat-approval";

const QUESTION = {
  id: "status-user-1",
  parts: [
    {
      type: "text",
      content:
        "Is the seller's indemnity cap in this share purchase agreement market standard?",
    },
  ],
  role: "user",
} satisfies PersistedChatMessage;

const THINKING = {
  type: "thinking",
  content:
    "The cap sits in clause 11.2. I should read it, compare it with the playbook, and check whether the carve-outs escape it.",
} as const;

// The plan the chat prompt asks for before the first step (`PLAN LINE`).
const PLAN = {
  type: "text",
  content:
    "I'll read the cap in clause 11.2 and compare it, and its carve-outs, with what we usually accept for a share deal.",
} as const;

const searchHistory = (
  state: "complete" | "input-complete",
): ChatToolCallPart => ({
  type: "tool-call",
  id: "status-tool-history",
  name: "search-chat-history",
  arguments: JSON.stringify({ query: "indemnity cap" }),
  state,
  input: { query: "indemnity cap" },
  ...(state === "complete"
    ? { output: { query: "indemnity cap", results: [] } }
    : {}),
});

const readSection = (
  state: "complete" | "input-complete",
): ChatToolCallPart => ({
  type: "tool-call",
  id: "status-tool-section",
  name: "read_section",
  arguments: JSON.stringify({ section: "11.2" }),
  state,
  input: { section: "11.2" },
  ...(state === "complete"
    ? { output: { error: "Section 11.2 was renumbered in this version." } }
    : {}),
});

const readDocument = (
  state: "complete" | "input-complete",
): ChatToolCallPart => ({
  type: "tool-call",
  id: "status-tool-document",
  name: "read_document",
  arguments: JSON.stringify({ query: "limitation of liability" }),
  state,
  input: { query: "limitation of liability" },
  ...(state === "complete"
    ? { output: { text: "11.3 The Seller's aggregate liability…" } }
    : {}),
});

const ANSWER = {
  type: "text",
  content:
    "The cap is 30% of the purchase price, at the low end of what we usually accept for a share deal of this size. Tax and environmental claims sit outside it, so the real exposure is higher than the headline figure.",
} as const;

type Frame = {
  durationMs: number;
  isGenerating: boolean;
  parts: PersistedChatMessage["parts"];
};

// One assistant turn, replayed: waiting, reasoning, three tool calls (one
// fails), then the answer. Each frame is what the stream would have
// delivered by then.
const FRAMES: readonly Frame[] = [
  { durationMs: 1600, isGenerating: true, parts: [] },
  { durationMs: 2200, isGenerating: true, parts: [THINKING] },
  { durationMs: 1000, isGenerating: true, parts: [THINKING, PLAN] },
  {
    durationMs: 1800,
    isGenerating: true,
    parts: [THINKING, PLAN, searchHistory("input-complete")],
  },
  {
    durationMs: 1800,
    isGenerating: true,
    parts: [
      THINKING,
      PLAN,
      searchHistory("complete"),
      readSection("input-complete"),
    ],
  },
  {
    durationMs: 2000,
    isGenerating: true,
    parts: [
      THINKING,
      PLAN,
      searchHistory("complete"),
      readSection("complete"),
      readDocument("input-complete"),
    ],
  },
  {
    durationMs: 1400,
    isGenerating: true,
    parts: [
      THINKING,
      PLAN,
      searchHistory("complete"),
      readSection("complete"),
      readDocument("complete"),
      ANSWER,
    ],
  },
  {
    durationMs: 0,
    isGenerating: false,
    parts: [
      THINKING,
      PLAN,
      searchHistory("complete"),
      readSection("complete"),
      readDocument("complete"),
      ANSWER,
    ],
  },
];

const LAST_FRAME = FRAMES.length - 1;

// The same turn, ended at the failed step without an answer, as a reload
// shows it: the one case where the failure is the result.
const ENDED_AT_FAILURE_FRAME: Frame = {
  durationMs: 0,
  isGenerating: false,
  parts: [THINKING, searchHistory("complete"), readSection("complete")],
};

// A code step whose second search did not go through, with the ledger the
// server records beside the script's own (failed) result.
const FAILED_CODE_SEARCH_INPUT = {
  typescriptCode: [
    'const a = await external_search_case_law({ queries: ["limitation of liability cap share purchase"], country: "CZE" });',
    'const b = await external_search_case_law({ queries: ["indemnity cap carve-outs"], country: "CZE", courts: ["NS"], date_from: "2020-01-01" });',
    "return { a, b };",
  ].join("\n"),
};

const failedCodeSearch: ChatToolCallPart = {
  type: "tool-call",
  id: "status-tool-code-search",
  name: "execute_typescript",
  arguments: JSON.stringify(FAILED_CODE_SEARCH_INPUT),
  state: "complete",
  input: FAILED_CODE_SEARCH_INPUT,
  output: {
    success: false,
    error: { message: "Court filter matched no court", name: "Error" },
    logs: [],
    [CHAT_STEP_LEDGER_KEY]: {
      calls: [
        {
          tool: "search_case_law",
          queries: ["limitation of liability cap share purchase"],
          filters: [{ kind: "country", value: "CZE" }],
          outcome: "ok",
          found: [],
          foundOmitted: 0,
        },
        {
          tool: "search_case_law",
          queries: ["indemnity cap carve-outs"],
          filters: [
            { kind: "country", value: "CZE" },
            { kind: "court", value: "NS" },
            { kind: "dateFrom", value: "2020-01-01" },
          ],
          outcome: "error",
          found: [],
          foundOmitted: 0,
        },
      ],
      callsOmitted: 0,
    } satisfies ChatStepLedger,
  },
};

const ENDED_AT_FAILED_CODE_STEP_FRAME: Frame = {
  durationMs: 0,
  isGenerating: false,
  parts: [THINKING, failedCodeSearch],
};

// The chat page's transcript rhythm (`ConversationContent` gap-3), so the
// fixture spaces messages the way the product does.
const THREAD_FRAME_CLASS =
  "bg-popover/40 flex flex-col gap-3 rounded-2xl border p-4";

const toMessages = (frame: Frame): ChatUIMessage[] =>
  projectCanonicalChatUIMessages([
    QUESTION,
    { id: "status-assistant-1", parts: frame.parts, role: "assistant" },
  ]);

const noop = () => {
  /* no-op in playground */
};

/**
 * The real transcript renderer driven through one scripted turn, so the
 * status marks, the live step summary and its timer can be judged moving
 * in place. The settled thread below is what a reload shows: no timers,
 * nothing animating.
 */
export function ChatStatusPlayground() {
  const [run, setRun] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const [activitySession] = useState(() => ({
    reportedUnknownActivityTypes: new Set<string>(),
  }));
  const frame = FRAMES[Math.min(frameIndex, LAST_FRAME)] ?? FRAMES[0];

  useExternalSyncEffect(() => {
    // The script's clock is the external system: each frame schedules the
    // next, and a replay restarts it.
    const current = FRAMES[frameIndex];
    if (frameIndex >= LAST_FRAME || current === undefined) {
      return undefined;
    }
    const timeout = setTimeout(() => {
      setFrameIndex((index) => index + 1);
    }, current.durationMs);
    return () => {
      clearTimeout(timeout);
    };
  }, [frameIndex, run]);

  if (frame === undefined) {
    return null;
  }

  const thread = (key: string, shown: Frame, showToolCalls: boolean) => (
    <ChatThreadMessages
      activitySession={activitySession}
      approvalPendingMessageId={null}
      isGenerating={shown.isGenerating}
      key={key}
      messages={toMessages(shown)}
      onAskUserSubmit={noop}
      onCreateDocumentResolve={noop}
      onOpenCreatedDocument={noop}
      onResend={noop}
      showToolCalls={showToolCalls}
      streamdownComponents={{
        a: (props) => <StreamdownMentionLink {...props} interactive={false} />,
      }}
    />
  );

  return (
    <ChatMattersContext
      value={{ createDocumentMattersView: { type: "empty" } }}
    >
      <ChatApprovalContext
        value={createPlaygroundChatApproval("dev-active-organization")}
      >
        <div className="flex max-w-3xl flex-col gap-6">
          <div className="flex items-center gap-3">
            <Button
              onClick={() => {
                setFrameIndex(0);
                setRun((value) => value + 1);
              }}
              size="sm"
              variant="outline"
            >
              <RotateCcwIcon />
              Replay turn
            </Button>
          </div>
          <section className="flex flex-col gap-2" data-testid="live-folded">
            <h2 className="text-muted-foreground text-xs font-medium">
              Live turn, steps folded (default)
            </h2>
            <div className={THREAD_FRAME_CLASS}>
              {thread(`folded-${run}`, frame, false)}
            </div>
          </section>
          <section className="flex flex-col gap-2" data-testid="live-open">
            <h2 className="text-muted-foreground text-xs font-medium">
              Live turn, steps open
            </h2>
            <div className={THREAD_FRAME_CLASS}>
              {thread(`open-${run}`, frame, true)}
            </div>
          </section>
          <section className="flex flex-col gap-2" data-testid="settled">
            <h2 className="text-muted-foreground text-xs font-medium">
              Reloaded thread
            </h2>
            <div className={THREAD_FRAME_CLASS}>
              {thread("settled", FRAMES[LAST_FRAME] ?? frame, true)}
            </div>
          </section>
          <section
            className="flex flex-col gap-2"
            data-testid="terminal-failure"
          >
            <h2 className="text-muted-foreground text-xs font-medium">
              Turn ended at a failed step
            </h2>
            <div className={THREAD_FRAME_CLASS}>
              {thread("ended-at-failure", ENDED_AT_FAILURE_FRAME, true)}
            </div>
          </section>
          <section
            className="flex flex-col gap-2"
            data-testid="failed-code-step"
          >
            <h2 className="text-muted-foreground text-xs font-medium">
              Turn ended at a code step whose search failed
            </h2>
            <div className={THREAD_FRAME_CLASS}>
              {thread(
                "ended-at-failed-code-step",
                ENDED_AT_FAILED_CODE_STEP_FRAME,
                true,
              )}
            </div>
          </section>
        </div>
      </ChatApprovalContext>
    </ChatMattersContext>
  );
}
