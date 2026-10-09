import { uiMessagesToWire } from "@tanstack/ai";
import type { UIMessage as StreamUIMessage } from "@tanstack/ai";
import type { UIMessage } from "@tanstack/ai-client";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  keepPostedMessages,
  keepReasoningSteps,
} from "@/features/chat/chat-snapshot-history";

const message = (id: string, role: "assistant" | "user") =>
  ({
    id,
    parts: [],
    role,
  }) satisfies UIMessage;

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
  test("rejects an activity message whose parts cannot preserve its wire identity", () => {
    const activityPart = {
      type: "activity",
      activityType: "progress",
      content: { completed: 2 },
    } as const;
    const invalidParts = [
      [],
      [{ type: "text", content: "Not an activity" }],
      [activityPart, activityPart],
      [activityPart, { type: "text", content: "Extra part" }],
    ] satisfies UIMessage["parts"][];
    for (const parts of invalidParts) {
      expect(() =>
        keepPostedMessages(
          [{ id: "malformed-activity", role: "activity", parts }],
          [],
        ),
      ).toThrow("An activity message must contain exactly one activity part");
    }
  });

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

  test("restores client activity using its structured wire payload", () => {
    const posted: UIMessage[] = [
      {
        id: "activity-progress",
        role: "activity",
        parts: [
          {
            type: "activity",
            activityType: "progress",
            content: { completed: 2 },
          },
        ],
      },
      message("answer", "assistant"),
    ];
    const kept = keepPostedMessages(posted, [
      { id: "answer", role: "assistant", content: "" },
    ]);
    expect(kept.at(0)).toEqual({
      id: "activity-progress",
      role: "activity",
      activityType: "progress",
      content: { completed: 2 },
    });
    expect(kept.map(({ id }) => id)).toEqual(["activity-progress", "answer"]);
  });
});

describe("keepReasoningSteps", () => {
  /** An answer that reasoned twice and waits on an approval, as the page
   *  holds it when the run's interrupt snapshot arrives. */
  const history: StreamUIMessage[] = [
    {
      id: "user",
      parts: [{ content: "Draft the NDA", type: "text" }],
      role: "user",
    },
    {
      id: "answer",
      parts: [
        {
          content: "Thinking first",
          signature: "signature-first",
          stepId: "thinking-first",
          type: "thinking",
        },
        {
          content: "Thinking second",
          stepId: "thinking-second",
          type: "thinking",
        },
        {
          approval: { id: "approval_call-1", needsApproval: true },
          arguments: "{}",
          id: "call-1",
          input: {},
          name: "delete",
          state: "approval-requested",
          type: "tool-call",
        },
      ],
      role: "assistant",
    },
  ];
  // The wire form the engine's snapshot carries, from TanStack's own
  // converter: the reasoning fanned out ahead of the answer, with no step.
  const snapshot = uiMessagesToWire(history, {
    includeSnapshotStructuredOutput: true,
  });
  const reasoningIds = snapshot.flatMap(({ id, role }) =>
    role === "reasoning" ? [id] : [],
  );

  test("gives every reasoning message's thinking a step of its own", () => {
    // The fixture must reach the fault: both steps reach the wire, and there
    // they name no step for TanStack's stream processor to key them by.
    expect(reasoningIds).toHaveLength(2);
    expect(JSON.stringify(snapshot)).not.toContain("stepId");

    const kept = keepReasoningSteps(snapshot);
    const thinking = kept
      .filter(({ id }) => reasoningIds.includes(id))
      .flatMap((served) => ("parts" in served ? served.parts : []));
    expect(thinking).toEqual([
      {
        content: "Thinking first",
        signature: "signature-first",
        stepId: reasoningIds[0],
        type: "thinking",
      },
      { content: "Thinking second", stepId: reasoningIds[1], type: "thinking" },
    ]);
  });

  test("leaves every message other than a reasoning one as served", () => {
    const kept = keepReasoningSteps(snapshot);
    expect(kept.map(({ id }) => id)).toEqual(snapshot.map(({ id }) => id));
    expect(kept.filter(({ id }) => !reasoningIds.includes(id))).toEqual(
      snapshot.filter(({ id }) => !reasoningIds.includes(id)),
    );
  });

  test("keeps opaque redacted reasoning through interrupt snapshots", () => {
    const wire = uiMessagesToWire([
      {
        id: "redacted-answer",
        role: "assistant",
        parts: [
          {
            type: "thinking",
            content: "",
            signature: "opaque-provider-data",
            redacted: true,
          },
        ],
      },
    ]);
    const reasoning = wire.filter(({ role }) => role === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning.at(0)?.id).toStartWith("redacted_thinking-");

    const restored = keepReasoningSteps(wire);
    const parts = restored.flatMap((row) => ("parts" in row ? row.parts : []));
    expect(parts).toEqual([
      {
        type: "thinking",
        content: "",
        signature: "opaque-provider-data",
        redacted: true,
        stepId: reasoning.at(0)?.id,
      },
    ]);
  });
});
