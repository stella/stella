import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  expect,
  jest,
  setSystemTime,
  test,
} from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ChatTurnDuration } =
  await import("@/components/chat/chat-turn-duration");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;

const START = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  setSystemTime();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

test("ticks only the active server span and freezes while awaiting a user", async () => {
  jest.useFakeTimers();
  setSystemTime(new Date(START));
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ChatTurnDuration
          timing={{ status: "running", durationMs: 4000, startedAt: START }}
        />
      </FormattingProvider>
    </IntlProvider>,
  );
  expect(view.container.textContent).toBe("Worked for 4s");
  await act(async () => {
    setSystemTime(new Date("2026-01-01T00:00:01.000Z"));
    jest.advanceTimersByTime(1000);
  });
  expect(view.container.textContent).toBe("Worked for 6s");
  view.rerender(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ChatTurnDuration timing={{ status: "finished", durationMs: 6000 }} />
      </FormattingProvider>
    </IntlProvider>,
  );
  await act(async () => {
    setSystemTime(new Date("2026-01-01T01:00:00.000Z"));
    jest.advanceTimersByTime(1000);
  });
  expect(view.container.textContent).toBe("Worked for 6s");
  view.rerender(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <ChatTurnDuration
          timing={{
            status: "running",
            durationMs: 6000,
            startedAt: "2026-01-01T01:00:00.000Z",
          }}
        />
      </FormattingProvider>
    </IntlProvider>,
  );
  await act(async () => {
    setSystemTime(new Date("2026-01-01T01:00:02.000Z"));
    jest.advanceTimersByTime(1000);
  });
  expect(view.container.textContent).toBe("Worked for 9s");
});
