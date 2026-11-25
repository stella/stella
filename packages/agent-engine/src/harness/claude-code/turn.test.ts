import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { type HarnessEvent, harnessSessionId } from "../events";
import { HARNESS_TOOL_NAMES } from "../tool-parts";
import {
  AssistantMessageSchema,
  ContentBlockSchema,
  ToolResultBlockSchema,
  UserMessageSchema,
} from "./protocol";
import { ClaudeCodeTurnSession } from "./turn";

const SUBAGENT_CALL = "call-agent";
/** Text only a subagent wrote, thought or was returned. */
const PRIVATE_TEXT = "Clause 4 caps arrears at 4,200.";

const callId = fc.constantFrom("use-1", "use-2", "use-3");

const assistantBlock = fc.oneof(
  fc.constant({ type: "text", text: PRIVATE_TEXT }),
  fc.constant({ type: "thinking", thinking: PRIVATE_TEXT }),
  fc.record({
    type: fc.constant("tool_use"),
    id: callId,
    name: fc.constant("Read"),
    input: fc.constant({ file_path: "/workspace/drafts/lease.md" }),
  }),
  // A tool call of another shape than the pinned protocol's.
  fc.record(
    {
      type: fc.constant("tool_use"),
      id: fc.jsonValue(),
      name: fc.jsonValue(),
      input: fc.jsonValue(),
    },
    { requiredKeys: ["type"] },
  ),
);

const userBlock = fc.oneof(
  fc.constant({ type: "text", text: PRIVATE_TEXT }),
  fc.record({
    type: fc.constant("tool_result"),
    tool_use_id: callId,
    content: fc.constant(PRIVATE_TEXT),
  }),
  fc.record(
    {
      type: fc.constant("tool_result"),
      tool_use_id: fc.jsonValue(),
      content: fc.jsonValue(),
      is_error: fc.jsonValue(),
    },
    { requiredKeys: ["type"] },
  ),
);

/** A message of a subagent: well-formed, or of any other shape. */
const subagentMessage = fc
  .oneof(
    fc.record({
      type: fc.constant("assistant"),
      message: fc.oneof(
        fc.record({
          id: fc.constant("msg-sub"),
          content: fc.array(assistantBlock, { maxLength: 4 }),
        }),
        fc.jsonValue(),
      ),
    }),
    fc.record({
      type: fc.constant("user"),
      message: fc.oneof(
        fc.record({ content: fc.array(userBlock, { maxLength: 4 }) }),
        fc.record({ content: fc.constant(PRIVATE_TEXT) }),
        fc.jsonValue(),
      ),
    }),
    fc.record({ type: fc.constant("stream_event"), event: fc.jsonValue() }),
  )
  .map((message) => ({ ...message, parent_tool_use_id: SUBAGENT_CALL }));

/**
 * The parts of a subagent's message the adapter cannot read, by kind, in the
 * order it meets them: the message itself, or each tool call or result in it.
 */
const unreadableIn = (message: { type: string }): string[] => {
  if (message.type === "assistant") {
    const parsed = v.safeParse(AssistantMessageSchema, message);
    return parsed.success
      ? parsed.output.message.content
          .filter(
            (block) =>
              block.type === "tool_use" && !v.is(ContentBlockSchema, block),
          )
          .map(({ type }) => type)
      : ["assistant"];
  }
  if (message.type === "user") {
    const parsed = v.safeParse(UserMessageSchema, message);
    if (!parsed.success) {
      return ["user"];
    }
    const { content } = parsed.output.message;
    return typeof content === "string"
      ? []
      : content
          .filter(
            (block) =>
              block.type === "tool_result" &&
              !v.is(ToolResultBlockSchema, block),
          )
          .map(({ type }) => type);
  }
  return [];
};

/** A message the CLI writes: its type, and whatever else it carries. */
type CliMessage = { type: string } & Readonly<Record<string, unknown>>;

const SUCCESS: CliMessage = {
  type: "result",
  subtype: "success",
  is_error: false,
};
/** The uuid the turn's prompt went to the CLI with. */
const PROMPT_UUID = "prompt-uuid";

/** A turn of the adapter fed `messages`, then `last`: what it emits. */
const eventsOf = async (
  messages: readonly CliMessage[],
  last: CliMessage = SUCCESS,
): Promise<HarnessEvent[]> => {
  const session = new ClaudeCodeTurnSession({
    gracePeriodMs: 10,
    detached: () => undefined,
    stellaServer: "stella",
    sandboxNetworkHosts: new Set<string>(),
    approvedPlanMode: null,
    background: {
      keep: async () => await Promise.resolve(null),
      stopBackground: async () => {
        await Promise.resolve();
      },
    },
  });
  session.begin({
    sessionId: harnessSessionId("session-1"),
    continuation: { type: "fresh" },
  });
  session.promptWritten(PROMPT_UUID);
  for (const message of messages) {
    session.handlers.message(message.type, message);
  }
  session.handlers.message(last.type, last);
  const events: HarnessEvent[] = [];
  for await (const event of session.turn().events) {
    events.push(event);
  }
  return events;
};

describe("a Claude Code subagent's messages", () => {
  test("a subagent's message of any shape adds steps of the subagent or unsupported ones, never its text, and the turn completes", async () => {
    await assertProperty(
      "a subagent's message of any shape adds steps of the subagent or unsupported ones, never its text, and the turn completes",
      fc.asyncProperty(
        fc.array(subagentMessage, { maxLength: 6 }),
        async (messages) => {
          const events = await eventsOf(messages);
          expect(events.map(({ type }) => type)).not.toContain("turn.failed");
          expect(events.at(-1)).toEqual({
            type: "turn.completed",
            usage: null,
            boundary: null,
          });
          // Exactly what the adapter cannot read is shown as unsupported, as
          // a step of the subagent; none is dropped.
          expect(
            events.flatMap((event) =>
              event.type === "tool.completed" &&
              event.toolCall.name === HARNESS_TOOL_NAMES.unsupportedItem
                ? [
                    {
                      input: event.toolCall.input,
                      parentCallId: event.toolCall.parentCallId,
                    },
                  ]
                : [],
            ),
          ).toEqual(
            messages.flatMap(unreadableIn).map((itemType) => ({
              input: { itemType },
              parentCallId: SUBAGENT_CALL,
            })),
          );
          // Every step is the subagent's, and nothing it wrote, thought or
          // was returned is the turn's.
          for (const event of events) {
            if (event.type === "tool.started") {
              expect(event.toolCall.parentCallId).toBe(SUBAGENT_CALL);
            }
          }
          expect(JSON.stringify(events)).not.toContain(PRIVATE_TEXT);
        },
      ),
    );
  });

  test("a main-thread message that cannot be read still ends the turn", async () => {
    const events = await eventsOf([{ type: "assistant" }]);
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      failure: { type: "protocol_violation" },
    });
  });
});

describe("the model a Claude Code turn ran on", () => {
  /** The notice the pinned CLI writes when it retries on its fallback model. */
  const fallbackNotice = (scope: "session" | "local" | null) => ({
    type: "system",
    subtype: "model_refusal_fallback",
    trigger: "refusal",
    direction: "retry",
    ...(scope === null ? {} : { scope }),
    original_model: "claude-asked",
    fallback_model: "claude-fallback",
    request_id: "request-1",
    content: "The model declined; retrying on the fallback model.",
    uuid: "00000000-0000-4000-8000-000000000001",
    session_id: "session-1",
  });
  const reroutes = async (scope: "session" | "local" | null) =>
    (await eventsOf([fallbackNotice(scope)])).filter(
      ({ type }) => type === "model.rerouted",
    );

  test("a fallback after a refusal names the fallback model, unless only a subagent fell back", async () => {
    expect(await reroutes("session")).toEqual([
      { type: "model.rerouted", model: "claude-fallback" },
    ]);
    // An older CLI leaves the scope out: the main thread fell back.
    expect(await reroutes(null)).toEqual([
      { type: "model.rerouted", model: "claude-fallback" },
    ]);
    expect(await reroutes("local")).toEqual([]);
  });
});

describe("calls the CLI takes back", () => {
  /** An assistant message at transcript entry `uuid` calling `ids`. */
  const calling = (uuid: string, ids: readonly string[], extra = {}) => ({
    type: "assistant",
    message: {
      id: `msg-${uuid}`,
      content: ids.map((id) => ({
        type: "tool_use",
        id,
        name: "Read",
        input: { file_path: "/workspace/drafts/lease.md" },
      })),
    },
    parent_tool_use_id: null,
    uuid,
    ...extra,
  });
  const completions = (events: readonly HarnessEvent[]) =>
    events.flatMap((event) =>
      event.type === "tool.completed"
        ? [{ id: event.toolCall.id, status: event.result.status }]
        : [],
    );

  test("a refused response's calls end as stopped once the fallback takes them back", async () => {
    const events = await eventsOf([
      calling("entry-1", ["use-1"]),
      {
        type: "system",
        subtype: "model_refusal_fallback",
        fallback_model: "claude-fallback",
        retracted_message_uuids: ["entry-1"],
      },
    ]);
    expect(completions(events)).toEqual([{ id: "use-1", status: "cancelled" }]);
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("a retry closes the calls it supersedes, but not one it makes again", async () => {
    const events = await eventsOf([
      calling("entry-1", ["use-1", "use-2"]),
      calling("entry-2", ["use-2"], { supersedes: ["entry-1"] }),
      // Taken back once: a second notice names nothing left open.
      {
        type: "system",
        subtype: "model_refusal_fallback",
        fallback_model: "claude-fallback",
        retracted_message_uuids: ["entry-1"],
      },
    ]);
    expect(completions(events)).toEqual([{ id: "use-1", status: "cancelled" }]);
  });
});

describe("how a Claude Code result ends the turn", () => {
  test("a success marked as an error that says to run /login needs a new sign-in", async () => {
    const result = "Not logged in · Please run /login";
    const events = await eventsOf([], {
      type: "result",
      subtype: "success",
      is_error: true,
      result,
    });
    expect(events.at(-1)).toEqual({
      type: "turn.failed",
      failure: { type: "auth_required", message: result },
    });
  });

  test("a result of work the CLI started on its own does not end the turn; the turn's own result does", async () => {
    const events = await eventsOf(
      [
        {
          type: "result",
          subtype: "success",
          is_error: true,
          result: "A background task failed.",
          origin: { kind: "task-notification" },
          user_message_uuids: [],
        },
      ],
      { ...SUCCESS, origin: { kind: "human" } },
    );
    expect(events.map(({ type }) => type)).not.toContain("turn.failed");
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  test("a cycle the CLI started that took in the turn's prompt is the turn's end", async () => {
    const events = await eventsOf([], {
      ...SUCCESS,
      origin: { kind: "task-notification" },
      user_message_uuids: [PROMPT_UUID],
    });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });
});
