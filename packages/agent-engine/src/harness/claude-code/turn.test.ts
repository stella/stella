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

/** A turn of the adapter fed `messages`, then completed: what it emits. */
const eventsOf = async (
  messages: readonly { type: string }[],
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
  for (const message of messages) {
    session.handlers.message(message.type, message);
  }
  session.handlers.message("result", {
    type: "result",
    subtype: "success",
    is_error: false,
  });
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
