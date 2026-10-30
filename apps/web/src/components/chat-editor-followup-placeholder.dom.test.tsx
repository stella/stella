import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test" });
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { QueryClient, QueryClientProvider } =
  await import("@tanstack/react-query");
const { IntlProvider } = await import("use-intl");
const { ChatThreadTestRouter } = await import("@/lib/chat-thread-test-router");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { ChatEditorProvider, useChatEditor } =
  await import("./chat-editor-provider");
const { PromptEditorContent } = await import("./prompt-editor");

const threadRef = {
  scope: "global",
  threadId: toChatThreadId("followup-placeholder"),
} as const;

afterEach(cleanup);
afterAll(async () => {
  await unregisterDomEnvironment();
});

const ComposerHarness = ({
  suggestedFollowupPrompt,
}: {
  suggestedFollowupPrompt?: string | undefined;
}) => {
  const controller = useChatEditor({ suggestedFollowupPrompt, threadRef });
  return <PromptEditorContent editor={controller.editor} />;
};

test("repaints and accepts a follow-up suggestion that arrives after mount", async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const renderComposer = (suggestedFollowupPrompt?: string) => (
    <QueryClientProvider client={client}>
      <IntlProvider locale="en" messages={messages}>
        <ChatThreadTestRouter>
          <ChatEditorProvider>
            <ComposerHarness
              suggestedFollowupPrompt={suggestedFollowupPrompt}
            />
          </ChatEditorProvider>
        </ChatThreadTestRouter>
      </IntlProvider>
    </QueryClientProvider>
  );
  const ui = render(renderComposer());
  const textbox = await ui.findByRole("textbox");
  const paragraph = textbox.querySelector("p");
  expect(paragraph?.dataset["placeholder"]).toBe(messages.chat.placeholder);

  const prompt = "Which court decided the appeal?";
  ui.rerender(renderComposer(prompt));
  const expectedPlaceholder = messages.chat.tabToAsk.replace(
    "{prompt}",
    () => `\u2068${prompt}\u2069`,
  );
  await waitFor(() =>
    expect(paragraph?.dataset["placeholder"]).toBe(expectedPlaceholder),
  );

  fireEvent.keyDown(textbox, { key: "Tab" });
  expect(textbox.textContent).toBe(prompt);
  expect(document.activeElement).not.toBe(textbox);
  client.clear();
});
