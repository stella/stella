import { EventType, maxIterations } from "@tanstack/ai";
import type { ModelMessage, StreamChunk } from "@tanstack/ai";
import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CHAT_STEP_LEDGER_KEY,
  type ChatStepLedger,
  readChatStepLedger,
  readChatStepRefTargets,
} from "@stll/api-contract/chat-step-ledger";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { chatRefsWrittenIn } from "@/api/handlers/chat/chat-refs-shown";
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
import {
  type ChatRefRegistry,
  createChatRefRegistry,
} from "@/api/lib/chat/ref-registry";
import {
  CHAT_REF_ENCODING,
  type ChatRefContext,
  getChatRefBindings,
  isChatRefContext,
} from "@/api/lib/chat/ref-token";
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
import { chatStepRefScope } from "./chat-step-ledger";
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
  tool = surface().tool,
  turns,
}: {
  history: ChatMessage[];
  tool?: ReturnType<typeof surface>["tool"];
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
        tools: [tool],
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

const MATTER_ID = toSafeId<"workspace">("0dc54d0c-10d7-501d-897e-e801dbd0998c");
const DOCUMENT_ID = toSafeId<"entity">("11111111-1111-5111-8111-111111111111");
const OUTSIDE_MATTER_ID = toSafeId<"workspace">(
  "7a1f0f7e-2c3b-5d4e-8f90-112233445566",
);
const OUTSIDE_DOCUMENT_ID = toSafeId<"entity">(
  "22222222-2222-5222-8222-222222222222",
);
const TENANT_IDS = [
  MATTER_ID,
  DOCUMENT_ID,
  OUTSIDE_MATTER_ID,
  OUTSIDE_DOCUMENT_ID,
];

const matterHit = ({
  entityId,
  workspaceId,
  name,
}: {
  entityId: string;
  workspaceId: string;
  name: string;
}) => ({ entityId, workspaceId, name, kind: "document" });

/**
 * Matter reads in a turn whose registry is `refRegistry` and whose matter is
 * `MATTER_ID`: each read answers with real ids, and the script receives
 * them as the read's projection hands them over, as the turn's chat refs.
 */
const matterReadSurface = (refRegistry: ChatRefRegistry) =>
  createChatCodeModeSurface({
    concurrencyKey: "step-ledger-refs-test",
    documentedReads: ["list_matters", "search_across_matters"],
    stepLedgerScope: chatStepRefScope({
      refRegistry,
      workspaceIds: [MATTER_ID],
    }),
    runReadTool: async (toolName, args, step) => {
      await Promise.resolve();
      if (toolName === "list_matters") {
        step.answered({
          args,
          data: { matters: [{ id: MATTER_ID, name: "Harbrook acquisition" }] },
        });
        return Result.ok({
          matters: [
            {
              id: refRegistry.toMatterRef(MATTER_ID),
              name: "Harbrook acquisition",
            },
          ],
        });
      }
      if (toolName === "search_across_matters") {
        const found = [
          {
            entityId: DOCUMENT_ID,
            workspaceId: MATTER_ID,
            name: "Share purchase agreement.docx",
          },
          {
            entityId: OUTSIDE_DOCUMENT_ID,
            workspaceId: OUTSIDE_MATTER_ID,
            name: "Board minutes.docx",
          },
        ];
        step.answered({ args, data: { hits: found.map(matterHit) } });
        return Result.ok({
          hits: found.map((hit) =>
            matterHit({
              entityId: refRegistry.toEntityRef(hit),
              workspaceId: refRegistry.toMatterRef(hit.workspaceId),
              name: hit.name,
            }),
          ),
        });
      }
      return Result.err(
        new ChatToolError({ kind: "not-found", message: "No such read." }),
      );
    },
  });

const MATTER_SCRIPT = [
  "const matters = await external_list_matters({});",
  `const found = await external_search_across_matters({ query: "indemnity cap" });`,
  'return "Checked " + String(found.hits.length) + " documents";',
].join("\n");

describe("a code step's matter items", () => {
  test(
    "are named by the turn's chat refs, which the stored message binds, resolve alike live and after a reload, and replay with no tenant id",
    async () => {
      const refRegistry = createChatRefRegistry();
      const { toolResults, stored } = await runAndStore({
        history: [question],
        tool: matterReadSurface(refRegistry).tool,
        turns: [
          codeCall(MATTER_SCRIPT),
          { type: "text", text: "Hotovo.", finishReason: "stop" },
        ],
      });

      const [live] = toolResults.map(readChatStepLedger);
      expect(live?.calls.map((call) => call.found)).toEqual([
        [{ type: "matter", ref: "mat_1", title: "Harbrook acquisition" }],
        [
          {
            type: "document",
            ref: "ent_1",
            title: "Share purchase agreement.docx",
            kind: "document",
          },
        ],
      ]);
      const storedLedger = readChatStepLedger(storedCallOutput(stored));
      expect(storedLedger).toEqual(live ?? null);
      // The step names its items by refs alone, live and stored.
      for (const id of TENANT_IDS) {
        expect(JSON.stringify(toolResults)).not.toContain(id);
        expect(JSON.stringify(stored.parts)).not.toContain(id);
      }

      // What the turn stores beside the message: the binding of every ref
      // its parts hold, as `resolveAssistantMessageRefs` (`turns/settle.ts`)
      // collects them.
      const refContext = {
        version: 2,
        refs: refRegistry.collectRefBindings(
          chatRefsWrittenIn({ isServerTool: () => true, parts: stored.parts }),
        ),
        entities: [],
        unresolvedInputs: [],
        workspaceScope: [],
      } satisfies ChatRefContext;
      const liveTargets = readChatStepRefTargets(refContext);
      expect(Object.fromEntries(liveTargets)).toEqual({
        mat_1: { type: "matter", matterId: MATTER_ID },
        ent_1: { type: "document", entityId: DOCUMENT_ID, matterId: MATTER_ID },
      });

      // Reload: the stored row, read back, binds the same refs to the same
      // items.
      const row = JSON.stringify(
        chatMessageContentFromMessage(
          toPersistableChatMessage({
            id: STORED_ASSISTANT_ID,
            parts: stored.parts,
            role: "assistant",
            metadata: {
              refContext,
              refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
            },
          }),
        ),
      );
      const reloaded = chatMessageFromPersisted({
        content: JSON.parse(row),
        id: STORED_ASSISTANT_ID,
        role: "assistant",
      });
      expect(readChatStepLedger(storedCallOutput(reloaded))).toEqual(
        storedLedger,
      );
      const reloadedContext = reloaded.metadata?.refContext;
      expect(readChatStepRefTargets(reloadedContext)).toEqual(liveTargets);
      // The next request's registry, restored from those bindings, spells
      // each item the same way.
      const restored = createChatRefRegistry(
        isChatRefContext(reloadedContext)
          ? getChatRefBindings(reloadedContext)
          : [],
      );
      expect(restored.resolveEntityRefTargets(["ent_1"])).toEqual(
        Result.ok([{ entityId: DOCUMENT_ID, workspaceId: MATTER_ID }]),
      );
      expect(restored.resolveMatterRefs(["mat_1"])).toEqual(
        Result.ok([MATTER_ID]),
      );

      // The next turn replays the stored step with no tenant id, though the
      // ingress guard is given none to redact.
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
      const replayed = JSON.stringify(next.requests);
      expect(replayed).toContain("Checked 2 documents");
      for (const id of TENANT_IDS) {
        expect(replayed).not.toContain(id);
      }
    },
    propertyTestTimeout(30_000),
  );
});
