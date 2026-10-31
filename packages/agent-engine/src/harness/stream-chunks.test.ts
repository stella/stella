import {
  EventType,
  normalizeStreamChunk,
  type StreamChunk,
  StreamProcessor,
  type UIMessage,
} from "@tanstack/ai";
import {
  type CodexThreadEvent,
  translateThreadEvents,
} from "@tanstack/ai-codex";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  type HarnessEvent,
  type HarnessFailure,
  harnessSessionId,
  type HarnessToolCall,
} from "./events";
import {
  HARNESS_CONTINUATION_EVENT,
  HARNESS_QUESTION_TOOL,
  harnessEventsToChunks,
} from "./stream-chunks";

const MODEL = "gpt-test";
const RUN_ID = "run-1";
const THREAD_ID = "thread-1";

const counter = () => {
  let next = 0;
  return () => {
    next += 1;
    return `id-${next}`;
  };
};

async function* from<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) {
    yield item;
  }
}

const localChunks = async (events: readonly HarnessEvent[]) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of harnessEventsToChunks(from(events), {
    harness: "codex",
    model: MODEL,
    runId: RUN_ID,
    threadId: THREAD_ID,
    generateId: counter(),
    now: () => 0,
  })) {
    chunks.push(chunk);
  }
  return chunks;
};

const cloudChunks = async (events: readonly CodexThreadEvent[]) => {
  const chunks: StreamChunk[] = [];
  for await (const chunk of translateThreadEvents(from(events), {
    model: MODEL,
    runId: RUN_ID,
    threadId: THREAD_ID,
    genId: counter(),
  })) {
    chunks.push(...normalizeStreamChunk(chunk));
  }
  return chunks;
};

/** Fold chunks the way persistence does and return what would be stored. */
const fold = (chunks: readonly StreamChunk[]) => {
  const processor = new StreamProcessor({ initialMessages: [] });
  for (const chunk of chunks) {
    processor.processChunk(chunk);
  }
  return processor.getMessages();
};

const storedParts = (messages: readonly UIMessage[]) =>
  messages.map(({ role, parts }) => ({ role, parts }));

const mcpCall = {
  id: "call-mcp",
  name: "mcp__stella__search",
  input: { query: "lease" },
} as const satisfies HarnessToolCall;
const commandCall = {
  id: "call-cmd",
  name: "command_execution",
  input: { command: "ls" },
} as const satisfies HarnessToolCall;

describe("local harness chunks", () => {
  test("persist the same message as the cloud Codex translator for the same turn", async () => {
    const cloud: CodexThreadEvent[] = [
      { type: "thread.started", thread_id: "native-1" },
      { type: "turn.started" },
      {
        type: "item.completed",
        item: { id: "r-1", type: "reasoning", text: "Searching the matter." },
      },
      {
        type: "item.started",
        item: {
          id: mcpCall.id,
          type: "mcp_tool_call",
          server: "stella",
          tool: "search",
          arguments: mcpCall.input,
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: mcpCall.id,
          type: "mcp_tool_call",
          server: "stella",
          tool: "search",
          arguments: mcpCall.input,
          result: { content: [{ type: "text", text: "2 results" }] },
          status: "completed",
        },
      },
      {
        type: "item.started",
        item: {
          id: commandCall.id,
          type: "command_execution",
          command: "ls",
          status: "in_progress",
        },
      },
      {
        type: "item.completed",
        item: {
          id: commandCall.id,
          type: "command_execution",
          command: "ls",
          aggregated_output: "notes.md\n",
          exit_code: 0,
          status: "completed",
        },
      },
      {
        type: "item.updated",
        item: { id: "m-1", type: "agent_message", text: "Found" },
      },
      {
        type: "item.completed",
        item: { id: "m-1", type: "agent_message", text: "Found two leases." },
      },
      {
        type: "turn.completed",
        usage: {
          input_tokens: 120,
          cached_input_tokens: 20,
          output_tokens: 30,
          reasoning_output_tokens: 5,
        },
      },
    ];
    const local: HarnessEvent[] = [
      {
        type: "session.started",
        sessionId: harnessSessionId("native-1"),
        continuation: { type: "fresh" },
      },
      {
        type: "reasoning.completed",
        messageId: "r-1",
        text: "Searching the matter.",
      },
      { type: "tool.started", toolCall: mcpCall },
      {
        type: "tool.completed",
        toolCall: mcpCall,
        result: { content: "2 results", status: "succeeded" },
      },
      { type: "tool.started", toolCall: commandCall },
      {
        type: "tool.completed",
        toolCall: commandCall,
        result: {
          content: JSON.stringify({
            aggregated_output: "notes.md\n",
            exit_code: 0,
            status: "completed",
          }),
          status: "succeeded",
        },
      },
      { type: "text.delta", messageId: "m-1", delta: "Found" },
      { type: "text.completed", messageId: "m-1", text: "Found two leases." },
      {
        type: "turn.completed",
        usage: {
          inputTokens: 120,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 5,
        },
      },
    ];

    const cloudStored = storedParts(fold(await cloudChunks(cloud)));
    const localStream = await localChunks(local);
    expect(cloudStored.flatMap(({ parts }) => parts).length).toBeGreaterThan(3);
    expect(storedParts(fold(localStream))).toEqual(cloudStored);

    // Usage and finish reason match; each stream stamps its own time.
    const finish = (chunks: readonly StreamChunk[]) => {
      const last = chunks.findLast(
        (chunk) => chunk.type === EventType.RUN_FINISHED,
      );
      return { finishReason: last?.finishReason, usage: last?.usage };
    };
    expect(finish(localStream)).toEqual(finish(await cloudChunks(cloud)));
  });

  test("an approval pauses the run on the tool call and the answer continues it", async () => {
    const deleteCall = {
      id: "call-rm",
      name: "command_execution",
      input: { command: "rm draft.md" },
    } as const satisfies HarnessToolCall;
    const events: HarnessEvent[] = [
      {
        type: "session.started",
        sessionId: harnessSessionId("native-2"),
        continuation: { type: "fresh" },
      },
      { type: "tool.started", toolCall: deleteCall },
      {
        type: "approval.requested",
        request: {
          requestId: "approval-1",
          kind: "command",
          toolCall: deleteCall,
          reason: "Deletes a file",
          options: [
            { id: "accept", decision: "approve" },
            { id: "decline", decision: "deny" },
          ],
        },
      },
      { type: "interaction.resolved", requestId: "approval-1" },
      {
        type: "tool.completed",
        toolCall: deleteCall,
        result: {
          content: JSON.stringify({ status: "declined" }),
          status: "failed",
        },
      },
      { type: "text.completed", messageId: "m-2", text: "Left it in place." },
      { type: "turn.completed", usage: null },
    ];
    const chunks = await localChunks(events);
    const pauseIndex = chunks.findIndex(
      (chunk) =>
        chunk.type === EventType.RUN_FINISHED &&
        chunk.outcome?.type === "interrupt",
    );
    expect(pauseIndex).toBeGreaterThan(0);

    const paused = fold(chunks.slice(0, pauseIndex + 1));
    const pausedCall = paused
      .flatMap(({ parts }) => parts)
      .find((part) => part.type === "tool-call" && part.id === deleteCall.id);
    expect(pausedCall).toMatchObject({
      state: "approval-requested",
      approval: { id: "approval-1" },
    });

    const runIds = chunks
      .filter((chunk) => chunk.type === EventType.RUN_STARTED)
      .map((chunk) => chunk.runId);
    expect(runIds).toEqual([RUN_ID, `${RUN_ID}:1`]);

    const finished = fold(chunks).flatMap(({ parts }) => parts);
    expect(finished).toContainEqual(
      expect.objectContaining({
        type: "tool-result",
        toolCallId: deleteCall.id,
        state: "error",
      }),
    );
    expect(finished).toContainEqual(
      expect.objectContaining({ type: "text", content: "Left it in place." }),
    );
  });

  test("a question answered by the next message completes its call without pausing", async () => {
    const questionCall = {
      id: "call-q",
      name: HARNESS_QUESTION_TOOL,
      input: {},
    } as const satisfies HarnessToolCall;
    const chunks = await localChunks([
      {
        type: "session.started",
        sessionId: harnessSessionId("native-3"),
        continuation: {
          type: "resume_unavailable",
          reason: "session_not_found",
          message: "no rollout found",
        },
      },
      {
        type: "question.requested",
        request: {
          requestId: "q-1",
          toolCall: questionCall,
          answerWith: "next_message",
          questions: [
            {
              id: "0",
              header: "Question",
              prompt: "Which governing law?",
              options: [{ label: "Czech", description: "" }],
              allowsFreeText: true,
              secret: false,
            },
          ],
        },
      },
      { type: "turn.completed", usage: null },
    ]);
    expect(
      chunks.some(
        (chunk) =>
          chunk.type === EventType.RUN_FINISHED &&
          chunk.outcome?.type === "interrupt",
      ),
    ).toBe(false);
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: EventType.CUSTOM,
        name: HARNESS_CONTINUATION_EVENT,
        value: expect.objectContaining({ type: "resume_unavailable" }),
      }),
    );
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: EventType.CUSTOM,
        name: "codex.session-id",
        value: { sessionId: "native-3" },
      }),
    );
    const result = chunks.find(
      (chunk) => chunk.type === EventType.TOOL_CALL_RESULT,
    );
    expect(result).toMatchObject({ toolCallId: questionCall.id });
    const content = result?.content;
    expect(
      typeof content === "string" ? JSON.parse(content) : content,
    ).toMatchObject({ status: "awaiting_reply" });
  });

  test("an interrupted turn ends cancelled and pairs its open tool calls", async () => {
    const chunks = await localChunks([
      {
        type: "session.started",
        sessionId: harnessSessionId("native-4"),
        continuation: { type: "resumed" },
      },
      { type: "tool.started", toolCall: commandCall },
      { type: "turn.interrupted" },
    ]);
    expect(chunks.at(-1)).toMatchObject({
      type: EventType.RUN_FINISHED,
      outcome: { type: "cancelled" },
    });
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: EventType.TOOL_CALL_RESULT,
        toolCallId: commandCall.id,
        content: JSON.stringify({ status: "interrupted" }),
      }),
    );
  });

  test("each failure kind ends the run with its own error code", async () => {
    const failures = {
      auth_required: { type: "auth_required", message: "Sign in again." },
      usage_limit: {
        type: "usage_limit",
        message: "Limit reached.",
        resetsAt: "2026-10-28T14:00:00.000Z",
      },
      provider_error: {
        type: "provider_error",
        message: "Model unavailable.",
        code: "modelNotFound",
      },
      harness_exited: {
        type: "harness_exited",
        message: "The harness stopped.",
        exitCode: 1,
        signal: null,
      },
      protocol_violation: {
        type: "protocol_violation",
        message: "Malformed message.",
      },
    } as const satisfies {
      [Type in HarnessFailure["type"]]: Extract<HarnessFailure, { type: Type }>;
    };
    const codes = new Set<string>();
    for (const failure of Object.values(failures)) {
      const chunks = await localChunks([{ type: "turn.failed", failure }]);
      const last = chunks.at(-1);
      expect(last?.type).toBe(EventType.RUN_ERROR);
      if (last?.type !== EventType.RUN_ERROR) {
        continue;
      }
      expect(last.message).toBe(failure.message);
      codes.add(String(last.code));
    }
    expect(codes.size).toBe(Object.keys(failures).length);
  });

  test("a stream that ends without a terminal event fails as a protocol violation", async () => {
    const chunks = await localChunks([
      { type: "tool.started", toolCall: commandCall },
    ]);
    expect(chunks.at(-1)).toMatchObject({
      type: EventType.RUN_ERROR,
      code: "harness.protocol_violation",
    });
  });
});

describe("chunk stream invariants", () => {
  const toolCall = fc
    .constantFrom("a", "b", "c")
    .map((id): HarnessToolCall => ({
      id: `call-${id}`,
      name: "command_execution",
      input: { command: id },
    }));
  const event: fc.Arbitrary<HarnessEvent> = fc.oneof(
    fc.constant<HarnessEvent>({
      type: "session.started",
      sessionId: harnessSessionId("native"),
      continuation: { type: "fresh" },
    }),
    fc
      .tuple(fc.constantFrom("m1", "m2"), fc.string())
      .map(([messageId, delta]) => ({
        type: "text.delta" as const,
        messageId,
        delta,
      })),
    fc
      .tuple(fc.constantFrom("m1", "m2"), fc.string())
      .map(([messageId, text]) => ({
        type: "text.completed" as const,
        messageId,
        text,
      })),
    toolCall.map((call) => ({ type: "tool.started" as const, toolCall: call })),
    fc.tuple(toolCall, fc.boolean()).map(([call, failed]) => ({
      type: "tool.completed" as const,
      toolCall: call,
      result: {
        content: "{}",
        status: failed ? ("failed" as const) : ("succeeded" as const),
      },
    })),
    toolCall.map((call) => ({
      type: "approval.requested" as const,
      request: {
        requestId: `approval-${call.id}`,
        kind: "command" as const,
        toolCall: call,
        reason: null,
        options: [{ id: "accept", decision: "approve" as const }],
      },
    })),
    toolCall.map((call) => ({
      type: "interaction.resolved" as const,
      requestId: `approval-${call.id}`,
    })),
    fc.constant<HarnessEvent>({ type: "retrying", message: "retry" }),
  );
  const terminal: fc.Arbitrary<HarnessEvent | null> = fc.oneof(
    fc.constant<HarnessEvent>({ type: "turn.completed", usage: null }),
    fc.constant<HarnessEvent>({ type: "turn.interrupted" }),
    fc.constant<HarnessEvent>({
      type: "turn.failed",
      failure: { type: "protocol_violation", message: "x" },
    }),
    fc.constant(null),
  );

  test("runs alternate, every tool call is paired and exactly one terminal chunk ends the stream", async () => {
    await assertProperty(
      "runs alternate, every tool call is paired and exactly one terminal chunk ends the stream",
      fc.asyncProperty(
        fc.array(event, { maxLength: 25 }),
        terminal,
        fc.array(event, { maxLength: 3 }),
        async (body, end, trailing) => {
          const chunks = await localChunks(
            end === null ? body : [...body, end, ...trailing],
          );
          let open = false;
          const started = new Set<string>();
          const results = new Map<string, number>();
          const runIds = new Set<string>();
          for (const [index, chunk] of chunks.entries()) {
            if (chunk.type === EventType.RUN_STARTED) {
              expect(open).toBe(false);
              expect(runIds.has(chunk.runId)).toBe(false);
              runIds.add(chunk.runId);
              open = true;
            } else if (
              chunk.type === EventType.RUN_FINISHED ||
              chunk.type === EventType.RUN_ERROR
            ) {
              expect(open).toBe(true);
              open = false;
              const interrupts =
                chunk.type === EventType.RUN_FINISHED &&
                chunk.outcome?.type === "interrupt"
                  ? chunk.outcome.interrupts
                  : null;
              expect(index === chunks.length - 1).toBe(interrupts === null);
              for (const interrupt of interrupts ?? []) {
                expect(started.has(String(interrupt.toolCallId))).toBe(true);
              }
            } else if (chunk.type === EventType.TOOL_CALL_START) {
              expect(open).toBe(true);
              expect(started.has(chunk.toolCallId)).toBe(false);
              started.add(chunk.toolCallId);
            } else if (chunk.type === EventType.TOOL_CALL_RESULT) {
              expect(open).toBe(true);
              expect(started.has(chunk.toolCallId)).toBe(true);
              results.set(
                chunk.toolCallId,
                (results.get(chunk.toolCallId) ?? 0) + 1,
              );
            } else {
              // Every other chunk belongs inside an open run.
              expect(open).toBe(true);
            }
          }
          expect(open).toBe(false);
          for (const id of started) {
            expect(results.get(id)).toBe(1);
          }
        },
      ),
    );
  });
});
