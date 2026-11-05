import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/law/cz/statutes" });

const { cleanup, renderHook } = await import("@testing-library/react");
const { useReaderChatBinding } =
  await import("@/components/legal-reader/legal-reader-ai-chat");
const { useLegalDocumentChatThreads } =
  await import("@/features/chat/legal-document-chat-threads");
const { decisionChatKey } =
  await import("@/features/chat/legal-document-chat-key");

const DOCUMENT_KEY = decisionChatKey("decision-1");

afterEach(() => {
  cleanup();
  useLegalDocumentChatThreads.setState({ threadIdByDocumentKey: {} });
});

afterAll(async () => {
  await unregisterDomEnvironment();
});

const bindReader = () =>
  renderHook(
    ({ bound }: { bound: boolean }) =>
      useReaderChatBinding({ bound, documentKey: DOCUMENT_KEY }),
    { initialProps: { bound: false } },
  );

const boundThreadId = (binding: ReturnType<typeof useReaderChatBinding>) =>
  "chatThreadId" in binding ? binding.chatThreadId : null;

// A member's reader first renders signed out, so the seed lands in a render of
// a component already subscribed to the thread owner. That is the sequence a
// store write during render breaks on.
test("binding a mounted reader names its thread without writing during render", () => {
  const consoleError = spyOn(console, "error").mockImplementation(
    () => undefined,
  );
  try {
    const { rerender, result } = bindReader();
    expect(boundThreadId(result.current)).toBeNull();

    rerender({ bound: true });

    expect(
      consoleError.mock.calls.filter(([message]) =>
        String(message).includes("Cannot update a component"),
      ),
    ).toEqual([]);
    const threadId = boundThreadId(result.current);
    expect(threadId).not.toBeNull();
    expect(
      useLegalDocumentChatThreads.getState().threadIdByDocumentKey[
        DOCUMENT_KEY
      ],
    ).toBe(threadId);
  } finally {
    consoleError.mockRestore();
  }
});

test("a second reader on the document joins the first one's conversation", () => {
  const first = bindReader();
  first.rerender({ bound: true });
  const second = bindReader();
  second.rerender({ bound: true });

  expect(boundThreadId(second.result.current)).toBe(
    boundThreadId(first.result.current),
  );
});
