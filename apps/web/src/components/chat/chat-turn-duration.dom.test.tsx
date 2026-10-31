import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, test } from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000" });
const { cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ChatTurnDuration } =
  await import("@/components/chat/chat-turn-duration");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;

afterEach(cleanup);
afterAll(async () => unregisterDomEnvironment());

const view = (timing: Parameters<typeof ChatTurnDuration>[0]["timing"]) => (
  <IntlProvider locale="en" messages={messages} timeZone="UTC">
    <FormattingProvider locale="en" timeZone="UTC">
      <ChatTurnDuration timing={timing} />
    </FormattingProvider>
  </IntlProvider>
);

test("shows a summary only after the turn ends", () => {
  const rendered = render(
    view({
      status: "running",
      durationMs: 4000,
      elapsedMs: 1000,
      startedAt: "2026-01-01T00:00:00.000Z",
      observedAt: "2026-01-01T00:00:01.000Z",
    }),
  );
  expect(rendered.container.textContent).toBe("");
  rendered.rerender(view({ status: "finished", durationMs: 5000 }));
  expect(rendered.container.textContent).toBe("Worked for 5s");
});
