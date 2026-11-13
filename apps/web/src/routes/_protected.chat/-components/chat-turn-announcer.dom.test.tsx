import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ChatTurnAnnouncer } =
  await import("@/routes/_protected.chat/-components/chat-turn-announcer");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

type Outcome = NonNullable<
  NonNullable<ChatUIMessage["metadata"]>["turnOutcome"]
>;

const question = (id: string): ChatUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", content: "Check the lease." }],
});

const answer = (id: string, outcome?: Outcome): ChatUIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", content: "The lease ends in May." }],
  ...(outcome === undefined ? {} : { metadata: { turnOutcome: outcome } }),
});

const approval = (id: string, call = "first"): ChatUIMessage => ({
  id,
  role: "assistant",
  parts: [
    {
      type: "tool-call",
      id: `${id}-${call}`,
      name: "delete_document",
      arguments: "{}",
      state: "approval-requested",
    },
  ],
});

const DONE = { type: "completed" } as const;

const view = (thread: ChatUIMessage[], isGenerating = false) => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    <ChatTurnAnnouncer
      hasError={false}
      isGenerating={isGenerating}
      messages={thread}
    />
  </IntlProvider>
);

const liveRegion = (container: HTMLElement) => {
  const live = container.querySelector('[aria-live="polite"]');
  if (live === null) {
    throw new Error("The announcer rendered no live region");
  }
  return live;
};

const region = (container: HTMLElement) => liveRegion(container).textContent;

test("a thread that opens on a finished turn says nothing until its next turn ends", () => {
  const opened = [question("q1"), answer("a1", DONE)];
  const { container, rerender } = render(view(opened));
  expect(region(container)).toBe("");

  const asked = [...opened, question("q2")];
  rerender(view(asked, true));
  expect(region(container)).toBe("");

  rerender(view([...asked, answer("a2", DONE)]));
  expect(region(container)).toBe(messages.chat.turnStatus.answerReady);
});

test("a stopped turn and a failed one are each said once they end", () => {
  const { container, rerender } = render(view([question("q1")], true));
  rerender(
    view([
      question("q1"),
      answer("a1", { type: "cancelled", reason: "user-stop" }),
    ]),
  );
  expect(region(container)).toBe(messages.chat.stopped);

  rerender(view([question("q1"), answer("a1"), question("q2")], true));
  rerender(
    view([
      question("q1"),
      answer("a1"),
      question("q2"),
      answer("a2", { type: "interrupted", reason: "owner-lost" }),
    ]),
  );
  expect(region(container)).toBe(messages.chat.turnStatus.answerFailed);
});

test("a thread that opens on a pending approval is quiet, and the next approval is said", () => {
  const { container, rerender } = render(
    view([question("q1"), approval("a1")]),
  );
  expect(region(container)).toBe("");

  rerender(view([question("q1"), answer("a1")], true));
  expect(region(container)).toBe("");

  // The same answer asks again, for its next call, after the first approval.
  rerender(view([question("q1"), approval("a1", "second")], true));
  expect(region(container)).toBe(messages.chat.turnStatus.waitingForApproval);
});

test("an approval that follows another directly replaces the announced node", () => {
  const { container, rerender } = render(view([question("q1")], true));
  rerender(view([question("q1"), approval("a1")], true));
  const first = liveRegion(container).firstChild;
  expect(first?.textContent).toBe(messages.chat.turnStatus.waitingForApproval);

  // Same words, another call: only a new node tells a screen reader.
  rerender(view([question("q1"), approval("a1", "second")], true));
  const second = liveRegion(container).firstChild;
  expect(second?.textContent).toBe(messages.chat.turnStatus.waitingForApproval);
  expect(second).not.toBe(first);

  // A redraw about the same call leaves the node alone, so it is said once.
  rerender(view([question("q1"), approval("a1", "second")], true));
  expect(liveRegion(container).firstChild).toBe(second);
});
