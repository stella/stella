import type { ModelMessage } from "@tanstack/ai";
import { panic, Result } from "better-result";

import {
  compactChatMessagesForModel,
  COMPACTION_SUMMARY_MESSAGE_ID,
  compactModelMessagesForModel,
  planChatCompaction,
  planModelCompaction,
} from "@/api/handlers/chat/compaction";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { compactionGenerationRequest } from "@/api/lib/chat/compaction-tokens";
import { HISTORY_TRIMMED_NOTICE } from "@/api/lib/chat/context-notice";
import type { ChatContextNotice } from "@/api/lib/chat/context-notice";
import type { HandlerError } from "@/api/lib/errors/tagged-errors";
import { generateTanStackTextForTask } from "@/api/lib/tanstack-ai-generate";
import type { TanStackTextFinishPolicy } from "@/api/lib/tanstack-ai-generate";
import {
  expectedTextOutcome,
  pinnedTextOutcome,
  textCallSiteDriver,
  textGenerationFailureOf,
  textGenerationOutcomeOf,
} from "@/api/tests/helpers/ai-text-replay";
import type {
  PinnedTextOutcome,
  TextCallSiteDriver,
  TextGenerationOutcome,
} from "@/api/tests/helpers/ai-text-replay";
import { testModelAdmission } from "@/api/tests/helpers/model-dispatch-admission";
import type { ProviderWireCassette } from "@/api/tests/helpers/provider-wire-cassette";
import { wireOrgAIConfig } from "@/api/tests/helpers/provider-wire-contract";

// The call sites the text replay drives (`ai-text-replay.test.ts`), each
// through its real handler, model resolution and provider adapter, with only
// `fetch` answered from a cassette.

const organizationId = toSafeId<"organization">("org_ai_text_replay");

/** An organization whose own key for the cassette's provider answers every
 *  role with the cassette's model, so the request reaches that adapter. */
const replayOrgAIConfig = ({
  model,
  provider,
}: Pick<ProviderWireCassette, "model" | "provider">) =>
  wireOrgAIConfig({
    apiKey: "cassette-replay-no-credentials",
    chatModel: model,
    provider,
  });

// --- The generation seam --------------------------------------------------

const seamDriver = (
  finishPolicy: TanStackTextFinishPolicy,
): TextCallSiteDriver =>
  textCallSiteDriver({
    name: `generateTanStackTextForTask ${finishPolicy}`,
    finishPolicy,
    run: async (cassette) => {
      const settled = await Result.tryPromise({
        try: async () =>
          await generateTanStackTextForTask({
            admission: testModelAdmission(organizationId),
            caching: { enabled: false, reason: "org-disabled" },
            dataClass: "customer",
            finishPolicy,
            managedAIResidency: "eu",
            orgAIConfig: replayOrgAIConfig(cassette),
            organizationId,
            prompt: "Summarize the lease negotiation so far.",
            serviceTier: "standard",
            task: "chat",
            tenantWorkspaceIds: [],
            userId: null,
          }),
        catch: (error: unknown) => error,
      });
      return pinnedTextOutcome(
        textGenerationOutcomeOf(settled),
        expectedTextOutcome(cassette.expect, finishPolicy),
      );
    },
    answerFor: (expected) => expected,
  });

/** `generateTanStackTextWithin`, under every finish policy a caller can
 *  choose. */
export const SEAM_DRIVERS = {
  "require-complete": seamDriver("require-complete"),
  "allow-output-ceiling": seamDriver("allow-output-ceiling"),
} as const satisfies Record<TanStackTextFinishPolicy, TextCallSiteDriver>;

// --- Chat compaction --------------------------------------------------------

/** Small enough to keep the requests short, large enough that the thread
 *  below crosses the trigger. */
const TRIGGER_TOKENS = 120;
const PRESERVE_TOKENS = 60;

const TURNS = 6;

const question = (turn: number) =>
  `Turn ${turn}: does clause ${turn + 1} of the lease put structural repairs on the landlord?`;
const answer = (turn: number) =>
  `Clause ${turn + 1} puts structural repairs on the landlord and allows a break on six months' notice.`;

const chatThread: ChatMessage[] = Array.from({ length: TURNS }, (_, turn) => [
  {
    id: toSafeId<"chatMessage">(`msg_replay_user_${turn}`),
    role: "user" as const,
    parts: [{ type: "text" as const, content: question(turn) }],
  },
  {
    id: toSafeId<"chatMessage">(`msg_replay_assistant_${turn}`),
    role: "assistant" as const,
    parts: [{ type: "text" as const, content: answer(turn) }],
  },
]).flat();

const modelThread: ModelMessage[] = Array.from({ length: TURNS }, (_, turn) => [
  { role: "user" as const, content: question(turn) },
  { role: "assistant" as const, content: answer(turn) },
]).flat();

/** How a compacted history relates to the history it was given. */
type HistoryShape =
  /** A summary, then the newest `kept` messages unchanged. */
  | { type: "summarized"; summary: string; kept: number }
  /** Only the newest messages, unchanged. */
  | { type: "trimmed" }
  | { type: "other" };

type CompactionAnswer = {
  settled: { type: "ok" } | { type: "err"; error: string };
  history: HistoryShape;
  notice: ChatContextNotice | null;
  summaryErrors: { status: number; cause: TextGenerationOutcome }[];
};

const isSuffixOf = <T>(part: readonly T[], whole: readonly T[]): boolean =>
  part.every(
    (message, index) => message === whole[whole.length - part.length + index],
  );

/** The summary a compaction summary message carries, after its header. */
const SUMMARY_SEPARATOR = "\n\n";
const summaryTextOf = (content: string): string => {
  const at = content.indexOf(SUMMARY_SEPARATOR);
  return at === -1 ? content : content.slice(at + SUMMARY_SEPARATOR.length);
};

type HistoryShapeOptions<TMessage> = {
  input: readonly TMessage[];
  messages: readonly TMessage[];
  /** The summary text `message` carries, if it is a summary message. */
  summaryOf: (message: TMessage) => string | undefined;
};

const historyShapeOf = <TMessage>({
  input,
  messages,
  summaryOf,
}: HistoryShapeOptions<TMessage>): HistoryShape => {
  const [first, ...rest] = messages;
  const summary = first === undefined ? undefined : summaryOf(first);
  if (summary !== undefined && isSuffixOf(rest, input)) {
    return { type: "summarized", summary, kept: rest.length };
  }
  if (
    messages.length > 0 &&
    messages.length < input.length &&
    isSuffixOf(messages, input)
  ) {
    return { type: "trimmed" };
  }
  return { type: "other" };
};

const COMPACTION_FINISH_POLICY = compactionGenerationRequest("").finishPolicy;

const TRIMMED = {
  history: { type: "trimmed" },
  notice: HISTORY_TRIMMED_NOTICE,
} as const;

/**
 * What a compaction answers when its summary generation settles as
 * `expected`: a summary it checkpoints, or the newest history that fits
 * with a notice saying earlier messages were left out, and the failure, if
 * there was one, reported once.
 */
const compactionAnswerFor = (
  expected: PinnedTextOutcome,
  kept: number,
): CompactionAnswer => {
  if (expected.type !== "success") {
    return {
      settled: { type: "ok" },
      ...TRIMMED,
      summaryErrors: [{ status: 500, cause: expected }],
    };
  }
  const summary =
    expected.text ?? panic("A compaction cassette states the text it answers");
  if (summary.trim() === "") {
    return { settled: { type: "ok" }, ...TRIMMED, summaryErrors: [] };
  }
  return {
    settled: { type: "ok" },
    history: { type: "summarized", summary: summary.trim(), kept },
    notice: null,
    summaryErrors: [],
  };
};

type CompactionRunOptions<TMessage> = {
  input: readonly TMessage[];
  result: Result<
    { messages: TMessage[]; notice: ChatContextNotice | null },
    HandlerError
  >;
  summaryErrors: readonly HandlerError[];
  summaryOf: (message: TMessage) => string | undefined;
};

const compactionAnswerOf = <TMessage>({
  input,
  result,
  summaryErrors,
  summaryOf,
}: CompactionRunOptions<TMessage>): CompactionAnswer => ({
  settled: Result.isOk(result)
    ? { type: "ok" }
    : { type: "err", error: Bun.inspect(result.error) },
  history: Result.isOk(result)
    ? historyShapeOf({ input, messages: result.value.messages, summaryOf })
    : { type: "other" },
  notice: Result.isOk(result) ? result.value.notice : null,
  summaryErrors: summaryErrors.map(({ cause, status }) => ({
    status,
    cause: textGenerationFailureOf(cause),
  })),
});

const compactionOptions = (cassette: ProviderWireCassette) =>
  ({
    abortSignal: new AbortController().signal,
    admission: testModelAdmission(organizationId),
    managedAIResidency: "eu",
    orgAIConfig: replayOrgAIConfig(cassette),
    organizationId,
    preserveTokens: PRESERVE_TOKENS,
    tenantWorkspaceIds: [],
    triggerTokens: TRIGGER_TOKENS,
  }) as const;

const chatPlan = planChatCompaction({
  messages: chatThread,
  preserveTokens: PRESERVE_TOKENS,
  triggerTokens: TRIGGER_TOKENS,
});
const modelPlan = planModelCompaction({
  messages: modelThread,
  preserveTokens: PRESERVE_TOKENS,
  triggerTokens: TRIGGER_TOKENS,
});

const chatCompactionDriver = textCallSiteDriver({
  name: "compactChatMessagesForModel",
  finishPolicy: COMPACTION_FINISH_POLICY,
  run: async (cassette) => {
    const summaryErrors: HandlerError[] = [];
    const result = await compactChatMessagesForModel({
      ...compactionOptions(cassette),
      boundary: { type: "raw" },
      messages: chatThread,
      onSummaryError: (error) => {
        summaryErrors.push(error);
      },
    });
    return compactionAnswerOf({
      input: chatThread,
      result,
      summaryErrors,
      summaryOf: ({ id, parts }) => {
        const part = parts.at(0);
        return id === COMPACTION_SUMMARY_MESSAGE_ID && part?.type === "text"
          ? summaryTextOf(part.content)
          : undefined;
      },
    });
  },
  answerFor: (expected) =>
    compactionAnswerFor(
      expected,
      chatPlan.type === "compact"
        ? chatPlan.recentMessages.length
        : panic("The replayed thread must cross the compaction trigger"),
    ),
});

const modelCompactionDriver = textCallSiteDriver({
  name: "compactModelMessagesForModel",
  finishPolicy: COMPACTION_FINISH_POLICY,
  run: async (cassette) => {
    const summaryErrors: HandlerError[] = [];
    const result = await compactModelMessagesForModel({
      ...compactionOptions(cassette),
      messages: modelThread,
      onSummaryError: (error) => {
        summaryErrors.push(error);
      },
      task: "chat",
    });
    return compactionAnswerOf({
      input: modelThread,
      result,
      summaryErrors,
      summaryOf: (message) =>
        !modelThread.includes(message) && typeof message.content === "string"
          ? summaryTextOf(message.content)
          : undefined,
    });
  },
  answerFor: (expected) =>
    compactionAnswerFor(
      expected,
      modelPlan.type === "compact"
        ? modelPlan.recentMessages.length
        : panic("The replayed steps must cross the compaction trigger"),
    ),
});

// --- The census -------------------------------------------------------------

/**
 * Every call site the replay drives, by file (relative to `apps/api/src`),
 * with one driver per runtime reference the file makes to a text export of
 * the generation seam.
 */
export const TEXT_CALL_SITE_DRIVERS: Readonly<
  Record<string, readonly TextCallSiteDriver[]>
> = {
  "handlers/chat/compaction.ts": [chatCompactionDriver, modelCompactionDriver],
};

/**
 * Call sites the replay does not drive yet, by the runtime references each
 * makes. The ledger only shrinks: a new call site needs drivers, a file
 * whose references change is reviewed again, and its total is pinned to
 * `PENDING_TEXT_REFERENCES`, which only goes down.
 */
export const PENDING_TEXT_CALL_SITES: Readonly<Record<string, number>> = {
  "handlers/ai-autocomplete/stream.ts": 1,
  "handlers/chat/generate-thread-title.ts": 1,
  "handlers/chat/get-suggested-prompts.ts": 1,
  "handlers/chat/improve-prompt.ts": 1,
  "handlers/chat/subagent-runner.ts": 1,
  "handlers/chat/suggest-thread-title.ts": 1,
  "handlers/chat/thread-recap.ts": 1,
  "handlers/legal-reader/answers/model.ts": 2,
  "handlers/skills/resources/rewrite.ts": 1,
  "handlers/time-entries/polish-narrative.ts": 1,
  "lib/chat/thread-compaction.ts": 1,
  "lib/docx/ai-field-generator.ts": 2,
  "lib/flows/flow-executor.ts": 1,
  "lib/properties/column-prompt-suggestion.ts": 1,
};

/** The ledger's total. Lower it with every reference driven; never raise
 *  it. */
export const PENDING_TEXT_REFERENCES = 16;
