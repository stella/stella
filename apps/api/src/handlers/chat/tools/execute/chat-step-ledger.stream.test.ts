import { EventType, maxIterations } from "@tanstack/ai";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CHAT_STEP_LEDGER_KEY,
  type ChatStepLedger,
  readChatStepLedger,
} from "@stll/api-contract/chat-step-ledger";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { settleHistoryForRun } from "@/api/handlers/chat/chat-turn-settlement";
import { guardProviderHistory } from "@/api/handlers/chat/provider-history";
import {
  processServerChatStream,
  toChatMessage,
} from "@/api/handlers/chat/stream-chat";
import { createTurnMessageIdMapper } from "@/api/handlers/chat/stream-message-identity";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { withProviderStreamContract } from "@/api/lib/chat/provider-stream-contract";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { streamChatChunks } from "@/api/lib/chat/tanstack-chat-runtime";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  scriptedAdapterBase,
  scriptedTurnChunks,
} from "@/api/tests/helpers/chat-round-trip";
import type { ScriptedTurn } from "@/api/tests/helpers/chat-round-trip";

import { createChatCodeModeSurface } from "./chat-code-mode";
import type { ChatCodeModeReadRunner } from "./chat-code-mode";
import { registerSandboxTestHygiene } from "./sandbox/sandbox-test-hygiene";

// The real code-mode tool in the real SDK loop, folded into the message the
// turn stores by the persistence path `streamChat` runs. Only the model and
// the registry reads are scripted.
registerSandboxTestHygiene();

const DECISION_ID = "f46d5994-ab9f-5a53-8172-80d000959426";

const HIT = {
  url: "https://app.example.test/law/cze/cases/ustavni-soud/iii-us-2429-24",
  caseNumber: "III.ÚS 2429/24",
  country: "CZE",
  court: "Ústavní soud",
  courtAbbreviation: "ÚS",
  decisionDate: "2026-04-15T00:00:00.000Z",
  decisionId: DECISION_ID,
  ecli: "ECLI:CZ:US:2026:3.US.2429.24.1",
  headnote: { type: "present", text: "Zákonný soudce.", truncated: false },
};

/** search_case_law answers one hit; read_case_law_decision fails. */
const runReadTool: ChatCodeModeReadRunner = async (toolName, args, step) => {
  await Promise.resolve();
  if (toolName === "search_case_law") {
    step.answered({ args, data: { results: [HIT] } });
    return Result.ok({ results: [HIT] });
  }
  return Result.err(
    new ChatToolError({ kind: "not-found", message: "No such decision." }),
  );
};

const surface = () =>
  createChatCodeModeSurface({
    concurrencyKey: "step-ledger-stream-test",
    documentedReads: ["search_case_law", "read_case_law_decision"],
    runReadTool,
  });

const SCRIPT = [
  `const r = await external_search_case_law({ queries: ["zákonný soudce dovolání"], country: "CZE", courts: ["ÚS"] });`,
  `try { await external_read_case_law_decision({ decision_ids: ["missing"] }); } catch {}`,
  `return JSON.stringify(r).slice(0, 40);`,
].join("\n");

const STORED_ASSISTANT_ID = toSafeId<"chatMessage">(
  "11111111-1111-4111-8111-111111111111",
);

/** The tool results one model call was handed, parsed. */
const toolResultsOf = (messages: readonly ModelMessage[]): unknown[] =>
  messages.flatMap((message): unknown[] => {
    if (message.role !== "tool" || typeof message.content !== "string") {
      return [];
    }
    const parsed: unknown = JSON.parse(message.content);
    return [parsed];
  });

/**
 * The stream as the run produced it, keeping each tool result it carried:
 * what the page receives live for the step.
 *
 * @yields Every chunk of `source`, unchanged.
 */
const tapToolResults = async function* <TChunk extends StreamChunk>(
  source: AsyncIterable<TChunk>,
  results: unknown[],
): AsyncIterable<TChunk> {
  for await (const chunk of source) {
    if (chunk.type === EventType.TOOL_CALL_RESULT) {
      const { content } = chunk;
      const parsed: unknown =
        typeof content === "string" ? JSON.parse(content) : content;
      results.push(parsed);
    }
    yield chunk;
  }
};

const runAndStore = async ({
  history,
  turns,
}: {
  history: ChatMessage[];
  turns: readonly ScriptedTurn[];
}) => {
  const requests: (readonly ModelMessage[])[] = [];
  const toolResults: unknown[] = [];
  const adapter = withProviderStreamContract({
    ...scriptedAdapterBase,
    async *chatStream({ messages, model, runId, threadId }) {
      requests.push(messages);
      const turn =
        turns.at(requests.length - 1) ??
        panic("The request asked the model more often than scripted");
      yield* scriptedTurnChunks(turn, {
        index: requests.length - 1,
        model,
        runId: runId ?? "run-1",
        threadId,
      });
    },
    structuredOutput: () => panic("No structured output in this test"),
  });
  const initialMessages = settleHistoryForRun({
    messages: history,
    resumedMessageId: undefined,
  });
  const { processor, message } = createStreamMessageCapture({
    initialMessages,
    capture: toChatMessage,
  });
  const deadline = new AbortController();
  const finished: { message: ChatMessage | null } = { message: null };
  for await (const _chunk of processServerChatStream({
    abortSignal: deadline.signal,
    deadlineSignal: deadline.signal,
    getResponseMessage: message,
    initialMessages,
    mapMessageId: createTurnMessageIdMapper(STORED_ASSISTANT_ID),
    onFinish: ({ responseMessage }) => {
      finished.message = responseMessage;
    },
    processor,
    source: tapToolResults(
      streamChatChunks({
        threadId: "step-ledger-thread",
        adapter,
        agentLoopStrategy: maxIterations(4),
        messages: guardProviderHistory({
          messages: initialMessages,
          workspaceIds: [],
        }),
        tools: [surface().tool],
      }),
      toolResults,
    ),
  })) {
    // Drained so the turn settles and stores its message.
  }
  return {
    requests,
    toolResults,
    stored: finished.message ?? panic("The request stored no message"),
  };
};

const codeCall = (code: string): ScriptedTurn => ({
  type: "tool-call",
  toolCallId: "code-1",
  toolName: "execute_typescript",
  arguments: JSON.stringify({ typescriptCode: code }),
});

const question: ChatMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", content: "Co říká Ústavní soud?" }],
};

const storedCallOutput = (message: ChatMessage): unknown =>
  message.parts.find((part) => part.type === "tool-call")?.output;

describe("a code step's ledger", () => {
  test(
    "is on the live result and the stored step alike, survives a reload, and never reaches the model",
    async () => {
      const { requests, toolResults, stored } = await runAndStore({
        history: [question],
        turns: [
          codeCall(SCRIPT),
          { type: "text", text: "Hotovo.", finishReason: "stop" },
        ],
      });

      const expected = {
        calls: [
          {
            tool: "search_case_law",
            queries: ["zákonný soudce dovolání"],
            filters: [
              { kind: "country", value: "CZE" },
              { kind: "court", value: "ÚS" },
            ],
            outcome: "ok",
            found: [
              {
                type: "decision",
                decisionId: DECISION_ID,
                caseNumber: "III.ÚS 2429/24",
                court: "Ústavní soud",
                courtAbbreviation: "ÚS",
                country: "CZE",
                decisionDate: "2026-04-15",
                ecli: "ECLI:CZ:US:2026:3.US.2429.24.1",
                summary: "Zákonný soudce.",
                url: HIT.url,
                sourceUrl: null,
              },
            ],
            foundOmitted: 0,
          },
          {
            tool: "read_case_law_decision",
            queries: [],
            filters: [],
            outcome: "error",
            found: [],
            foundOmitted: 0,
          },
        ],
        callsOmitted: 0,
      } satisfies ChatStepLedger;
      // Live: the result the stream carried for the step.
      expect(toolResults.map(readChatStepLedger)).toEqual([expected]);
      // Stored: the step the turn persisted.
      expect(readChatStepLedger(storedCallOutput(stored))).toEqual(expected);
      // Reload: the same step read back from its stored content.
      // The stored row is JSON.
      const row = JSON.stringify(
        chatMessageContentFromMessage(
          toPersistableChatMessage({
            id: STORED_ASSISTANT_ID,
            parts: stored.parts,
            role: "assistant",
          }),
        ),
      );
      const reloaded = chatMessageFromPersisted({
        content: JSON.parse(row),
        id: STORED_ASSISTANT_ID,
        role: "assistant",
      });
      expect(storedCallOutput(reloaded)).toEqual(storedCallOutput(stored));

      // The model read the script's own return value, and no ledger.
      expect(requests).toHaveLength(2);
      const [handed] = toolResultsOf(requests[1] ?? []);
      expect(handed).toMatchObject({
        success: true,
        result: JSON.stringify({ results: [HIT] }).slice(0, 40),
      });
      expect(handed).not.toHaveProperty(CHAT_STEP_LEDGER_KEY);

      // The next turn replays the stored step without its ledger as well.
      const next = await runAndStore({
        history: [
          question,
          { ...stored, id: STORED_ASSISTANT_ID },
          {
            id: "user-2",
            role: "user",
            parts: [{ type: "text", content: "A dál?" }],
          },
        ],
        turns: [{ type: "text", text: "Nic dalšího.", finishReason: "stop" }],
      });
      const replayed = toolResultsOf(next.requests[0] ?? []);
      expect(replayed).toHaveLength(1);
      expect(replayed[0]).toEqual(handed);
    },
    propertyTestTimeout(30_000),
  );

  test(
    "does not depend on what the script returns",
    async () => {
      const tool = surface().tool;
      const execute =
        tool.execute ?? panic("execute_typescript has no server execute");
      const ledgerOf = async (returned: string) =>
        readChatStepLedger(
          await execute({
            typescriptCode: [
              `const r = await external_search_case_law({ queries: ["zákonný soudce"], country: "CZE" });`,
              `return ${returned};`,
            ].join("\n"),
          }),
        );
      const reference = await ledgerOf("r");
      expect(reference?.calls[0]?.found).toHaveLength(1);

      // A value a model might return: a cut-off serialization, garbage, an
      // unrelated value, or nothing at all.
      const returnedArb = fc.oneof(
        fc
          .nat({ max: 400 })
          .map((end) => `JSON.stringify(r).slice(0, ${String(end)})`),
        fc.string({ maxLength: 40 }).map((value) => JSON.stringify(value)),
        fc.integer().map(String),
        fc.constantFrom("undefined", "null", "[r, r]", "{ r }"),
      );
      await assertProperty(
        "does not depend on what the script returns",
        fc.asyncProperty(returnedArb, async (returned) => {
          expect(await ledgerOf(returned)).toEqual(reference);
        }),
        { numRuns: 15 },
      );
    },
    propertyTestTimeout(60_000),
  );
});
