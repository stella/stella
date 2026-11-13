import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import type { HarnessEvent } from "../events";
import { HARNESS_TOOL_NAMES } from "../tool-parts";
import { CodexItemSchema, isCodexItemType } from "./protocol";
import { CodexTurnSession } from "./turn";

const MAIN_THREAD = "thread-main";
const MAIN_TURN = "turn-main";
const SUBAGENT_THREAD = "thread-subagent";
const SPAWN_CALL = "call-spawn";

/** One well-formed item of each kind, as the app server reports it. */
const WELL_FORMED = {
  collabAgentToolCall: {
    id: "item-1",
    tool: "wait",
    status: "completed",
    senderThreadId: MAIN_THREAD,
    receiverThreadIds: ["thread-other"],
    agentsStates: { "thread-other": { status: "running" } },
  },
  subAgentActivity: {
    id: "item-1",
    kind: "started",
    agentThreadId: "thread-other",
    agentPath: "/root/worker",
  },
  imageView: { id: "item-1", path: "/workspace/scans/page-1.png" },
  commandExecution: {
    id: "item-1",
    command: "ls",
    status: "completed",
    aggregatedOutput: "",
    exitCode: 0,
  },
  fileChange: {
    id: "item-1",
    changes: [{ path: "notes.md", kind: { type: "update" }, diff: "+x" }],
    status: "completed",
  },
  mcpToolCall: {
    id: "item-1",
    server: "docs",
    tool: "search",
    status: "completed",
    arguments: { query: "lease" },
  },
  webSearch: { id: "item-1", query: "civil code lease" },
  // A kind newer than the pinned protocol.
  holographicCall: { id: "item-1", payload: "x" },
} as const;

type Kind = keyof typeof WELL_FORMED;

/** The kinds that only add to what chat shows of the main thread. */
const presentationOnly = fc.constantFrom(
  "collabAgentToolCall",
  "subAgentActivity",
  "imageView",
);

/** What a subagent's own thread may report: steps of any kind. */
const ofSubagent = fc.constantFrom(
  "collabAgentToolCall",
  "subAgentActivity",
  "imageView",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "holographicCall",
);

/**
 * An item of `kind` with any of its fields missing or holding anything
 * else, the id among them: the shapes a CLI of another version may send.
 */
const itemOf = (kind: Kind) => {
  const fields = Object.keys(WELL_FORMED[kind]);
  return fc
    .record({
      missing: fc.subarray(fields),
      replaced: fc.dictionary(fc.constantFrom(...fields), fc.jsonValue()),
    })
    .map(({ missing, replaced }) => ({
      type: kind,
      ...Object.fromEntries(
        Object.entries({ ...WELL_FORMED[kind], ...replaced }).filter(
          ([field]) => !missing.includes(field),
        ),
      ),
    }));
};

const notificationsOn = (kinds: fc.Arbitrary<Kind>) =>
  fc.array(
    kinds.chain((kind) =>
      fc.record({
        kind: fc.constant(kind),
        method: fc.constantFrom("item/started", "item/completed"),
        item: itemOf(kind),
      }),
    ),
    { maxLength: 6 },
  );

/** A turn of the adapter fed `feed`, then completed: every event it emits. */
const eventsOf = async (
  feed: (notify: (method: string, params: unknown) => void) => void,
): Promise<HarnessEvent[]> => {
  const session = new CodexTurnSession({
    gracePeriodMs: 10,
    detached: () => undefined,
    stellaServer: "stella",
    capacityRetry: {
      maxAttempts: 0,
      baseDelayMs: 0,
      maxDelayMs: 0,
      sleep: async () => {
        await Promise.resolve();
      },
    },
    background: {
      keep: async () => await Promise.resolve(null),
      stopBackground: async () => {
        await Promise.resolve();
      },
    },
  });
  session.begin({
    threadId: MAIN_THREAD,
    turnId: MAIN_TURN,
    startedAt: 1,
    continuation: { type: "fresh" },
  });
  feed((method, params) => {
    session.handlers.notification(method, params);
  });
  session.handlers.notification("turn/completed", {
    threadId: MAIN_THREAD,
    turn: { id: MAIN_TURN, status: "completed" },
  });
  const events: HarnessEvent[] = [];
  for await (const event of session.turn().events) {
    events.push(event);
  }
  return events;
};

/** The steps that say the harness did something stella cannot show. */
const unsupportedSteps = (events: readonly HarnessEvent[]) =>
  events.flatMap((event) =>
    event.type === "tool.completed" &&
    event.toolCall.name === HARNESS_TOOL_NAMES.unsupportedItem
      ? [event.toolCall.input]
      : [],
  );

/** Whether the adapter can read `item` as its kind. */
const isReadable = (kind: Kind, item: unknown) =>
  isCodexItemType(kind) && v.is(CodexItemSchema, item);

describe("Codex items that only add to what chat shows", () => {
  test("a subagent or image item of any shape is its step or an unsupported step once it completes, and the turn completes", async () => {
    await assertProperty(
      "a subagent or image item of any shape is its step or an unsupported step once it completes, and the turn completes",
      fc.asyncProperty(notificationsOn(presentationOnly), async (sent) => {
        const events = await eventsOf((notify) => {
          for (const { method, item } of sent) {
            notify(method, {
              threadId: MAIN_THREAD,
              turnId: MAIN_TURN,
              item,
            });
          }
        });
        expect(events.map(({ type }) => type)).not.toContain("turn.failed");
        expect(events.at(-1)).toEqual({ type: "turn.completed", usage: null });
        // Exactly the completed items the adapter cannot read are shown as
        // unsupported, by their kind; none is dropped and none read twice.
        expect(unsupportedSteps(events)).toEqual(
          sent
            .filter(
              ({ kind, method, item }) =>
                method === "item/completed" && !isReadable(kind, item),
            )
            .map(({ kind }) => ({ itemType: kind })),
        );
      }),
    );
  });

  test("an item of any kind and shape on a subagent's thread is a step of the subagent or an unsupported one, and the turn completes", async () => {
    await assertProperty(
      "an item of any kind and shape on a subagent's thread is a step of the subagent or an unsupported one, and the turn completes",
      fc.asyncProperty(notificationsOn(ofSubagent), async (sent) => {
        const events = await eventsOf((notify) => {
          notify("item/completed", {
            threadId: MAIN_THREAD,
            turnId: MAIN_TURN,
            item: {
              type: "collabAgentToolCall",
              id: SPAWN_CALL,
              tool: "spawnAgent",
              status: "completed",
              senderThreadId: MAIN_THREAD,
              receiverThreadIds: [SUBAGENT_THREAD],
              agentsStates: {},
            },
          });
          for (const { method, item } of sent) {
            notify(method, {
              threadId: SUBAGENT_THREAD,
              turnId: "turn-subagent",
              item,
            });
          }
        });
        expect(events.map(({ type }) => type)).not.toContain("turn.failed");
        expect(events.at(-1)).toEqual({ type: "turn.completed", usage: null });
        expect(unsupportedSteps(events)).toEqual(
          sent
            .filter(
              ({ kind, method, item }) =>
                method === "item/completed" && !isReadable(kind, item),
            )
            .map(({ kind }) => ({ itemType: kind, parentCallId: SPAWN_CALL })),
        );
        // Nothing a subagent wrote or thought is the turn's.
        expect(
          events.filter(
            ({ type }) =>
              type.startsWith("text.") || type.startsWith("reasoning."),
          ),
        ).toEqual([]);
      }),
    );
  });

  test("a main-thread item the turn depends on still ends it when it cannot be read", async () => {
    const events = await eventsOf((notify) => {
      notify("item/completed", {
        threadId: MAIN_THREAD,
        turnId: MAIN_TURN,
        item: { type: "commandExecution", id: "item-1", command: 42 },
      });
    });
    expect(events.at(-1)).toMatchObject({
      type: "turn.failed",
      failure: { type: "protocol_violation" },
    });
  });
});
