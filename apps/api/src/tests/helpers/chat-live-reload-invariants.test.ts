import { EventType, toolDefinition } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  buildEngineChunks,
  buildEngineSnapshot,
  unsafeFixture,
} from "@/api/tests/helpers/chat-fixtures";
import {
  diffLiveAgainstReload,
  findWireIdentityViolations,
  TEXT_SEGMENT_SEPARATOR,
} from "@/api/tests/helpers/chat-live-reload-invariants";
import { CHAT_ORACLE } from "@/api/tests/helpers/chat-oracles";

// The live/reload comparison allows exactly one difference, a message's text
// ahead of its tool cards. These cases pin that it is the only one: every
// change a user can see, or act on in a different order, still differs.

type Part = UIMessage["parts"][number];

const text = (content: string): Part => ({ content, type: "text" });

const call = (id: string, output?: unknown): Part => ({
  arguments: JSON.stringify({ name: id }),
  id,
  input: { name: id },
  name: "mcp__external__delete",
  state: output === undefined ? "input-complete" : "complete",
  type: "tool-call",
  ...(output === undefined ? {} : { output }),
});

const result = (toolCallId: string): Part => ({
  content: "{}",
  state: "complete",
  toolCallId,
  type: "tool-result",
});

const thinking = (content: string): Part => ({ content, type: "thinking" });

const assistant = (id: string, parts: Part[]): UIMessage => ({
  id,
  parts,
  role: "assistant",
});

/** A turn as a reload shows it: text and tool cards interleaved. */
const reloaded = [
  assistant("turn", [
    thinking("Look first"),
    text("Checking the drafts."),
    call("call-1", { deleted: "call-1" }),
    result("call-1"),
    text("Now the second."),
    call("call-2"),
  ]),
];

describe("comparing the live view with a reload", () => {
  test("allows the turn's text ahead of its tool cards", () => {
    const live = [
      assistant("turn", [
        thinking("Look first"),
        text(`Checking the drafts.${TEXT_SEGMENT_SEPARATOR}Now the second.`),
        call("call-1", { deleted: "call-1" }),
        call("call-2"),
        result("call-1"),
      ]),
    ];

    expect(diffLiveAgainstReload({ live, reload: reloaded })).toEqual([]);
  });

  test("ignores the key order of a tool output", () => {
    const withOutput = (output: unknown) => [
      assistant("turn", [call("call-1", output)]),
    ];

    expect(
      diffLiveAgainstReload({
        live: withOutput({ a: 1, b: { c: 2, d: 3 } }),
        reload: withOutput({ b: { d: 3, c: 2 }, a: 1 }),
      }),
    ).toEqual([]);
  });

  const differing: [string, UIMessage[]][] = [
    [
      "tool cards in another order",
      [
        assistant("turn", [
          thinking("Look first"),
          text("Checking the drafts.\n\nNow the second."),
          call("call-2"),
          call("call-1", { deleted: "call-1" }),
          result("call-1"),
        ]),
      ],
    ],
    [
      "text segments in another order",
      [
        assistant("turn", [
          thinking("Look first"),
          text("Now the second.\n\nChecking the drafts."),
          call("call-1", { deleted: "call-1" }),
          call("call-2"),
          result("call-1"),
        ]),
      ],
    ],
    [
      "reasoning on another message",
      [
        assistant("reasoning", [thinking("Look first")]),
        assistant("turn", [
          text("Checking the drafts.\n\nNow the second."),
          call("call-1", { deleted: "call-1" }),
          call("call-2"),
          result("call-1"),
        ]),
      ],
    ],
    [
      "a missing tool result",
      [
        assistant("turn", [
          thinking("Look first"),
          text("Checking the drafts.\n\nNow the second."),
          call("call-1", { deleted: "call-1" }),
          call("call-2"),
        ]),
      ],
    ],
    [
      "a card in another state",
      [
        assistant("turn", [
          thinking("Look first"),
          text("Checking the drafts.\n\nNow the second."),
          call("call-1"),
          call("call-2"),
          result("call-1"),
        ]),
      ],
    ],
  ];

  test.each(differing)("still reports %s", (_label, live) => {
    expect(
      diffLiveAgainstReload({ live, reload: reloaded }).map(
        ({ oracle }) => oracle,
      ),
    ).toContain(CHAT_ORACLE.liveEqualsReload);
  });
});

describe("the wire identity oracle", () => {
  const user: UIMessage = {
    id: "user-1",
    parts: [text("Delete both drafts")],
    role: "user",
  };

  test("flags the engine's snapshot of a message split at a tool result", () => {
    const snapshot = buildEngineSnapshot([user, ...reloaded]);
    // The fixture must reach the fault: the engine really emits two copies.
    expect(
      snapshot.messages.filter(({ id }) => id === "turn").length,
    ).toBeGreaterThan(1);

    expect(
      findWireIdentityViolations([snapshot]).map(({ oracle }) => oracle),
    ).toEqual([CHAT_ORACLE.wireSnapshotIdentity]);
  });

  test("passes the engine's snapshot of a message without tool results", () => {
    const snapshot = buildEngineSnapshot([
      user,
      assistant("turn", [text("Which draft?"), call("call-1")]),
    ]);

    expect(findWireIdentityViolations([snapshot])).toEqual([]);
  });

  test("flags the interrupt snapshot the engine emits when a later call needs approval", async () => {
    const approvalTool = toolDefinition({
      description: "Deletes a draft once the user approves",
      inputSchema: toTanStackToolSchema(v.object({ name: v.string() })),
      name: "mcp__external__delete",
      needsApproval: true,
    }).server(async ({ name }) => await Promise.resolve({ deleted: name }));
    const chunks = await buildEngineChunks({
      // An earlier answer that goes on after its tool result, so the engine
      // splits it when it replays the history.
      messages: [
        user,
        assistant("turn", [
          text("Checking the drafts."),
          call("call-1", { deleted: "call-1" }),
          result("call-1"),
          text("The first is gone."),
        ]),
        { id: "user-2", parts: [text("And the second")], role: "user" },
      ],
      tools: [approvalTool],
      turns: [
        {
          arguments: JSON.stringify({ name: "call-2" }),
          toolCallId: "call-2",
          toolName: "mcp__external__delete",
          type: "tool-call",
        },
      ],
    });
    // The fixture must reach the fault: the engine's snapshot repeats the
    // earlier answer's id.
    expect(
      chunks.flatMap((chunk) =>
        chunk.type === EventType.MESSAGES_SNAPSHOT
          ? chunk.messages.filter(({ id }) => id === "turn")
          : [],
      ),
    ).toHaveLength(2);

    expect(
      findWireIdentityViolations(chunks).map(({ oracle }) => oracle),
    ).toEqual([CHAT_ORACLE.wireSnapshotIdentity]);
  });

  test("flags a malformed snapshot that lists one tool call twice", () => {
    const malformed = unsafeFixture(
      "No engine lists a call twice in one message; the oracle must still catch it.",
      {
        messages: [
          {
            id: "turn",
            role: "assistant" as const,
            toolCalls: [
              {
                function: { arguments: "{}", name: "lookup" },
                id: "call-1",
                type: "function" as const,
              },
              {
                function: { arguments: "{}", name: "lookup" },
                id: "call-1",
                type: "function" as const,
              },
            ],
          },
        ],
        type: EventType.MESSAGES_SNAPSHOT,
      } satisfies StreamChunk,
    );

    expect(findWireIdentityViolations([malformed])).toEqual([
      {
        detail: {
          chunk: 0,
          messageIds: [],
          toolCallIds: ["call-1"],
          toolResultIds: [],
        },
        oracle: CHAT_ORACLE.wireSnapshotIdentity,
      },
    ]);
  });
});
