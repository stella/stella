import { expect, test } from "bun:test";

import { createEventQueue } from "../../harness/event-queue";
import type { HarnessEvent } from "../../harness/events";
import { TYPING_DECISION } from "./tools";
import { createTypingApprovals } from "./typing-approvals";

const harnessEvents = () => {
  const queue = createEventQueue<HarnessEvent>();
  return queue;
};

test("asks in the run's stream and answers with the member's decision", async () => {
  const typing = createTypingApprovals();
  const harness = harnessEvents();
  const stream = typing.withEvents(harness.items)[Symbol.asyncIterator]();

  const decided = typing.request({ url: "https://fixture-library.test/form" });
  const asked = await stream.next();
  expect(asked.value).toMatchObject({
    type: "approval.requested",
    request: {
      kind: "tool",
      toolCall: {
        name: "local_browser",
        input: { action: "type", url: "https://fixture-library.test/form" },
      },
      options: [{ decision: "approve" }, { decision: "deny" }],
    },
  });
  const requestId =
    asked.value?.type === "approval.requested"
      ? asked.value.request.requestId
      : "";
  expect(typing.answer("another-request", "deny")).toBe(false);
  expect(typing.answer(requestId, "approve_for_session")).toBe(true);
  expect(await decided).toBe(TYPING_DECISION.approve);
  expect((await stream.next()).value).toEqual({
    type: "interaction.resolved",
    requestId,
  });
  expect((await stream.next()).value).toMatchObject({
    type: "tool.completed",
    result: { content: JSON.stringify({ status: "completed" }) },
  });

  harness.push({ type: "turn.interrupted" });
  harness.close();
  expect((await stream.next()).value).toEqual({ type: "turn.interrupted" });
  expect((await stream.next()).done).toBe(true);
});

test("a question still open when the run ends is declined", async () => {
  const typing = createTypingApprovals();
  const decided = typing.request({ url: "https://fixture-library.test/form" });
  typing.declineAll();
  expect(await decided).toBe(TYPING_DECISION.deny);
});
