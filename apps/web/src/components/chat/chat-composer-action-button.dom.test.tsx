import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { act, useSyncExternalStore } = await import("react");
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ChatComposerActionButton } =
  await import("./chat-composer-action-button");
const { isChatTurnGenerating } = await import("./chat-user-actions");
const { isChatClientRequestActive } = await import("./chat-ui-tools");
const { createChatRuntime } = await import("@/features/chat/chat-runtime");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { toSafeId } = await import("@/lib/safe-id");

const previousFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = previousFetch;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("a reattached Stop becomes disabled Send on the same element when its delayed probe finds a settled turn", async () => {
  const probe = Promise.withResolvers<Response>();
  globalThis.fetch = Object.assign(async () => await probe.promise, {
    preconnect: () => undefined,
  });
  const errors: Error[] = [];
  let reloads = 0;
  const runtime = createChatRuntime({
    activeTurnId: toSafeId<"chatTurn">("018f0000-0000-7000-8000-00000000000a"),
    context: undefined,
    initialMessages: [],
    key: { scope: "global", threadId: toChatThreadId("observer-settled") },
    onError: (error) => {
      errors.push(error);
    },
    onFinish: () => undefined,
    reloadThread: () => {
      reloads += 1;
    },
  });
  const Viewer = () => {
    const snapshot = useSyncExternalStore(
      runtime.subscribe,
      runtime.getSnapshot,
      runtime.getSnapshot,
    );
    return (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ChatComposerActionButton
          canSend={false}
          isGenerating={isChatTurnGenerating({
            hasError: snapshot.error !== undefined,
            messages: snapshot.messages,
            requestActive:
              snapshot.reconnecting ||
              isChatClientRequestActive(snapshot.status),
            sessionGenerating: snapshot.sessionGenerating,
            stopStatus: snapshot.stop.status,
          })}
          onSend={() => undefined}
          onStop={runtime.stop}
        />
      </IntlProvider>
    );
  };
  const ui = render(<Viewer />);
  const stop = ui.getByRole("button", { name: messages.chat.stopResponse });
  expect(stop.matches(":disabled")).toBe(false);
  await act(async () => {
    probe.resolve(
      Response.json({ type: "transcript", turnId: "settled-turn" }),
    );
  });
  expect(
    ui.queryByRole("button", { name: messages.chat.stopResponse }),
  ).toBeNull();
  expect(ui.getByRole("button", { name: messages.chat.sendPrompt })).toBe(stop);
  expect(stop.matches(":disabled")).toBe(true);
  expect(reloads).toBe(1);
  expect(errors).toEqual([]);
});
