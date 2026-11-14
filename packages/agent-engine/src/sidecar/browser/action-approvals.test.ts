import { expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

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

/** The approval a stream step asks for, or "" when the step asks none. */
const requestIdOf = (step: IteratorResult<HarnessEvent>) =>
  step.done !== true && step.value.type === "approval.requested"
    ? step.value.request.requestId
    : "";

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
  const requestId = requestIdOf(asked);
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
  const requestId = requestIdOf(asked);
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
  const requestId = requestIdOf(asked);
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

test("a run that ends with a question open reports it withdrawn before the stream ends", async () => {
  const approvals = createActionApprovals();
  const harness = createEventQueue<HarnessEvent>();
  const stream = approvals.withEvents(harness.items)[Symbol.asyncIterator]();

  const decided = approvals.request(asking());
  const asked = await stream.next();
  const requestId = requestIdOf(asked);
  harness.close();
  expect((await stream.next()).value).toEqual({
    type: "interaction.resolved",
    requestId,
  });
  expect((await stream.next()).value).toMatchObject({
    type: "tool.completed",
    result: { content: JSON.stringify({ status: "declined" }) },
  });
  expect((await stream.next()).done).toBe(true);
  expect((await decided).decision).toBe(APPROVAL_DECISION.deny);
});

test("a long turn's events pass through in order", async () => {
  const approvals = createActionApprovals();
  const harness = createEventQueue<HarnessEvent>();
  const deltas = Array.from({ length: 2000 }, (_, index) => String(index));
  for (const delta of deltas) {
    harness.push({ type: "text.delta", messageId: "message-1", delta });
  }
  harness.close();
  const seen: string[] = [];
  for await (const event of approvals.withEvents(harness.items)) {
    if (event.type === "text.delta") {
      seen.push(event.delta);
    }
  }
  expect(seen).toEqual(deltas);
});

test("ends with the harness's failure after its events were read", async () => {
  const approvals = createActionApprovals();
  const failure = new Error("the harness stream broke");
  async function* failing(): AsyncGenerator<HarnessEvent> {
    yield { type: "text.delta", messageId: "message-1", delta: "kept" };
    await Promise.reject(failure);
  }
  const seen: string[] = [];
  const read = async () => {
    for await (const event of approvals.withEvents(failing())) {
      if (event.type === "text.delta") {
        seen.push(event.delta);
      }
    }
  };
  expect(await rejectionOf(read())).toBe(failure);
  expect(seen).toEqual(["kept"]);
});
