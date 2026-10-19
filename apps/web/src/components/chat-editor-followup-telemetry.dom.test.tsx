import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { noopAnalytics } from "@/lib/analytics/noop";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test/chat" });
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { ChatEditorProvider, useChatEditor } =
  await import("./chat-editor-provider");
const { PromptEditorContent } = await import("./prompt-editor");

afterEach(cleanup);
afterAll(async () => unregisterDomEnvironment());

const payloadKeys = (payload: unknown): string[] =>
  typeof payload === "object" && payload !== null
    ? Object.keys(payload).toSorted()
    : [];

test("Tab accepts the ghost follow-up and reports only its position", async () => {
  const payloads: unknown[] = [];
  const captureFollowupSelected = mock((payload: unknown) =>
    payloads.push(payload),
  );
  const analytics = { ...noopAnalytics, captureFollowupSelected };
  const threadId = toChatThreadId("thread-ghost-followup");
  const suggestion = "Private suggested question";
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const Composer = () => {
    const controller = useChatEditor({
      followupAnalytics: { surface: "inspector-chat" },
      suggestedFollowupPrompt: suggestion,
      threadRef: { scope: "global", threadId },
    });
    return <PromptEditorContent editor={controller.editor} />;
  };
  const view = render(
    <AnalyticsContext.Provider value={analytics}>
      <QueryClientProvider client={client}>
        <IntlProvider locale="en" messages={messages}>
          <ChatThreadTestRouter>
            <ChatEditorProvider>
              <Composer />
            </ChatEditorProvider>
          </ChatThreadTestRouter>
        </IntlProvider>
      </QueryClientProvider>
    </AnalyticsContext.Provider>,
  );
  const textbox = await waitFor(() => view.getByRole("textbox"));

  fireEvent.keyDown(textbox, { key: "Tab" });

  await waitFor(() => expect(textbox.textContent).toBe(suggestion));
  expect(captureFollowupSelected).toHaveBeenCalledWith({
    index: 0,
    source: "generated",
    surface: "inspector-chat",
    via: "ghost-tab",
  });
  expect(payloads.map(payloadKeys)).toEqual([
    ["index", "source", "surface", "via"],
  ]);
  expect(JSON.stringify(payloads)).not.toContain(suggestion);
  client.clear();
});
