import { expect, test } from "bun:test";

import { createEventQueue } from "../../harness/event-queue";
import type { HarnessEvent } from "../../harness/events";
import { createActionApprovals } from "./action-approvals";
import { APPROVAL_DECISION, type BrowserApprovalRequest } from "./tools";

const asking = (
  signal: AbortSignal = new AbortController().signal,
): BrowserApprovalRequest => ({
  action: "click",
  name: "Send",
  role: "button",
  signal,
  url: "https://fixture-library.test/form",
});

test("asks in the run's stream and reports the step once it ran", async () => {
  const approvals = createActionApprovals();
  const harness = createEventQueue<HarnessEvent>();
  const stream = approvals.withEvents(harness.items)[Symbol.asyncIterator]();

  const decided = approvals.request(asking());
  const asked = await stream.next();
  expect(asked.value).toMatchObject({
    type: "approval.requested",
    request: {
      kind: "tool",
      reason: 'Click the button "Send" on https://fixture-library.test/form',
      toolCall: { name: "local_browser", input: { action: "click" } },
      options: [{ decision: "approve" }, { decision: "deny" }],
    },
  });
  const requestId =
    asked.value?.type === "approval.requested"
      ? asked.value.request.requestId
      : "";
  expect(approvals.answer("another-request", "deny")).toBe(false);
  expect(approvals.answer(requestId, "approve_for_session")).toBe(true);
  const ticket = await decided;
  expect(ticket.decision).toBe(APPROVAL_DECISION.approve);
  expect((await stream.next()).value).toEqual({
    type: "interaction.resolved",
    requestId,
  });

  ticket.finish("failed");
  ticket.finish("completed");
  expect((await stream.next()).value).toMatchObject({
    type: "tool.completed",
    result: { content: JSON.stringify({ status: "failed" }), status: "failed" },
  });

  harness.push({ type: "turn.interrupted" });
  harness.close();
  expect((await stream.next()).value).toEqual({ type: "turn.interrupted" });
  expect((await stream.next()).done).toBe(true);
});

test("a denied step is reported declined at once", async () => {
  const approvals = createActionApprovals();
  const harness = createEventQueue<HarnessEvent>();
  const stream = approvals.withEvents(harness.items)[Symbol.asyncIterator]();

  const decided = approvals.request(asking());
  const asked = await stream.next();
  const requestId =
    asked.value?.type === "approval.requested"
      ? asked.value.request.requestId
      : "";
  approvals.answer(requestId, "deny");
  expect((await decided).decision).toBe(APPROVAL_DECISION.deny);
  await stream.next();
  expect((await stream.next()).value).toMatchObject({
    type: "tool.completed",
    result: { content: JSON.stringify({ status: "declined" }) },
  });
  harness.close();
});

test("the question is withdrawn when the agent's call ends", async () => {
  const approvals = createActionApprovals();
  const harness = createEventQueue<HarnessEvent>();
  const stream = approvals.withEvents(harness.items)[Symbol.asyncIterator]();
  const call = new AbortController();

  const decided = approvals.request(asking(call.signal));
  const asked = await stream.next();
  const requestId =
    asked.value?.type === "approval.requested"
      ? asked.value.request.requestId
      : "";
  call.abort();
  expect((await decided).decision).toBe(APPROVAL_DECISION.deny);
  expect(approvals.answer(requestId, "approve")).toBe(false);
  await stream.next();
  expect((await stream.next()).value).toMatchObject({
    type: "tool.completed",
    result: { content: JSON.stringify({ status: "interrupted" }) },
  });
  harness.close();
});

test("a question still open when the run ends is declined", async () => {
  const approvals = createActionApprovals();
  const decided = approvals.request(asking());
  approvals.declineAll();
  expect((await decided).decision).toBe(APPROVAL_DECISION.deny);
});
