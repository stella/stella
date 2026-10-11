import { EventType } from "@tanstack/ai";
import type {
  StreamChunk,
  ToolCallPart,
  ToolResultPart,
  UIMessage,
} from "@tanstack/ai";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { unsafeFixture } from "@/api/tests/helpers/chat-fixtures";
import { diffLiveAgainstReload } from "@/api/tests/helpers/chat-live-reload-invariants";

import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
} from "./chat-message-parts";
import { SnapshotPartReconciler } from "./snapshot-reconciliation";
import { processServerChatStream, toChatMessage } from "./stream-chat";
import { createChatMessageIdMapper } from "./stream-message-identity";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const snapshot = (parts: UIMessage["parts"]): StreamChunk =>
  unsafeFixture(
    "Generated lifecycle permutations exercise the server's UI-parts snapshot extension",
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [{ id: MESSAGE_ID, role: "assistant", parts }],
    } satisfies StreamChunk,
  );

const scheduleArbitrary = fc.record({
  token: fc.string({ minLength: 1, maxLength: 12 }),
  textDelta: fc.boolean(),
  thinkingDelta: fc.boolean(),
  callDelta: fc.boolean(),
  resultDelta: fc.boolean(),
  approvalDelta: fc.boolean(),
  approved: fc.boolean(),
  // The scheduler chooses a nonempty chain at each step. Modulo rather than
  // filtering lets shrinking retain valid within-part lifecycle ordering.
  schedule: fc.array(fc.nat({ max: 100 }), { minLength: 1, maxLength: 50 }),
});

const callEvents = (call: ToolCallPart): StreamChunk[] => [
  {
    type: EventType.TOOL_CALL_START,
    parentMessageId: MESSAGE_ID,
    toolCallId: call.id,
    toolCallName: call.name,
  },
  {
    type: EventType.TOOL_CALL_ARGS,
    toolCallId: call.id,
    delta: call.arguments,
  },
  { type: EventType.TOOL_CALL_END, toolCallId: call.id, input: call.input },
];

const resultContent = (content: ToolResultPart["content"]) =>
  typeof content === "string"
    ? content
    : content
        .map((part) =>
          part.type === "text" ? part.content : JSON.stringify(part),
        )
        .join("");

// Compare all user-visible payloads, including result content (the shared
// live/reload invariant also checks identity but intentionally omits it).
// Text totals ignore SDK segmentation around tools; live/reload separately
// verifies those segments and tool order so placement remains covered.
const view = (parts: UIMessage["parts"]) => {
  const text = parts
    .flatMap((part) => (part.type === "text" ? [part.content] : []))
    .join("");
  const thinking = parts
    .flatMap((part) => (part.type === "thinking" ? [part.content] : []))
    .join("");
  const payloads = parts
    .map((part) => {
      switch (part.type) {
        case "text":
        case "thinking":
          return undefined;
        case "tool-call":
          return {
            type: part.type,
            id: part.id,
            arguments: part.arguments,
            state: part.state,
            input: part.input,
            output: part.output,
            approved: part.approval?.approved,
          };
        case "tool-result":
          return {
            type: part.type,
            toolCallId: part.toolCallId,
            state: part.state,
            content: resultContent(part.content),
          };
        case "activity":
          return {
            type: part.type,
            activityType: part.activityType,
            content: part.content,
          };
        case "image":
        case "audio":
        case "video":
        case "document":
        case "ui-resource":
        case "subagent":
        case "structured-output":
          return part;
        default:
          part satisfies never;
          return panic("Unhandled generated message part");
      }
    })
    .filter((part) => part !== undefined);
  return [
    { type: "text", content: text },
    { type: "thinking", content: thinking },
    ...payloads,
  ].toSorted((left, right) => {
    const leftKey = JSON.stringify(left);
    const rightKey = JSON.stringify(right);
    if (leftKey === rightKey) {
      return 0;
    }
    return leftKey < rightKey ? -1 : 1;
  });
};

const collectTurn = async (chunks: StreamChunk[]) => {
  const capture = createStreamMessageCapture({
    initialMessages: [],
    capture: toChatMessage,
  });
  const terminal: { response: ReturnType<typeof toChatMessage> } = {
    response: null,
  };
  const source = async function* () {
    yield* chunks;
  };
  const emitted: StreamChunk[] = [];
  for await (const chunk of processServerChatStream({
    abortSignal: new AbortController().signal,
    deadlineSignal: new AbortController().signal,
    initialMessages: [],
    mapMessageId: createChatMessageIdMapper(() =>
      toSafeId<"chatMessage">(MESSAGE_ID),
    ),
    getResponseMessage: capture.message,
    onFinish: ({ responseMessage }) => {
      terminal.response = responseMessage;
    },
    processor: capture.processor,
    source: source(),
  })) {
    emitted.push(chunk);
  }
  if (terminal.response === null) {
    panic("Generated reconciliation turn did not persist");
  }
  const live = createStreamMessageCapture({
    initialMessages: [],
    capture: (message) => message,
  });
  for (const chunk of emitted) {
    live.processor.processChunk(chunk);
  }
  const persisted = terminal.response;
  const reload = chatMessageFromPersisted({
    id: persisted.id,
    role: persisted.role,
    content: structuredClone(chatMessageContentFromMessage(persisted)),
  });
  expect(
    diffLiveAgainstReload({
      live: live.processor.getMessages(),
      reload: [reload],
    }),
  ).toEqual([]);
  expect(
    view(live.processor.getMessages().flatMap(({ parts }) => parts)),
  ).toEqual(view(reload.parts));
  return { emitted, persisted, reload };
};

test(
  "snapshot reconciliation preserves generated interleavings across live persistence and reload",
  async () => {
    await assertProperty(
      "snapshot reconciliation preserves generated interleavings across live persistence and reload",
      fc.asyncProperty(scheduleArbitrary, async (scenario) => {
        // Distinct markers make missing, duplicated or substituted content visible.
        const text = `Answer ${scenario.token}`;
        const thinking = `Reason ${scenario.token}`;
        const finalText = `${text}${scenario.textDelta ? " delta" : ""} complete`;
        const finalThinking = `${thinking}${scenario.thinkingDelta ? " delta" : ""} complete`;
        const input = { query: scenario.token };
        const call = {
          type: "tool-call",
          id: "input-call",
          name: "lookup",
          arguments: JSON.stringify(input),
          input,
          state: "input-complete",
        } as const satisfies ToolCallPart;
        const partialCall = {
          ...call,
          arguments: '{"query":',
          state: "input-streaming",
          input: undefined,
        } as const satisfies ToolCallPart;
        const resultCall = { ...call, id: "result-call" };
        const resultText = JSON.stringify({ answer: scenario.token });
        const result = {
          type: "tool-result",
          toolCallId: resultCall.id,
          state: "complete",
          content: resultText,
        } as const satisfies ToolResultPart;
        const completedResultCall = {
          ...resultCall,
          state: "complete",
          output: { answer: scenario.token },
        } as const satisfies ToolCallPart;
        const partialResult = {
          ...result,
          state: "streaming",
          content: JSON.stringify({ progress: scenario.token }),
        } as const satisfies ToolResultPart;
        const approval = { id: "approval_id", needsApproval: true };
        const requested = {
          ...call,
          id: "approval-call",
          state: "approval-requested",
          approval,
        } as const satisfies ToolCallPart;
        const decided = {
          ...requested,
          state: "approval-responded",
          approval: { ...approval, approved: scenario.approved },
        } as const satisfies ToolCallPart;
        const activity = {
          type: "activity",
          activityType: "review",
          content: { status: "complete", token: scenario.token },
        } as const;
        const partialActivity = {
          ...activity,
          content: { status: "running", token: scenario.token },
        };

        const chains: StreamChunk[][] = [
          [
            ...(scenario.textDelta
              ? [
                  {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: MESSAGE_ID,
                    delta: text,
                  } satisfies StreamChunk,
                ]
              : []),
            snapshot([
              {
                type: "text",
                content: scenario.textDelta ? "Flattened text" : "Answer",
              },
            ]),
            ...(scenario.textDelta
              ? [
                  {
                    type: EventType.TEXT_MESSAGE_CONTENT,
                    messageId: MESSAGE_ID,
                    delta: " delta",
                  } satisfies StreamChunk,
                ]
              : []),
            snapshot([{ type: "text", content: finalText }]),
          ],
          [
            ...(scenario.thinkingDelta
              ? [
                  {
                    type: EventType.REASONING_MESSAGE_CONTENT,
                    messageId: "reasoning",
                    delta: thinking,
                  } satisfies StreamChunk,
                ]
              : []),
            snapshot([
              {
                type: "thinking",
                content: scenario.thinkingDelta
                  ? "Flattened reasoning"
                  : "Reason",
              },
            ]),
            ...(scenario.thinkingDelta
              ? [
                  {
                    type: EventType.REASONING_MESSAGE_CONTENT,
                    messageId: "reasoning",
                    delta: " delta",
                  } satisfies StreamChunk,
                ]
              : []),
            snapshot([{ type: "thinking", content: finalThinking }]),
          ],
          [
            ...(scenario.callDelta
              ? callEvents(call)
              : [snapshot([partialCall])]),
            snapshot([call]),
            snapshot([partialCall]),
          ],
          [
            ...(scenario.resultDelta
              ? [
                  ...callEvents(resultCall),
                  {
                    type: EventType.TOOL_CALL_RESULT,
                    messageId: MESSAGE_ID,
                    toolCallId: resultCall.id,
                    content: resultText,
                  } satisfies StreamChunk,
                ]
              : [snapshot([resultCall, partialResult])]),
            snapshot([completedResultCall, result]),
            snapshot([resultCall, partialResult]),
          ],
          [snapshot([partialActivity]), snapshot([activity])],
          [
            ...(scenario.approvalDelta
              ? [
                  ...callEvents(requested),
                  {
                    type: EventType.CUSTOM,
                    name: "approval-requested",
                    value: {
                      approval,
                      input,
                      toolCallId: requested.id,
                      toolName: requested.name,
                    },
                  } satisfies StreamChunk,
                ]
              : [snapshot([requested])]),
            snapshot([decided]),
            snapshot([requested]),
          ],
        ];
        const expected = [
          { type: "text", content: finalText },
          { type: "thinking", content: finalThinking },
          call,
          completedResultCall,
          result,
          activity,
          decided,
        ] satisfies UIMessage["parts"];
        const chunks: StreamChunk[] = [
          {
            type: EventType.RUN_STARTED,
            runId: "property-run",
            threadId: "property-thread",
          },
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: MESSAGE_ID,
            role: "assistant",
          },
        ];
        const callOrder: string[] = [];
        const callByChain = new Map([
          [2, call.id],
          [3, resultCall.id],
          [5, requested.id],
        ]);
        let step = 0;
        while (chains.some((chain) => chain.length > 0)) {
          const available = chains.filter((chain) => chain.length > 0);
          const selection = scenario.schedule.at(
            step % scenario.schedule.length,
          );
          const chain = available.at((selection ?? 0) % available.length);
          const chainIndex = chain === undefined ? -1 : chains.indexOf(chain);
          const introducedCall = callByChain.get(chainIndex);
          if (
            introducedCall !== undefined &&
            !callOrder.includes(introducedCall)
          ) {
            callOrder.push(introducedCall);
          }
          const chunk = chain?.shift();
          if (chunk === undefined) {
            panic("Generated scheduler selected an empty chain");
          }
          chunks.push(chunk);
          step += 1;
        }
        chunks.push({
          type: EventType.RUN_FINISHED,
          runId: "property-run",
          threadId: "property-thread",
          finishReason: "stop",
        });
        const { emitted, persisted, reload } = await collectTurn(chunks);
        expect(
          persisted.parts.flatMap((part) =>
            part.type === "tool-call" ? [part.id] : [],
          ),
        ).toEqual(callOrder);
        expect(view(persisted.parts)).toEqual(view(expected));
        expect(view(reload.parts)).toEqual(view(expected));

        // Terminal state must remain settled at every visible snapshot, including
        // the deliberately stale active/approval-requested replays.
        const live = createStreamMessageCapture({
          initialMessages: [],
          capture: (message) => message,
        });
        const settled = new Set<string>();
        const decisions = new Map<string, boolean>();
        for (const chunk of emitted) {
          live.processor.processChunk(chunk);
          for (const part of live.processor
            .getMessages()
            .flatMap(({ parts }) => parts)) {
            if (part.type === "tool-result") {
              if (settled.has(part.toolCallId)) {
                expect(part.state).not.toBe("streaming");
              }
              if (part.state !== "streaming") {
                settled.add(part.toolCallId);
              }
            }
            if (part.type === "tool-call") {
              if (decisions.has(part.id)) {
                expect(part.approval?.approved).toBe(decisions.get(part.id));
              }
              if (part.approval?.approved !== undefined) {
                decisions.set(part.id, part.approval.approved);
              }
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  },
  propertyTestTimeout(15_000),
);

const activityUpdatesArbitrary = fc.array(
  fc.record({
    type: fc.constantFrom("delta", "snapshot"),
    value: fc.integer(),
  }),
  { minLength: 1, maxLength: 30 },
);

// AG-UI activity events own standalone frontend messages, whereas the
// assistant snapshot extension carries embedded ActivityPart values. Drive
// the real SDK patch producer, then test the embedded-part projection at its
// reconciliation owner; this does not change the standalone event protocol.
test(
  "activity part provenance preserves SDK deltas against later snapshots",
  () => {
    assertProperty(
      "activity part provenance preserves SDK deltas against later snapshots",
      fc.property(activityUpdatesArbitrary, (updates) => {
        const owner = new SnapshotPartReconciler([]);
        const initial = createStreamMessageCapture({
          initialMessages: [],
          capture: (message) => message,
        });
        initial.processor.processChunk({
          type: "ACTIVITY_SNAPSHOT",
          messageId: "activity-progress",
          activityType: "review",
          content: { progress: 0 },
        });
        let parts = initial.processor
          .getMessages()
          .flatMap(({ parts: messageParts }) => messageParts);
        for (const part of parts) {
          owner.snapshot(part);
        }
        let expectedProgress = 0;
        let origin: "snapshot-derived" | "delta-streamed" = "snapshot-derived";
        for (const update of updates) {
          const producer = createStreamMessageCapture({
            initialMessages: [
              { id: "activity-progress", role: "activity", parts },
            ],
            capture: (message) => message,
          });
          switch (update.type) {
            case "delta": {
              producer.processor.processChunk({
                type: "ACTIVITY_DELTA",
                messageId: "activity-progress",
                activityType: "review",
                patch: [
                  { op: "replace", path: "/progress", value: update.value },
                ],
              });
              const after = producer.processor
                .getMessages()
                .flatMap(({ parts: messageParts }) => messageParts);
              owner.observe(parts, after);
              parts = after;
              if (update.value !== expectedProgress) {
                origin = "delta-streamed";
              }
              expectedProgress = update.value;
              break;
            }
            case "snapshot": {
              producer.processor.processChunk({
                type: "ACTIVITY_SNAPSHOT",
                messageId: "activity-progress",
                activityType: "review",
                content: { progress: update.value },
              });
              const updatedParts = producer.processor
                .getMessages()
                .flatMap(({ parts: messageParts }) => messageParts);
              parts = owner.reconcile({
                previous: { id: MESSAGE_ID, role: "assistant", parts },
                snapshot: {
                  id: MESSAGE_ID,
                  role: "assistant",
                  parts: updatedParts,
                },
                preservesPartLayout: true,
                parseResultOutput: (content) => content,
              });
              if (origin === "snapshot-derived") {
                expectedProgress = update.value;
              }
              break;
            }
            default:
              update.type satisfies never;
              panic("Unhandled generated activity update");
          }
          const expected = [
            {
              type: "activity",
              activityType: "review",
              content: { progress: expectedProgress },
            },
          ];
          expect(parts).toEqual(expected);
          for (const part of parts) {
            expect(owner.provenanceOf(part)).toBe(origin);
          }
          const persisted = toChatMessage({
            id: MESSAGE_ID,
            role: "assistant",
            parts,
          });
          if (persisted === null) {
            panic("Activity projection did not persist");
          }
          const reload = chatMessageFromPersisted({
            id: persisted.id,
            role: persisted.role,
            content: structuredClone(chatMessageContentFromMessage(persisted)),
          });
          const live = createStreamMessageCapture({
            initialMessages: [],
            capture: (message) => message,
          });
          live.processor.processChunk(snapshot(parts));
          expect(
            live.processor
              .getMessages()
              .flatMap(({ parts: messageParts }) => messageParts),
          ).toEqual(expected);
          expect(reload.parts).toEqual(expected);
        }
      }),
      { numRuns: 100 },
    );
  },
  propertyTestTimeout(15_000),
);
