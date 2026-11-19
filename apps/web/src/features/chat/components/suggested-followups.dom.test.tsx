import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, mock, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

import csMessages from "@/i18n/langs/cs.json";
import messages from "@/i18n/langs/en.json";
import { noopAnalytics } from "@/lib/analytics/noop";

GlobalRegistrator.register({ url: "https://app.example.test/chat" });
const { cleanup, fireEvent, render, waitFor } =
  await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { AnalyticsContext } = await import("@/lib/analytics/provider");
const { toChatThreadId } = await import("@/lib/chat-thread-ref");
const { SuggestedFollowups } = await import("./suggested-followups");

afterEach(cleanup);
afterAll(async () => unregisterDomEnvironment());

const payloadKeys = (payload: unknown): string[] =>
  typeof payload === "object" && payload !== null
    ? Object.keys(payload).toSorted()
    : [];

test("reports each shown set once and the chosen row without prompt text", async () => {
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
  const onSelect = mock((_prompt: string) => undefined);
  const secondPrompt = "Second private prompt";
  const prompts = ["First private prompt", secondPrompt];
  const renderRows = (nextPrompts: string[]) => (
    <AnalyticsContext.Provider value={analytics}>
      <IntlProvider locale="en" messages={messages}>
        <SuggestedFollowups
          analyticsSurface="chat-thread"
          messageId="message-1"
          onSelect={onSelect}
          prompts={nextPrompts}
          threadId={toChatThreadId("thread-followups")}
        />
      </IntlProvider>
    </AnalyticsContext.Provider>
  );

  const view = render(renderRows(prompts));
  await waitFor(() => expect(captureFollowupShown).toHaveBeenCalledTimes(1));
  view.rerender(renderRows(prompts));
  await Promise.resolve();
  expect(captureFollowupShown).toHaveBeenCalledTimes(1);

  fireEvent.click(view.getByRole("button", { name: secondPrompt }));
  expect(onSelect).toHaveBeenCalledWith(secondPrompt);
  expect(captureFollowupSelected).toHaveBeenCalledWith({
    index: 1,
    source: "generated",
    surface: "chat-thread",
    via: "row",
  });
  // Exactly these fields: no thread, document or prompt identifies the
  // conversation a suggestion came from.
  expect(captured.map(payloadKeys)).toEqual([
    ["count", "source", "surface"],
    ["index", "source", "surface", "via"],
  ]);
  expect(JSON.stringify(captured)).not.toContain("private prompt");
});

test("shows at most three wrapping rows under a named heading", () => {
  const prompts = ["One", "Two", "Three", "Four"];
  const view = render(
    <AnalyticsContext.Provider value={noopAnalytics}>
      <IntlProvider locale="cs" messages={csMessages}>
        <SuggestedFollowups
          analyticsSurface="chat-thread"
          messageId="message-1"
          onSelect={() => undefined}
          prompts={prompts}
          threadId={toChatThreadId("thread-rows")}
        />
      </IntlProvider>
    </AnalyticsContext.Provider>,
  );
  const section = view.getByRole("region", {
    name: csMessages.chat.nextSteps,
  });
  expect(section.textContent).toContain("Další kroky");
  const rows = view.getAllByRole("button");
  expect(rows.map((row) => row.textContent)).toEqual(["One", "Two", "Three"]);
  for (const row of rows) {
    // A row wraps like text: nothing in the list scrolls sideways.
    expect(row.className).toContain("whitespace-normal");
    expect(row.closest(".overflow-x-auto") === null).toBe(true);
  }
});

test("draws nothing without suggestions", () => {
  const view = render(
    <AnalyticsContext.Provider value={noopAnalytics}>
      <IntlProvider locale="en" messages={messages}>
        <SuggestedFollowups
          analyticsSurface="chat-thread"
          messageId="message-1"
          onSelect={() => undefined}
          prompts={[]}
          threadId={toChatThreadId("thread-empty")}
        />
      </IntlProvider>
    </AnalyticsContext.Provider>,
  );
  expect(view.container.innerHTML).toBe("");
});
