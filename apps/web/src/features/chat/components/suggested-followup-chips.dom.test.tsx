import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import messages from "@/i18n/langs/en.json";
import { noopAnalytics } from "@/lib/analytics/noop";
import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "https://app.example.test/chat" });
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { SuggestedFollowupChips } = await import("./suggested-followup-chips");

afterEach(cleanup);
afterAll(async () => unregisterDomEnvironment());

test("reports each shown set once and the selected chip without prompt text", async () => {
  const captured: unknown[] = [];
  const captureFollowupShown = mock((payload: unknown) =>
    captured.push(payload),
  );
  const captureFollowupSelected = mock((payload: unknown) =>
    captured.push(payload),
  );
  const analytics = {
    ...noopAnalytics,
    captureFollowupSelected,
    captureFollowupShown,
  };
  const threadId = toChatThreadId("thread-followups");
  const secondPrompt = "Second private prompt";
  const prompts = ["First private prompt", secondPrompt];
  const renderChips = (nextPrompts: string[]) => (
    <AnalyticsContext.Provider value={analytics}>
      <IntlProvider locale="en" messages={messages}>
        <SuggestedFollowupChips
          analyticsSurface="chat-thread"
          messageId="message-1"
          onSelect={() => undefined}
          prompts={nextPrompts}
          threadId={threadId}
        />
      </IntlProvider>
    </AnalyticsContext.Provider>
  );

  const view = render(renderChips(prompts));
  await waitFor(() => expect(captureFollowupShown).toHaveBeenCalledTimes(1));
  view.rerender(renderChips(prompts));
  await Promise.resolve();
  expect(captureFollowupShown).toHaveBeenCalledTimes(1);

  fireEvent.click(view.getByRole("button", { name: secondPrompt }));
  expect(captureFollowupSelected).toHaveBeenCalledWith({
    index: 1,
    source: "generated",
    surface: "chat-thread",
    threadId,
    via: "chip",
  });
  expect(JSON.stringify(captured)).not.toContain("private prompt");
});
