import { panic } from "better-result";
import { expect, test } from "bun:test";

import { BROWSER_STEP_ASK_REASON } from "@stll/api-contract/browser-step-gate";
import {
  CHAT_LOCAL_RUN_TOOL_NAMES,
  parseChatLocalRunToolCall,
} from "@stll/api-contract/chat-local-run-tool";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createEventQueue } from "../../harness/event-queue";
import type { HarnessEvent } from "../../harness/events";
import { createActionApprovals } from "./action-approvals";
import { APPROVAL_DECISION, type BrowserApprovalRequest } from "./tools";

/** A question the gate would still ask whatever the run allows. */
const STILL_ASKS = {
  allowSite: null,
  allowedNow: () => false,
} as const satisfies Pick<BrowserApprovalRequest, "allowSite" | "allowedNow">;

const asking = (
  signal: AbortSignal = new AbortController().signal,
  site: string | null = null,
): BrowserApprovalRequest => ({
  action: "click",
  name: "Send",
  reason: site === null ? "no_site" : "site_not_allowed",
  role: "button",
  signal,
  site,
  url: "https://fixture-library.test/form",
  ...STILL_ASKS,
});

const LIBRARY = "https://fixture-library.test";
const ARCHIVE = "https://fixture-archive.test";

/**
 * A click on `site` asked because the run did not allow the website, held
 * to the run's `grants` as the gate holds it: an answer that always allows
 * the website adds it there, and the step runs once the set holds it.
 * `alsoHeld` stands for what holds a step back whatever the run allows (a
 * sign-in, a level that asks about every such step).
 */
const askingOn = (
  grants: Set<string>,
  site: string,
  name: string,
  alsoHeld = false,
): BrowserApprovalRequest => ({
  action: "click",
  name,
  reason: alsoHeld ? "possible_secret" : "site_not_allowed",
  role: "button",
  signal: new AbortController().signal,
  site,
  url: `${site}/form`,
  allowSite: () => {
    grants.add(site);
  },
  allowedNow: () => !alsoHeld && grants.has(site),
});

/** Reads the run's stream until `count` questions were asked; their ids by step name. */
const askedIds = async (
  stream: AsyncIterator<HarnessEvent>,
  count: number,
): Promise<Map<string, string>> => {
  const ids = new Map<string, string>();
  while (ids.size < count) {
    const step = await stream.next();
    if (step.done === true) {
      throw new Error("The stream ended before every question was asked");
    }
    if (step.value.type === "approval.requested") {
      const parsed = parseChatLocalRunToolCall(
        CHAT_LOCAL_RUN_TOOL_NAMES.browser,
        step.value.request.toolCall.input,
      );
      const input = parsed?.input;
      const name =
        input !== undefined && "asked" in input
          ? (input.asked?.name ?? "")
          : "";
      ids.set(name, step.value.request.requestId);
    }
  }
  return ids;
};

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

test("on a page that can hold a website approval, approving for the session always allows the website", async () => {
  const approvals = createActionApprovals();
  const harness = createEventQueue<HarnessEvent>();
  const stream = approvals.withEvents(harness.items)[Symbol.asyncIterator]();

  const decided = approvals.request(
    asking(undefined, "https://fixture-library.test"),
  );
  const asked = await stream.next();
  expect(asked.value).toMatchObject({
    type: "approval.requested",
    request: {
      options: [
        { decision: "approve" },
        { decision: "approve_for_session" },
        { decision: "deny" },
      ],
    },
  });
  expect(approvals.answer(requestIdOf(asked), "approve_for_session")).toBe(
    true,
  );
  expect((await decided).decision).toBe(APPROVAL_DECISION.approveSite);
  harness.close();
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

test("a key press and an option name the key and the option, and chat keeps the question", async () => {
  const signal = new AbortController().signal;
  const element = {
    name: "Court",
    reason: BROWSER_STEP_ASK_REASON.possibleSecret,
    role: "select",
    signal,
    site: null,
    url: "https://fixture-library.test/search",
    ...STILL_ASKS,
  };
  for (const { request, reason, asked } of [
    {
      request: { ...element, action: "press_key", key: "Enter" },
      reason:
        'Press Enter in the select "Court" on https://fixture-library.test/search',
      asked: { key: "Enter" },
    },
    {
      request: { ...element, action: "select", option: "Supreme Court" },
      reason:
        'Choose "Supreme Court" in the select "Court" on https://fixture-library.test/search',
      asked: { option: "Supreme Court" },
    },
  ] as const satisfies readonly {
    request: BrowserApprovalRequest;
    reason: string;
    asked: object;
  }[]) {
    const approvals = createActionApprovals();
    const harness = createEventQueue<HarnessEvent>();
    const stream = approvals.withEvents(harness.items)[Symbol.asyncIterator]();
    const decided = approvals.request(request);
    const next = await stream.next();
    const event = next.done === true ? undefined : next.value;
    if (event?.type !== "approval.requested") {
      throw new Error("Expected an approval request");
    }
    expect(event.request.reason).toBe(reason);
    const kept = {
      action: request.action,
      asked: {
        name: "Court",
        role: "select",
        url: "https://fixture-library.test/search",
        ...asked,
      },
      why: BROWSER_STEP_ASK_REASON.possibleSecret,
    };
    expect(event.request.toolCall.input).toEqual(kept);
    // What the desktop sends is what chat keeps.
    expect(
      parseChatLocalRunToolCall(
        CHAT_LOCAL_RUN_TOOL_NAMES.browser,
        event.request.toolCall.input,
      ),
    ).toEqual({ name: CHAT_LOCAL_RUN_TOOL_NAMES.browser, input: kept });
    approvals.declineAll();
    await decided;
    harness.close();
  }
});

test("opening a page names its address, and chat keeps it as the step's address", async () => {
  const approvals = createActionApprovals();
  const harness = createEventQueue<HarnessEvent>();
  const stream = approvals.withEvents(harness.items)[Symbol.asyncIterator]();
  const url = "https://fixture-library.test/search?q=notice";
  const decided = approvals.request({
    action: "open",
    reason: "site_not_allowed",
    signal: new AbortController().signal,
    site: "https://fixture-library.test",
    url,
    ...STILL_ASKS,
  });
  const next = await stream.next();
  const event = next.done === true ? undefined : next.value;
  if (event?.type !== "approval.requested") {
    throw new Error("Expected an approval request");
  }
  expect(event.request.reason).toBe(`Open ${url}`);
  expect(event.request.toolCall.input).toEqual({
    action: "open",
    url,
    why: "site_not_allowed",
  });
  expect(
    parseChatLocalRunToolCall(
      CHAT_LOCAL_RUN_TOOL_NAMES.browser,
      event.request.toolCall.input,
    ),
  ).toEqual({
    name: CHAT_LOCAL_RUN_TOOL_NAMES.browser,
    input: { action: "open", url, why: "site_not_allowed" },
  });
  // The website the answer may always allow is offered.
  expect(event.request.options.map(({ id }) => id)).toContain(
    APPROVAL_DECISION.approveSite,
  );
  approvals.declineAll();
  await decided;
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
  expect(approvals.asked(requestId)).toBe(true);
  call.abort();
  expect((await decided).decision).toBe(APPROVAL_DECISION.deny);
  expect(approvals.answer(requestId, "approve")).toBe(false);
  // Still one of these questions: a late answer to it reaches no harness.
  expect(approvals.asked(requestId)).toBe(true);
  expect(approvals.asked("call-of-the-harness")).toBe(false);
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

test("always allowing a website settles the other questions waiting on it, as approved", async () => {
  const approvals = createActionApprovals();
  const harness = createEventQueue<HarnessEvent>();
  const stream = approvals.withEvents(harness.items)[Symbol.asyncIterator]();
  const grants = new Set<string>();

  const first = approvals.request(askingOn(grants, LIBRARY, "Search"));
  const second = approvals.request(askingOn(grants, LIBRARY, "Next page"));
  const elsewhere = approvals.request(askingOn(grants, ARCHIVE, "Open file"));
  const held = approvals.request(askingOn(grants, LIBRARY, "Password", true));
  const ids = await askedIds(stream, 4);
  const id = (name: string) => ids.get(name) ?? panic(`no question ${name}`);

  expect(approvals.answer(id("Search"), "approve_for_session")).toBe(true);
  expect([...grants]).toEqual([LIBRARY]);
  const settled: string[] = [];
  approvals.settleAllowed((requestId) => {
    settled.push(requestId);
  });

  // The answered question and the other on the same website go on; the one
  // on another website and the one held back for another reason wait.
  expect(settled).toEqual([id("Next page")]);
  expect((await first).decision).toBe(APPROVAL_DECISION.approveSite);
  expect((await second).decision).toBe(APPROVAL_DECISION.approve);
  expect(approvals.answer(id("Next page"), "deny")).toBe(false);
  // Still waiting: an answer reaches each.
  expect(approvals.answer(id("Open file"), "deny")).toBe(true);
  expect(approvals.answer(id("Password"), "deny")).toBe(true);
  expect((await elsewhere).decision).toBe(APPROVAL_DECISION.deny);
  expect((await held).decision).toBe(APPROVAL_DECISION.deny);
  harness.close();
});

test("approving one step once leaves the website's other questions waiting", async () => {
  const approvals = createActionApprovals();
  const harness = createEventQueue<HarnessEvent>();
  const stream = approvals.withEvents(harness.items)[Symbol.asyncIterator]();
  const grants = new Set<string>();

  const first = approvals.request(askingOn(grants, LIBRARY, "Search"));
  const second = approvals.request(askingOn(grants, LIBRARY, "Next page"));
  const ids = await askedIds(stream, 2);

  expect(approvals.answer(ids.get("Search") ?? "", "approve")).toBe(true);
  approvals.settleAllowed(() => {
    panic("nothing the run allows changed");
  });
  expect(grants.size).toBe(0);
  expect((await first).decision).toBe(APPROVAL_DECISION.approve);
  expect(approvals.answer(ids.get("Next page") ?? "", "deny")).toBe(true);
  expect((await second).decision).toBe(APPROVAL_DECISION.deny);
  harness.close();
});

test("a website the run no longer allows settles no question", async () => {
  const approvals = createActionApprovals();
  const harness = createEventQueue<HarnessEvent>();
  const stream = approvals.withEvents(harness.items)[Symbol.asyncIterator]();
  const grants = new Set<string>([ARCHIVE]);

  const waiting = approvals.request(askingOn(grants, LIBRARY, "Search"));
  await askedIds(stream, 1);
  grants.delete(ARCHIVE);
  approvals.settleAllowed(() => {
    panic("a revoke answers nothing");
  });

  // The approval the member gives in chat later does.
  grants.add(LIBRARY);
  const settled: string[] = [];
  approvals.settleAllowed((requestId) => {
    settled.push(requestId);
  });
  expect(settled).toHaveLength(1);
  expect((await waiting).decision).toBe(APPROVAL_DECISION.approve);
  harness.close();
});
