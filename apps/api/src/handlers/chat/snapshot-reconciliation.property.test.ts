import { EventType } from "@tanstack/ai";
import type {
  MessagePart,
  StreamChunk,
  SubagentPart,
  ToolCallPart,
  ToolResultPart,
  UIMessage,
} from "@tanstack/ai";
import { panic } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { MCP_APP_RESOURCE_MIME_TYPE } from "@stll/api-contract";
import {
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
  chatToolExecutor,
} from "@stll/api-contract/chat";
import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import { createStreamMessageCapture } from "@/api/lib/chat/stream-message-capture";
import { unsafeFixture } from "@/api/tests/helpers/chat-fixtures";
import { diffLiveAgainstReload } from "@/api/tests/helpers/chat-live-reload-invariants";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";

import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  classifyChatPartForPersistence,
  toPersistableChatMessage,
} from "./chat-message-parts";
import {
  SnapshotPartReconciler,
  type SnapshotReconciliationError,
} from "./snapshot-reconciliation";
import { processServerChatStream, toChatMessage } from "./stream-chat";
import { createChatMessageIdMapper } from "./stream-message-identity";

// Compare the SDK union, including synthetic tool names outside Stella's registry.
const sdkParts = (message: UIMessage) => message.parts;

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const snapshot = (parts: UIMessage["parts"]): StreamChunk => {
  const message = {
    id: MESSAGE_ID,
    role: "assistant",
    parts,
  } as const satisfies UIMessage;
  return unsafeFixture(
    "Generated lifecycle permutations exercise the server's UI-parts snapshot extension",
    {
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [message],
    } satisfies StreamChunk,
  );
};

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
    metadata: {
      [CHAT_TOOL_EXECUTOR_METADATA_KEY]:
        chatToolExecutor(call) ??
        panic("Generated tool call must declare executor ownership"),
    },
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

const collectTurn = async (
  chunks: StreamChunk[],
  assertPersisted?: (parts: UIMessage["parts"]) => void,
) => {
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
  const reconciliationFailures: SnapshotReconciliationError[] = [];
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
    reportSnapshotFailure: (error) => {
      reconciliationFailures.push(error);
    },
    source: source(),
  })) {
    emitted.push(chunk);
  }
  expect(reconciliationFailures).toEqual([]);
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
  const persisted = toPersistableChatMessage({
    ...terminal.response,
    id: toSafeId<"chatMessage">(terminal.response.id),
  });
  assertPersisted?.(persisted.parts);
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
    view(
      live.processor
        .getMessages()
        .flatMap(({ parts }) => parts)
        .flatMap((part) => {
          const decision = classifyChatPartForPersistence(part);
          return decision.type === "persist" ? [decision.part] : [];
        }),
    ),
  ).toEqual(view(reload.parts));
  return { emitted, persisted, reload };
};

const expectTerminalMonotonicity = (emitted: StreamChunk[]) => {
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
          metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
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
        expectTerminalMonotonicity(emitted);
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
          ] satisfies UIMessage["parts"];
          expect(owner.failure).toBeUndefined();
          expect(parts).toEqual(expected);
          for (const part of parts) {
            expect(owner.provenanceOf(part)).toBe(origin);
          }
          const projected = toChatMessage({
            id: MESSAGE_ID,
            role: "assistant",
            parts,
          });
          if (projected === null) {
            panic("Activity projection did not persist");
          }
          const persisted = toPersistableChatMessage({
            ...projected,
            id: toSafeId<"chatMessage">(projected.id),
          });
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
          expect(sdkParts(reload)).toEqual(expected);
        }
      }),
      { numRuns: 100 },
    );
  },
  propertyTestTimeout(15_000),
);

type TextualKind = "text" | "thinking";
type TextualReference =
  | { origin: "snapshot-derived"; segments: string[] }
  | { origin: "delta-streamed"; content: string };

const referenceContent = (reference: TextualReference): string => {
  switch (reference.origin) {
    case "snapshot-derived":
      return reference.segments.join("");
    case "delta-streamed":
      return reference.content;
    default:
      reference satisfies never;
      return panic("Unhandled textual reference origin");
  }
};

const textualSegments = (parts: UIMessage["parts"], kind: TextualKind) =>
  parts.flatMap((part) =>
    (part.type === "text" || part.type === "thinking") && part.type === kind
      ? [part.content]
      : [],
  );

const partitionContent = (content: string, cuts: number[]) => {
  if (content.length < 2) {
    return [content];
  }
  const boundaries = [
    ...new Set(cuts.map((cut) => 1 + (cut % (content.length - 1)))),
  ].toSorted((left, right) => left - right);
  const segments: string[] = [];
  let previous = 0;
  for (const boundary of boundaries) {
    segments.push(content.slice(previous, boundary));
    previous = boundary;
  }
  segments.push(content.slice(previous));
  return segments;
};

const segmentTokenArbitrary = fc
  .array(fc.constantFrom("A", "B", "é", "中", "🙂"), {
    minLength: 1,
    maxLength: 8,
  })
  .map((characters) => characters.join(""));
const resegmentationArbitrary = fc.record({
  text: fc.tuple(segmentTokenArbitrary, segmentTokenArbitrary),
  thinking: fc.tuple(segmentTokenArbitrary, segmentTokenArbitrary),
  updates: fc.array(
    fc.record({
      kind: fc.constantFrom("text", "thinking"),
      type: fc.constantFrom("delta", "snapshot"),
      snapshotMode: fc.constantFrom("reshape", "extend", "replace", "shorten"),
      token: segmentTokenArbitrary,
      cuts: fc.array(fc.nat({ max: 30 }), { maxLength: 6 }),
    }),
    { minLength: 1, maxLength: 25 },
  ),
});

test("snapshot-derived text and reasoning merge without retaining obsolete slots", async () => {
  const merged = [
    { type: "text", content: "AB" },
    { type: "thinking", content: "AB" },
  ] satisfies UIMessage["parts"];
  const { persisted, reload } = await collectTurn(
    [
      {
        type: EventType.RUN_STARTED,
        runId: "reshape-run",
        threadId: "reshape-thread",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: MESSAGE_ID,
        role: "assistant",
      },
      snapshot([
        { type: "text", content: "A" },
        { type: "text", content: "B" },
        { type: "thinking", content: "A" },
        { type: "thinking", content: "B" },
      ]),
      snapshot(merged),
      {
        type: EventType.RUN_FINISHED,
        runId: "reshape-run",
        threadId: "reshape-thread",
        finishReason: "stop",
      },
    ],
    (parts) => {
      expect(parts).toEqual(merged);
    },
  );
  expect(persisted.parts).toEqual(merged);
  expect(sdkParts(reload)).toEqual(merged);
});

const resegmentationAncillary = (token: string) => {
  const input = { query: token };
  const call = {
    type: "tool-call",
    metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
    id: "reshape-result-call",
    name: "lookup",
    arguments: JSON.stringify(input),
    input,
    state: "input-complete",
  } as const satisfies ToolCallPart;
  const result = {
    type: "tool-result",
    toolCallId: call.id,
    content: JSON.stringify({ answer: token }),
    state: "complete",
  } as const satisfies ToolResultPart;
  const completed = {
    ...call,
    state: "complete",
    output: { answer: token },
  } as const satisfies ToolCallPart;
  const partial = {
    ...result,
    state: "streaming",
    content: JSON.stringify({ progress: token }),
  } as const satisfies ToolResultPart;
  const approval = { id: "reshape-approval", needsApproval: true };
  const requested = {
    ...call,
    id: "reshape-approval-call",
    state: "approval-requested",
    approval,
  } as const satisfies ToolCallPart;
  const decided = {
    ...requested,
    state: "approval-responded",
    approval: { ...approval, approved: token.length % 2 === 0 },
  } as const satisfies ToolCallPart;
  const activity = {
    type: "activity",
    activityType: "review",
    content: { status: "complete", token },
  } as const;
  const chains: StreamChunk[][] = [
    [
      ...callEvents(call),
      snapshot([call, partial]),
      snapshot([completed, result]),
      snapshot([call, partial]),
    ],
    [
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
      },
      snapshot([decided]),
      snapshot([requested]),
    ],
    [
      snapshot([{ ...activity, content: { status: "running", token } }]),
      snapshot([activity]),
    ],
  ];
  const expected = [
    completed,
    result,
    decided,
    activity,
  ] satisfies UIMessage["parts"];
  return { chains, expected };
};

test(
  "textual snapshots preserve segmentation changes and delta content",
  async () => {
    await assertProperty(
      "textual snapshots preserve segmentation changes and delta content",
      fc.asyncProperty(resegmentationArbitrary, async (scenario) => {
        const reference: Record<TextualKind, TextualReference> = {
          text: { origin: "snapshot-derived", segments: scenario.text },
          thinking: { origin: "snapshot-derived", segments: scenario.thinking },
        };
        const chunks: StreamChunk[] = [
          {
            type: EventType.RUN_STARTED,
            runId: "reshape-run",
            threadId: "reshape-thread",
          },
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: MESSAGE_ID,
            role: "assistant",
          },
          snapshot([
            ...scenario.text.map(
              (content) => ({ type: "text", content }) as const,
            ),
            ...scenario.thinking.map(
              (content) => ({ type: "thinking", content }) as const,
            ),
          ]),
        ];
        const ancillary = resegmentationAncillary(scenario.text.join(""));
        for (const update of scenario.updates) {
          // Partition decisions also schedule sibling events, exercising tool
          // interruptions between textual snapshots and deltas.
          for (const selection of update.cuts) {
            const available = ancillary.chains.filter(
              (chain) => chain.length > 0,
            );
            if (available.length === 0) {
              break;
            }
            const sibling = available.at(selection % available.length)?.shift();
            if (sibling === undefined) {
              panic("Generated scheduler selected an empty sibling chain");
            }
            chunks.push(sibling);
          }
          const previous = reference[update.kind];
          const previousContent = referenceContent(previous);
          switch (update.type) {
            case "delta": {
              chunks.push(
                update.kind === "text"
                  ? {
                      type: EventType.TEXT_MESSAGE_CONTENT,
                      messageId: MESSAGE_ID,
                      delta: update.token,
                    }
                  : {
                      type: EventType.REASONING_MESSAGE_CONTENT,
                      messageId: "reshape-reasoning",
                      delta: update.token,
                    },
              );
              reference[update.kind] = {
                origin: "delta-streamed",
                content: previousContent + update.token,
              };
              break;
            }
            case "snapshot": {
              let content: string;
              switch (update.snapshotMode) {
                case "reshape":
                  content = previousContent;
                  break;
                case "extend":
                  content = previousContent + update.token;
                  break;
                case "replace":
                  content = update.token;
                  break;
                case "shorten":
                  content = previousContent.slice(
                    0,
                    Math.max(1, previousContent.length - update.token.length),
                  );
                  break;
                default:
                  update.snapshotMode satisfies never;
                  panic("Unhandled generated snapshot mode");
              }
              const segments = partitionContent(content, update.cuts);
              chunks.push(
                snapshot(
                  segments.map((segment) => ({
                    type: update.kind,
                    content: segment,
                  })),
                ),
              );
              switch (previous.origin) {
                case "snapshot-derived":
                  reference[update.kind] = {
                    origin: "snapshot-derived",
                    segments,
                  };
                  break;
                case "delta-streamed":
                  if (
                    content.length > previousContent.length &&
                    content.startsWith(previousContent)
                  ) {
                    reference[update.kind] = {
                      origin: "delta-streamed",
                      content,
                    };
                  }
                  break;
                default:
                  previous satisfies never;
                  panic("Unhandled textual reference origin");
              }
              break;
            }
            default:
              update.type satisfies never;
              panic("Unhandled generated resegmentation update");
          }
        }
        const hasAncillaryEvents = scenario.updates.some(
          (update) => update.cuts.length > 0,
        );
        if (hasAncillaryEvents) {
          for (const chain of ancillary.chains) {
            chunks.push(...chain);
          }
        }
        chunks.push({
          type: EventType.RUN_FINISHED,
          runId: "reshape-run",
          threadId: "reshape-thread",
          finishReason: "stop",
        });
        const assertReference = (parts: UIMessage["parts"]) => {
          for (const kind of ["text", "thinking"] as const) {
            const expected = reference[kind];
            const segments = textualSegments(parts, kind);
            expect(segments.join("")).toBe(referenceContent(expected));
            switch (expected.origin) {
              case "snapshot-derived":
                expect(segments).toEqual(expected.segments);
                break;
              case "delta-streamed":
                break;
              default:
                expected satisfies never;
                panic("Unhandled textual reference origin");
            }
          }
          expect(
            view(
              parts.filter(
                (part) => part.type !== "text" && part.type !== "thinking",
              ),
            ),
          ).toEqual(view(hasAncillaryEvents ? ancillary.expected : []));
        };
        const { persisted, reload, emitted } = await collectTurn(
          chunks,
          assertReference,
        );
        assertReference(reload.parts);
        for (const kind of ["text", "thinking"] as const) {
          expect(textualSegments(reload.parts, kind)).toEqual(
            textualSegments(persisted.parts, kind),
          );
        }
        expectTerminalMonotonicity(emitted);
      }),
      { numRuns: 100 },
    );
  },
  propertyTestTimeout(15_000),
);

const orderedGapArbitrary = fc.record({
  text: segmentTokenArbitrary,
  thinking: segmentTokenArbitrary,
  textCuts: fc.array(fc.nat({ max: 30 }), { maxLength: 4 }),
  thinkingCuts: fc.array(fc.nat({ max: 30 }), { maxLength: 4 }),
  thinkingFirst: fc.boolean(),
});
const orderedSnapshotsArbitrary = fc.array(
  fc.array(orderedGapArbitrary, { minLength: 5, maxLength: 5 }),
  { minLength: 2, maxLength: 8 },
);

const orderedTurn = (snapshots: UIMessage["parts"][]): StreamChunk[] => [
  {
    type: EventType.RUN_STARTED,
    runId: "ordered-run",
    threadId: "ordered-thread",
  },
  {
    type: EventType.TEXT_MESSAGE_START,
    messageId: MESSAGE_ID,
    role: "assistant",
  },
  ...snapshots.map(snapshot),
  {
    type: EventType.RUN_FINISHED,
    runId: "ordered-run",
    threadId: "ordered-thread",
    finishReason: "stop",
  },
];

const subagentLifecycleArbitrary = fc.record({
  cycles: fc.array(
    fc.record({ suspended: fc.string(), resumed: fc.string() }),
    { minLength: 1, maxLength: 5 },
  ),
  terminal: fc.constantFrom("finished", "error"),
  stale: fc.array(
    fc.record({
      status: fc.constantFrom("running", "suspended"),
      content: fc.string(),
    }),
    { minLength: 1, maxLength: 5 },
  ),
});

const subagentLifecyclePart = (
  status: SubagentPart["subagent"]["status"],
  content: string,
): SubagentPart => ({
  type: "subagent",
  subagent: {
    id: "lifecycle-child",
    name: "Review",
    status,
    messages: [
      {
        id: "child-answer",
        role: "assistant",
        parts: [{ type: "text", content }],
      },
    ],
  },
});

test(
  "subagent snapshots preserve suspend resume cycles and terminal finality",
  async () => {
    await assertProperty(
      "subagent snapshots preserve suspend resume cycles and terminal finality",
      fc.asyncProperty(subagentLifecycleArbitrary, async (scenario) => {
        const active = [
          subagentLifecyclePart("running", "Initial child transcript"),
        ];
        for (const [index, cycle] of scenario.cycles.entries()) {
          active.push(
            subagentLifecyclePart(
              "suspended",
              `Suspended ${index}: ${cycle.suspended}`,
            ),
            subagentLifecyclePart(
              "running",
              `Resumed ${index}: ${cycle.resumed}`,
            ),
          );
        }
        const terminal = subagentLifecyclePart(
          scenario.terminal,
          "Final child transcript",
        );
        const stale = scenario.stale.map(({ status, content }) =>
          subagentLifecyclePart(status, `Stale: ${content}`),
        );
        const answer = { type: "text", content: "Answer" } as const;
        const inputs = [...active, terminal, ...stale].map((part) => [
          answer,
          part,
        ]);
        const expected = [...active, terminal, ...stale.map(() => terminal)];
        const { emitted } = await collectTurn(orderedTurn(inputs));
        const live = createStreamMessageCapture({
          initialMessages: [],
          capture: (message) => message,
        });
        let step = 0;
        for (const chunk of emitted) {
          live.processor.processChunk(chunk);
          if (chunk.type !== EventType.MESSAGES_SNAPSHOT) {
            continue;
          }
          const child = expected.at(step);
          if (child === undefined) {
            panic("Subagent lifecycle emitted an unexpected snapshot");
          }
          expect(
            live.processor.getMessages().flatMap(({ parts }) => parts),
            JSON.stringify({ oracle: CHAT_ORACLE.liveSubagentLifecycle, step }),
          ).toEqual([answer, child]);
          step += 1;
        }
        expect(step).toBe(expected.length);
      }),
      { numRuns: 100 },
    );
  },
  propertyTestTimeout(15_000),
);

for (const append of [false, true]) {
  test(`snapshot text stays after its intervening call when ${append ? "appended" : "unchanged"}`, async () => {
    const call = {
      type: "tool-call",
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
      id: "ordered-call",
      name: "lookup",
      arguments: "{}",
      input: {},
      state: "input-complete",
    } as const satisfies ToolCallPart;
    const expected = [
      { type: "text", content: "A" },
      call,
      { type: "text", content: "B" },
    ] satisfies UIMessage["parts"];
    const initial = append ? expected.slice(0, 2) : expected;
    const { reload } = await collectTurn(
      orderedTurn([initial, expected]),
      (parts) => {
        expect(parts).toEqual(expected);
      },
    );
    expect(sdkParts(reload)).toEqual(expected);
  });
}

test(
  "snapshot reconciliation preserves exact ordered parts around lifecycle anchors",
  async () => {
    await assertProperty(
      "snapshot reconciliation preserves exact ordered parts around lifecycle anchors",
      fc.asyncProperty(orderedSnapshotsArbitrary, async (layouts) => {
        const anchors = resegmentationAncillary("ordered").expected;
        const snapshots = layouts.map((gaps) => {
          const parts: UIMessage["parts"] = [];
          for (const [index, gap] of gaps.entries()) {
            const text = partitionContent(gap.text, gap.textCuts).map(
              (content) => ({ type: "text", content }) as const,
            );
            const thinking = partitionContent(
              gap.thinking,
              gap.thinkingCuts,
            ).map((content) => ({ type: "thinking", content }) as const);
            parts.push(
              ...(gap.thinkingFirst
                ? [...thinking, ...text]
                : [...text, ...thinking]),
            );
            const anchor = anchors.at(index);
            if (anchor !== undefined) {
              parts.push(anchor);
            }
          }
          return parts;
        });
        const expected = snapshots.at(-1);
        if (expected === undefined) {
          panic("Ordered snapshot generator produced no layouts");
        }
        // A complete snapshot owns both content and placement. The reference
        // is its exact sequence, including every intervening lifecycle anchor.
        const { reload, emitted } = await collectTurn(
          orderedTurn(snapshots),
          (parts) => {
            expect(parts).toEqual(expected);
          },
        );
        expect(sdkParts(reload)).toEqual(expected);
        const live = createStreamMessageCapture({
          initialMessages: [],
          capture: (message) => message,
        });
        for (const chunk of emitted) {
          live.processor.processChunk(chunk);
        }
        expect(
          live.processor.getMessages().flatMap(({ parts }) => parts),
        ).toEqual(expected);
        expectTerminalMonotonicity(emitted);
      }),
      { numRuns: 100 },
    );
  },
  propertyTestTimeout(15_000),
);

const orderedMixedArbitrary = fc.record({
  prefix: segmentTokenArbitrary,
  suffix: segmentTokenArbitrary,
  completion: segmentTokenArbitrary,
  extends: fc.boolean(),
  gaps: fc.array(segmentTokenArbitrary, { minLength: 4, maxLength: 4 }),
});

test(
  "mixed provenance preserves exact delta placement and snapshot insertions",
  async () => {
    await assertProperty(
      "mixed provenance preserves exact delta placement and snapshot insertions",
      fc.asyncProperty(orderedMixedArbitrary, async (scenario) => {
        const call = {
          type: "tool-call",
          metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
          id: "mixed-call",
          name: "lookup",
          arguments: "{}",
          input: {},
          state: "input-complete",
        } as const satisfies ToolCallPart;
        const producer = createStreamMessageCapture({
          initialMessages: [],
          capture: (message) => message,
        });
        const owner = new SnapshotPartReconciler([]);
        let parts: UIMessage["parts"] = [];
        const chunks: StreamChunk[] = [
          {
            type: EventType.TEXT_MESSAGE_START,
            messageId: MESSAGE_ID,
            role: "assistant",
          },
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: MESSAGE_ID,
            delta: scenario.prefix,
          },
          ...callEvents(call),
          {
            type: EventType.TEXT_MESSAGE_CONTENT,
            messageId: MESSAGE_ID,
            delta: scenario.suffix,
          },
        ];
        for (const chunk of chunks) {
          producer.processor.processChunk(chunk);
          const after = producer.processor
            .getMessages()
            .flatMap(({ parts: messageParts }) => messageParts);
          const reconciled = owner.reconcileDelta({
            before: parts,
            after,
            chunk,
          });
          owner.observe(parts, reconciled);
          parts = reconciled;
        }
        const initial = [
          { type: "text", content: scenario.prefix },
          call,
          { type: "text", content: scenario.suffix },
        ] satisfies UIMessage["parts"];
        expect(owner.failure).toBeUndefined();
        expect(parts).toEqual(initial);
        const completion = scenario.extends ? scenario.completion : "";
        const incomingText = scenario.extends ? scenario.prefix : "stale";
        const incomingSuffix = scenario.extends
          ? scenario.suffix + completion
          : "snapshot";
        const incoming: UIMessage["parts"] = [];
        const expected: UIMessage["parts"] = [];
        for (const [index, content] of scenario.gaps.entries()) {
          const thinking = { type: "thinking", content } as const;
          incoming.push(thinking);
          expected.push(thinking);
          switch (index) {
            case 0:
              incoming.push({
                type: "text",
                content: incomingText,
              });
              expected.push({ type: "text", content: scenario.prefix });
              break;
            case 1:
              incoming.push(call);
              expected.push(call);
              break;
            case 2:
              incoming.push({ type: "text", content: incomingSuffix });
              expected.push({
                type: "text",
                content: scenario.suffix + completion,
              });
              break;
            case 3:
              break;
            default:
              panic("Unexpected ordered mixed gap");
          }
        }
        const actual = owner.reconcile({
          previous: { id: MESSAGE_ID, role: "assistant", parts },
          snapshot: { id: MESSAGE_ID, role: "assistant", parts: incoming },
          preservesPartLayout: true,
          parseResultOutput: (content) => content,
        });
        expect(actual).toEqual(expected);
        const { reload, emitted } = await collectTurn(
          [
            {
              type: EventType.RUN_STARTED,
              runId: "mixed-run",
              threadId: "mixed-thread",
            },
            ...chunks,
            snapshot(incoming),
            {
              type: EventType.RUN_FINISHED,
              runId: "mixed-run",
              threadId: "mixed-thread",
              finishReason: "stop",
            },
          ],
          (persistedParts) => {
            expect(persistedParts).toEqual(expected);
          },
        );
        expect(sdkParts(reload)).toEqual(expected);
        const live = createStreamMessageCapture({
          initialMessages: [],
          capture: (message) => message,
        });
        for (const chunk of emitted) {
          live.processor.processChunk(chunk);
        }
        expect(
          live.processor
            .getMessages()
            .flatMap(({ parts: messageParts }) => messageParts),
        ).toEqual(expected);
        expectTerminalMonotonicity(emitted);
      }),
      { numRuns: 100 },
    );
  },
  propertyTestTimeout(15_000),
);

const terminalCallArbitrary = fc.record({
  terminal: fc.constantFrom("complete", "error", "denied"),
  output: segmentTokenArbitrary,
  updates: fc.array(
    fc.record({
      state: fc.constantFrom("streaming", "complete", "error", "denied"),
      content: segmentTokenArbitrary,
    }),
    { minLength: 1, maxLength: 20 },
  ),
});

const terminalCallScenario = (
  terminal: "complete" | "error" | "denied",
  output: string | undefined,
) => {
  const call = {
    type: "tool-call",
    metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
    id: "terminal-call",
    name: "lookup",
    arguments: "{}",
    input: {},
    state: terminal === "complete" ? "complete" : "error",
    ...(output === undefined ? {} : { output }),
    ...(terminal === "denied"
      ? {
          approval: {
            id: "terminal-approval",
            needsApproval: true,
            approved: false,
          },
        }
      : {}),
  } as const satisfies ToolCallPart;
  const before = { type: "text", content: "A" } as const;
  const after = { type: "text", content: "B" } as const;
  const stale = {
    type: "tool-call",
    metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    input: call.input,
    state: "input-complete",
  } as const satisfies ToolCallPart;
  return { call, before, after, stale };
};

for (const terminal of ["complete", "error"] as const) {
  test(`terminal ${terminal} call without result keeps its state and output when a sibling arrives`, async () => {
    const { call, before, after, stale } = terminalCallScenario(
      terminal,
      "settled",
    );
    const result = {
      type: "tool-result",
      toolCallId: call.id,
      state: terminal === "complete" ? "streaming" : "complete",
      content: "later",
    } as const satisfies ToolResultPart;
    const expected = [before, call, result, after];
    const { reload } = await collectTurn(
      orderedTurn([
        [before, call, after],
        [before, stale, result, after],
      ]),
      (parts) => {
        expect(parts).toEqual(expected);
      },
    );
    expect(sdkParts(reload)).toEqual(expected);
  });
}

test(
  "terminal calls without sibling results preserve settled payloads across later result snapshots",
  async () => {
    await assertProperty(
      "terminal calls without sibling results preserve settled payloads across later result snapshots",
      fc.asyncProperty(terminalCallArbitrary, async (scenario) => {
        for (const output of [scenario.output, undefined]) {
          for (const contentMode of ["text", "parts"] as const) {
            const { call, before, after, stale } = terminalCallScenario(
              scenario.terminal,
              output,
            );
            const snapshots: UIMessage["parts"][] = [[before, call, after]];
            let result: ToolResultPart | undefined;
            for (const update of scenario.updates) {
              const content =
                contentMode === "text"
                  ? update.content
                  : [{ type: "text", content: update.content } as const];
              const incoming = {
                type: "tool-result",
                toolCallId: call.id,
                state: update.state === "denied" ? "error" : update.state,
                content,
                ...(update.state === "denied"
                  ? { outcome: "denied" as const }
                  : {}),
              } as const satisfies ToolResultPart;
              snapshots.push([before, stale, incoming, after]);
              if (result === undefined || result.state === "streaming") {
                result = incoming;
              }
            }
            if (result === undefined) {
              panic("Terminal result generator produced no updates");
            }
            const expected = [before, call, result, after];
            const { reload, emitted } = await collectTurn(
              orderedTurn(snapshots),
              (parts) => {
                expect(parts).toEqual(expected);
              },
            );
            expect(sdkParts(reload)).toEqual(expected);
            const live = createStreamMessageCapture({
              initialMessages: [],
              capture: (message) => message,
            });
            for (const chunk of emitted) {
              live.processor.processChunk(chunk);
              for (const part of live.processor
                .getMessages()
                .flatMap(({ parts }) => parts)) {
                if (part.type === "tool-call" && part.id === call.id) {
                  expect(part).toEqual(call);
                }
              }
            }
            expect(
              live.processor.getMessages().flatMap(({ parts }) => parts),
            ).toEqual(expected);
            expectTerminalMonotonicity(emitted);
          }
        }
      }),
      { numRuns: 100 },
    );
  },
  propertyTestTimeout(15_000),
);

const introducedAnchorsArbitrary = fc.record({
  kind: fc.constantFrom("text", "thinking"),
  streamed: segmentTokenArbitrary,
  completion: segmentTokenArbitrary,
  snapshotMetadata: fc.boolean(),
  metadataToken: segmentTokenArbitrary,
  positions: fc.array(fc.nat({ max: 100 }), { minLength: 4, maxLength: 4 }),
});

const anchoredText = (
  kind: TextualKind,
  content: string,
  positions: number[],
) => {
  const anchors = resegmentationAncillary("anchor").expected;
  const markers = anchors.map((part, index) => ({
    part,
    index,
    position:
      (positions.at(index) ?? panic("Missing generated anchor position")) %
      (content.length + 1),
  }));
  markers.sort(
    (left, right) => left.position - right.position || left.index - right.index,
  );
  const parts: UIMessage["parts"] = [];
  let cursor = 0;
  for (const marker of markers) {
    if (marker.position > cursor) {
      parts.push(
        kind === "thinking"
          ? {
              type: kind,
              content: content.slice(cursor, marker.position),
              stepId: MESSAGE_ID,
            }
          : { type: kind, content: content.slice(cursor, marker.position) },
      );
    }
    parts.push(marker.part);
    cursor = marker.position;
  }
  if (cursor < content.length) {
    parts.push(
      kind === "thinking"
        ? { type: kind, content: content.slice(cursor), stepId: MESSAGE_ID }
        : { type: kind, content: content.slice(cursor) },
    );
  }
  return parts;
};

test("streamed text completion stays after its newly introduced call", async () => {
  const call = {
    type: "tool-call",
    metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
    id: "introduced-call",
    name: "lookup",
    arguments: "{}",
    input: {},
    state: "input-complete",
  } as const satisfies ToolCallPart;
  const expected = [
    { type: "text", content: "A" },
    call,
    { type: "text", content: "B" },
  ] satisfies UIMessage["parts"];
  const { reload } = await collectTurn(
    [
      {
        type: EventType.RUN_STARTED,
        runId: "introduced-run",
        threadId: "introduced-thread",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: MESSAGE_ID,
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: MESSAGE_ID,
        delta: "A",
      },
      snapshot(expected),
      {
        type: EventType.RUN_FINISHED,
        runId: "introduced-run",
        threadId: "introduced-thread",
        finishReason: "stop",
      },
    ],
    (parts) => {
      expect(parts).toEqual(expected);
    },
  );
  expect(sdkParts(reload)).toEqual(expected);
});

test("signed thinking snapshots enrich streamed content and survive later unsigned snapshots", async () => {
  const answer = { type: "text", content: "Answer" } as const;
  const initial = {
    type: "thinking",
    content: "Reason",
    stepId: "initial-step",
    signature: "initial-signature",
    redacted: false,
  } as const;
  const final = {
    type: "thinking",
    content: "Reason",
    stepId: "final-step",
    signature: "final-signature",
    redacted: false,
  } as const;
  const expected = [answer, final];
  const chunks: StreamChunk[] = [
    {
      type: EventType.RUN_STARTED,
      runId: "signed-run",
      threadId: "signed-thread",
    },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: MESSAGE_ID,
      role: "assistant",
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: MESSAGE_ID,
      delta: "Answer",
    },
    {
      type: EventType.REASONING_MESSAGE_CONTENT,
      messageId: "unsigned-reasoning",
      delta: "Reason",
    },
    snapshot([answer, initial]),
    snapshot(expected),
    snapshot([answer, { type: "thinking", content: "Reason" }]),
    {
      type: EventType.RUN_FINISHED,
      runId: "signed-run",
      threadId: "signed-thread",
      finishReason: "stop",
    },
  ];
  const { reload, emitted } = await collectTurn(chunks, (parts) => {
    expect(
      parts,
      JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
    ).toEqual(expected);
  });
  expect(
    sdkParts(reload),
    JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
  ).toEqual(expected);
  const live = createStreamMessageCapture({
    initialMessages: [],
    capture: (message) => message,
  });
  const expectedSnapshots = [[answer, initial], expected, expected];
  let index = 0;
  for (const chunk of emitted) {
    live.processor.processChunk(chunk);
    if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
      const expectedSnapshot = expectedSnapshots.at(index++);
      if (expectedSnapshot === undefined) {
        panic("Emitted snapshot has no expected projection");
      }
      expect(
        live.processor.getMessages().flatMap(({ parts }) => parts),
        JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
      ).toEqual(expectedSnapshot);
    }
  }
  expect(index).toBe(expectedSnapshots.length);
});

test("snapshot-only signed reasoning keeps its identity through unsigned splits and merges", () => {
  const signed = {
    type: "thinking",
    content: "AB",
    signature: "opaque",
    stepId: "signed-step",
    redacted: false,
  } as const;
  const owner = new SnapshotPartReconciler([]);
  let parts: UIMessage["parts"] = [];
  const snapshots = [
    [signed],
    [
      { type: "thinking", content: "A" },
      { type: "thinking", content: "B" },
    ],
    [{ type: "thinking", content: "AB" }],
  ] satisfies UIMessage["parts"][];
  for (const snapshotParts of snapshots) {
    parts = owner.reconcile({
      previous: { id: MESSAGE_ID, role: "assistant", parts },
      snapshot: { id: MESSAGE_ID, role: "assistant", parts: snapshotParts },
      preservesPartLayout: true,
      parseResultOutput: (content) => content,
    });
    expect(
      parts,
      JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
    ).toEqual([signed]);
    expect(owner.failure).toBeUndefined();
  }
});

test(
  "streamed textual completions preserve newly introduced lifecycle anchors",
  async () => {
    await assertProperty(
      "streamed textual completions preserve newly introduced lifecycle anchors",
      fc.asyncProperty(introducedAnchorsArbitrary, async (scenario) => {
        for (const completion of [scenario.completion, ""]) {
          const content = scenario.streamed + completion;
          const layout = anchoredText(
            scenario.kind,
            content,
            scenario.positions,
          );
          if (scenario.kind === "thinking") {
            layout.unshift({ type: "text", content: "Answer" });
          }
          const withMetadata = (phase: "initial" | "final") =>
            layout.map((part) => {
              if (!scenario.snapshotMetadata || part.type !== scenario.kind) {
                return part;
              }
              switch (part.type) {
                case "text":
                  return {
                    ...part,
                    metadata: {
                      provider: `${phase}:${scenario.metadataToken}`,
                    },
                  };
                case "thinking":
                  return {
                    ...part,
                    signature: `${phase}:${scenario.metadataToken}:${part.content}`,
                    redacted: false,
                  };
                default:
                  return panic("Generated metadata targeted a nontextual part");
              }
            });
          const expected = withMetadata("final");
          const unsigned = layout.map((part) => {
            if (part.type === "thinking") {
              return { type: part.type, content: part.content };
            }
            return part;
          });
          const chunks: StreamChunk[] = [
            {
              type: EventType.RUN_STARTED,
              runId: "introduced-run",
              threadId: "introduced-thread",
            },
            {
              type: EventType.TEXT_MESSAGE_START,
              messageId: MESSAGE_ID,
              role: "assistant",
            },
          ];
          if (scenario.kind === "thinking") {
            chunks.push(
              {
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: MESSAGE_ID,
                delta: "Answer",
              },
              {
                type: EventType.REASONING_MESSAGE_CONTENT,
                messageId: "introduced-reasoning",
                delta: scenario.streamed,
              },
            );
          } else {
            chunks.push({
              type: EventType.TEXT_MESSAGE_CONTENT,
              messageId: MESSAGE_ID,
              delta: scenario.streamed,
            });
          }
          chunks.push(
            snapshot(withMetadata("initial")),
            snapshot(expected),
            snapshot(unsigned),
            {
              type: EventType.RUN_FINISHED,
              runId: "introduced-run",
              threadId: "introduced-thread",
              finishReason: "stop",
            },
          );
          // Explicit snapshots describe both retained or completed bytes
          // and the positions of newly introduced lifecycle parts.
          const { reload, emitted } = await collectTurn(chunks, (parts) => {
            expect(parts).toEqual(expected);
          });
          expect(sdkParts(reload)).toEqual(expected);
          const live = createStreamMessageCapture({
            initialMessages: [],
            capture: (message) => message,
          });
          for (const chunk of emitted) {
            live.processor.processChunk(chunk);
          }
          expect(
            live.processor.getMessages().flatMap(({ parts }) => parts),
          ).toEqual(expected);
          expectTerminalMonotonicity(emitted);
        }
        // Snapshots can introduce the entire block before any textual delta.
        // Empty blocks carry opaque reasoning metadata, so identity matters even
        // when every block occupies the same textual offset.
        for (const redacted of [false, true]) {
          for (const content of [scenario.streamed + scenario.completion, ""]) {
            if (redacted && content !== "") {
              continue;
            }
            const signed = {
              type: "thinking",
              content,
              stepId: `signed:${scenario.metadataToken}`,
              signature: `signature:${scenario.metadataToken}`,
              redacted,
              provenance: {
                provider: "anthropic",
                model: `model:${scenario.metadataToken}`,
                format: redacted
                  ? "anthropic-redacted-thinking"
                  : "anthropic-thinking-signature",
              },
            } as const;
            const unsigned = {
              type: "thinking",
              content,
              ...(content === "" ? { stepId: signed.stepId } : {}),
            } as const;
            const expected = [signed];
            const splitAt = Math.floor(content.length / 2);
            const split =
              content === ""
                ? [unsigned]
                : ([
                    { type: "thinking", content: content.slice(0, splitAt) },
                    { type: "thinking", content: content.slice(splitAt) },
                  ] satisfies UIMessage["parts"]);
            if (content !== "") {
              expect(split.every((part) => part.content.length > 0)).toBe(true);
            }
            const { reload, emitted } = await collectTurn(
              orderedTurn([expected, [unsigned], split, [unsigned], split]),
              (parts) => {
                expect(
                  parts,
                  JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
                ).toEqual(expected);
              },
            );
            expect(
              sdkParts(reload),
              JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
            ).toEqual(expected);
            const live = createStreamMessageCapture({
              initialMessages: [],
              capture: (message) => message,
            });
            for (const chunk of emitted) {
              live.processor.processChunk(chunk);
              if (chunk.type === EventType.MESSAGES_SNAPSHOT) {
                expect(
                  live.processor.getMessages().flatMap(({ parts }) => parts),
                  JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
                ).toEqual(expected);
              }
            }
            if (content !== "") {
              const repeated = {
                type: "thinking",
                content: content + content,
              } as const;
              const extended = [
                signed,
                { type: "thinking", content },
              ] satisfies UIMessage["parts"];
              const { reload: extendedReload } = await collectTurn(
                orderedTurn([expected, [repeated], [repeated]]),
                (parts) => {
                  expect(
                    parts,
                    JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
                  ).toEqual(extended);
                },
              );
              expect(
                sdkParts(extendedReload),
                JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
              ).toEqual(extended);
            }
          }
          const signed = {
            type: "thinking",
            content: "",
            stepId: `signed:${scenario.metadataToken}`,
            signature: `signature:${scenario.metadataToken}`,
            redacted,
          } as const;
          const placeholder = {
            type: "thinking",
            content: "",
            stepId: `placeholder:${scenario.metadataToken}`,
          } as const;
          expect(placeholder.stepId).not.toBe(signed.stepId);
          const { reload } = await collectTurn(
            orderedTurn([[signed], [placeholder], [placeholder]]),
            (parts) => {
              expect(
                parts,
                JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
              ).toEqual([placeholder]);
            },
          );
          expect(
            sdkParts(reload),
            JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
          ).toEqual([placeholder]);
          const failures: SnapshotReconciliationError[] = [];
          const owner = new SnapshotPartReconciler([signed], (error) => {
            failures.push(error);
          });
          const reconciled = owner.reconcile({
            previous: { id: MESSAGE_ID, role: "assistant", parts: [signed] },
            snapshot: {
              id: MESSAGE_ID,
              role: "assistant",
              parts: [placeholder],
            },
            preservesPartLayout: true,
            parseResultOutput: (output) => output,
          });
          expect(failures).toEqual([]);
          expect(
            reconciled.find(
              (part) =>
                part.type === "thinking" && part.stepId === placeholder.stepId,
            ),
          ).toEqual(placeholder);
          expect(
            reconciled.find(
              (part) =>
                part.type === "thinking" && part.stepId === signed.stepId,
            ),
          ).toEqual(signed);
        }
        const opaqueWithoutStep = {
          type: "thinking",
          content: "",
          signature: `opaque:${scenario.metadataToken}`,
          redacted: true,
          provenance: {
            provider: "anthropic",
            model: `model:${scenario.metadataToken}`,
            format: "anthropic-redacted-thinking",
          },
        } as const;
        const placeholderWithoutStep = {
          type: "thinking",
          content: "",
        } as const;
        const sameOpaqueIdentity = {
          type: "thinking",
          content: "",
          signature: opaqueWithoutStep.signature,
          redacted: true,
        } as const;
        const { reload: emptyReload } = await collectTurn(
          orderedTurn([
            [opaqueWithoutStep],
            [placeholderWithoutStep],
            [placeholderWithoutStep],
          ]),
          (parts) => {
            expect(
              parts,
              JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
            ).toEqual([placeholderWithoutStep]);
          },
        );
        expect(
          sdkParts(emptyReload),
          JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
        ).toEqual([placeholderWithoutStep]);
        const { reload: identityReload } = await collectTurn(
          orderedTurn([
            [opaqueWithoutStep],
            [sameOpaqueIdentity],
            [sameOpaqueIdentity],
          ]),
          (parts) => {
            expect(
              parts,
              JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
            ).toEqual([opaqueWithoutStep]);
          },
        );
        expect(
          sdkParts(identityReload),
          JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
        ).toEqual([opaqueWithoutStep]);
        const emptyOwner = new SnapshotPartReconciler([opaqueWithoutStep]);
        const emptyReconciled = emptyOwner.reconcile({
          previous: {
            id: MESSAGE_ID,
            role: "assistant",
            parts: [opaqueWithoutStep],
          },
          snapshot: {
            id: MESSAGE_ID,
            role: "assistant",
            parts: [placeholderWithoutStep],
          },
          preservesPartLayout: true,
          parseResultOutput: (content) => content,
        });
        expect(
          emptyReconciled.filter(
            (part) => part.type === "thinking" && part.signature !== undefined,
          ),
          JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
        ).toEqual([opaqueWithoutStep]);
        expect(
          emptyReconciled.filter(
            (part) => part.type === "thinking" && part.signature === undefined,
          ),
          JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
        ).toEqual([placeholderWithoutStep]);
        expect(emptyOwner.failure).toBeUndefined();
        const providerText = {
          type: "text",
          content: scenario.streamed,
          metadata: { provider: scenario.metadataToken },
        } as const;
        const { reload } = await collectTurn(
          orderedTurn([
            [providerText],
            [{ type: "text", content: providerText.content }],
            [{ type: "text", content: providerText.content }],
          ]),
          (parts) => {
            expect(
              parts,
              JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
            ).toEqual([providerText]);
          },
        );
        expect(
          sdkParts(reload),
          JSON.stringify({ oracle: CHAT_ORACLE.liveEqualsReload }),
        ).toEqual([providerText]);
      }),
      { numRuns: 100 },
    );
  },
  propertyTestTimeout(15_000),
);

const occurrenceFixtures = (token: string) =>
  ({
    text: { type: "text", content: token },
    thinking: { type: "thinking", content: token, stepId: MESSAGE_ID },
    "tool-call": {
      type: "tool-call",
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
      id: "occurrence-call",
      name: "lookup",
      arguments: "{}",
      input: {},
      state: "complete",
      output: token,
    },
    "tool-result": {
      type: "tool-result",
      toolCallId: "occurrence-call",
      content: token,
      state: "complete",
    },
    activity: {
      type: "activity",
      activityType: "review",
      content: { status: "complete", value: token },
    },
    "structured-output": {
      type: "structured-output",
      status: "complete",
      raw: JSON.stringify({ value: token }),
      data: { value: token },
    },
    subagent: {
      type: "subagent",
      subagent: {
        id: "occurrence-child",
        name: "Review",
        status: "finished",
        messages: [],
      },
    },
    "ui-resource": {
      type: "ui-resource",
      toolCallId: "occurrence-call",
      toolName: "lookup",
      resource: {
        uri: "ui://occurrence",
        mimeType: MCP_APP_RESOURCE_MIME_TYPE,
        text: token,
      },
    },
    image: {
      type: "image",
      source: {
        type: "url",
        value: "https://example.test/image.png",
        mimeType: "image/png",
      },
    },
    audio: {
      type: "audio",
      source: {
        type: "url",
        value: "https://example.test/audio.mp3",
        mimeType: "audio/mpeg",
      },
    },
    video: {
      type: "video",
      source: {
        type: "url",
        value: "https://example.test/video.mp4",
        mimeType: "video/mp4",
      },
    },
    document: {
      type: "document",
      source: {
        type: "url",
        value: "https://example.test/document.pdf",
        mimeType: "application/pdf",
      },
    },
  }) as const satisfies {
    [Kind in MessagePart["type"]]: Extract<MessagePart, { type: Kind }>;
  };

const duplicateOccurrencesArbitrary = fc.record({
  token: segmentTokenArbitrary,
  copies: fc.integer({ min: 2, max: 4 }),
  schedule: fc.array(fc.nat({ max: 100 }), { minLength: 1, maxLength: 40 }),
});

test("identical image occurrences survive repeated snapshots", async () => {
  const image = occurrenceFixtures("Answer").image;
  const expected = [
    { type: "text", content: "Answer" },
    image,
    image,
  ] satisfies UIMessage["parts"];
  const { reload } = await collectTurn(
    orderedTurn([expected.slice(0, 2), expected, expected]),
    (parts) => {
      expect(parts).toEqual(expected);
    },
  );
  expect(sdkParts(reload)).toEqual(expected);
});

test(
  "snapshot reconciliation preserves duplicate occurrences of every SDK part kind",
  async () => {
    await assertProperty(
      "snapshot reconciliation preserves duplicate occurrences of every SDK part kind",
      fc.asyncProperty(duplicateOccurrencesArbitrary, async (scenario) => {
        for (const references of ["distinct", "aliased"] as const) {
          const examples = Object.values(occurrenceFixtures(scenario.token));
          const approval = {
            type: "tool-call",
            metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
            id: "occurrence-approval",
            name: "lookup",
            arguments: "{}",
            input: {},
            state: "error",
            output: "Denied",
            approval: {
              id: "occurrence-decision",
              needsApproval: true,
              approved: false,
            },
          } as const satisfies ToolCallPart;
          const initial: UIMessage["parts"] = [...examples, approval];
          const chains = initial.map((part) =>
            Array.from({ length: scenario.copies }, () =>
              references === "distinct" ? structuredClone(part) : part,
            ),
          );
          const expected: UIMessage["parts"] = [];
          let step = 0;
          while (chains.some((chain) => chain.length > 0)) {
            const available = chains.filter((chain) => chain.length > 0);
            const decision = scenario.schedule.at(
              step % scenario.schedule.length,
            );
            if (decision === undefined) {
              panic("Duplicate occurrence scheduler has no decision");
            }
            const part = available.at(decision % available.length)?.shift();
            if (part === undefined) {
              panic("Duplicate occurrence scheduler selected an empty chain");
            }
            expected.push(part);
            step += 1;
          }
          // Identity keys describe content, not cardinality. Each repeated
          // snapshot slot remains a distinct ordered transcript occurrence.
          // Persistence deliberately drops SDK subagent cards. Reconciliation
          // still preserves every kind below; compare storage through its policy.
          const expectedPersisted = expected.flatMap((part) => {
            const decision = classifyChatPartForPersistence(part);
            return decision.type === "persist" ? [decision.part] : [];
          });
          const { reload, emitted } = await collectTurn(
            orderedTurn([initial, expected, structuredClone(expected)]),
            (parts) => {
              expect(parts).toEqual(expectedPersisted);
            },
          );
          expect(sdkParts(reload)).toEqual(expectedPersisted);
          const live = createStreamMessageCapture({
            initialMessages: [],
            capture: (message) => message,
          });
          for (const chunk of emitted) {
            live.processor.processChunk(chunk);
          }
          expect(
            live.processor.getMessages().flatMap(({ parts }) => parts),
          ).toEqual(expected);
          expectTerminalMonotonicity(emitted);
        }
      }),
      { numRuns: 100 },
    );
  },
  propertyTestTimeout(15_000),
);
