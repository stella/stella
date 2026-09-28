import { EventType, StreamProcessor } from "@tanstack/ai";
import type { StreamChunk } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  keepPostedMessages,
  keepReasoningSteps,
} from "@/features/chat/chat-snapshot-history";

const message = (id: string, role: "assistant" | "user"): UIMessage => ({
  id,
  parts: [],
  role,
});

/** The page's messages, and which of them the server's snapshot keeps, in
 *  order, followed by the run's new messages. */
const caseArb = fc
  .tuple(
    fc.array(fc.boolean(), { maxLength: 8, minLength: 1 }),
    fc.nat({ max: 2 }),
  )
  .map(([kept, added]) => {
    const posted = kept.map((_, index) =>
      message(
        `posted-${String(index)}`,
        index % 2 === 0 ? "user" : "assistant",
      ),
    );
    // The page's latest message is the one the run answers: always kept.
    const snapshot = [
      ...posted.filter(
        (_, index) => kept[index] === true || index === posted.length - 1,
      ),
      ...Array.from({ length: added }, (_, index) =>
        message(`added-${String(index)}`, "assistant"),
      ),
    ].map(({ id, parts, role }) => ({ content: "", id, parts, role }));
    return { posted, snapshot };
  });

describe("keepPostedMessages", () => {
  test("keeps every posted message, in the page's order, ahead of the run's", () => {
    fc.assert(
      fc.property(caseArb, ({ posted, snapshot }) => {
        const ids = keepPostedMessages(posted, snapshot).map(({ id }) => id);
        expect(ids).toEqual([
          ...posted.map(({ id }) => id),
          ...snapshot
            .map(({ id }) => id)
            .filter((id) => id.startsWith("added-")),
        ]);
      }),
      propertyConfig({ numRuns: 200 }),
    );
  });

  test("returns a snapshot that holds every posted message unchanged", () => {
    const posted = [message("a", "user"), message("b", "assistant")];
    const snapshot = posted.map(({ id, parts, role }) => ({
      content: "",
      id,
      parts,
      role,
    }));
    expect(keepPostedMessages(posted, snapshot)).toEqual(snapshot);
  });
});

type SnapshotMessages = Extract<
  StreamChunk,
  { type: EventType.MESSAGES_SNAPSHOT }
>["messages"];

describe("keepReasoningSteps", () => {
  const ANSWER_ID = "answer";
  const timestamp = 0;

  /** The snapshot an approval interrupt ends its run with: the answer's
   *  reasoning ahead of the answer and the call that waits. */
  const interruptSnapshot: SnapshotMessages = [
    { content: "Draft the NDA", id: "user", role: "user" },
    {
      content: "Thinking first",
      encryptedValue: "signature-first",
      id: "reasoning-first",
      role: "reasoning",
    },
    {
      content: "",
      id: ANSWER_ID,
      role: "assistant",
      toolCalls: [
        {
          function: { arguments: "{}", name: "delete" },
          id: "call-1",
          type: "function",
        },
      ],
    },
  ];

  /** The thinking the answer shows once the run that continues it streams
   *  a new thinking step, after `snapshot` closed the first run. */
  const thinkingAfterContinuation = (snapshot: SnapshotMessages) => {
    const processor = new StreamProcessor();
    processor.processChunk({
      messages: snapshot,
      timestamp,
      type: EventType.MESSAGES_SNAPSHOT,
    });
    processor.prepareAssistantMessage();
    const continuation: StreamChunk[] = [
      {
        messageId: ANSWER_ID,
        role: "assistant",
        timestamp,
        type: EventType.TEXT_MESSAGE_START,
      },
      { stepName: "thinking-second", timestamp, type: EventType.STEP_STARTED },
      {
        delta: "Thinking second",
        messageId: "reasoning-second",
        timestamp,
        type: EventType.REASONING_MESSAGE_CONTENT,
      },
    ];
    for (const chunk of continuation) {
      processor.processChunk(chunk);
    }
    return processor
      .getMessages()
      .filter(({ id }) => id === ANSWER_ID)
      .flatMap(({ parts }) =>
        parts.flatMap((part) =>
          part.type === "thinking"
            ? [{ content: part.content, signature: part.signature }]
            : [],
        ),
      );
  };

  test("keeps an earlier step's reasoning when the next run reasons again", () => {
    // The fixture must reach the fault: taken as served, the snapshot's
    // thinking is overwritten by the continuation's.
    expect(thinkingAfterContinuation(interruptSnapshot)).toEqual([
      { content: "Thinking second", signature: "signature-first" },
    ]);

    expect(
      thinkingAfterContinuation(keepReasoningSteps(interruptSnapshot)),
    ).toEqual([
      { content: "Thinking first", signature: "signature-first" },
      { content: "Thinking second", signature: undefined },
    ]);
  });

  test("leaves every message other than a reasoning one as served", () => {
    const kept = keepReasoningSteps(interruptSnapshot);
    expect(kept.map(({ id }) => id)).toEqual(
      interruptSnapshot.map(({ id }) => id),
    );
    expect(kept.filter(({ id }) => id !== "reasoning-first")).toEqual(
      interruptSnapshot.filter(({ id }) => id !== "reasoning-first"),
    );
  });
});
