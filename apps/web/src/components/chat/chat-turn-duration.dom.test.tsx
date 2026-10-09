import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  expect,
  jest,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { act, cleanup, render } = await import("@testing-library/react");
const { IntlProvider } = await import("use-intl");
const { ChatTurnDuration } =
  await import("@/components/chat/chat-turn-duration");
const { createChatTurnTimingObserver } =
  await import("@stll/api-contract/chat-turn-duration");
const { FormattingProvider } = await import("@/i18n/formatting-context");
const messages = (await import("@/i18n/langs/en.json")).default;

const START = "2026-01-01T00:00:00.000Z";

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
  setSystemTime();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

for (const skewMs of [-3_600_000, 0, 3_600_000]) {
  test(`ticks with client wall-clock skew ${String(skewMs)} and freezes after reload`, async () => {
    jest.useFakeTimers();
    const wallStart = Date.parse(START) + skewMs;
    setSystemTime(new Date(wallStart));
    let monotonicNow = 100;
    const clock = spyOn(performance, "now").mockImplementation(
      () => monotonicNow,
    );
    const observe = createChatTurnTimingObserver();
    const running = {
      status: "running",
      durationMs: 4000,
      elapsedMs: 1000,
      startedAt: START,
      observedAt: "2026-01-01T00:00:01.000Z",
    } as const;
    const message = {
      id: "duration",
      role: "assistant",
      parts: [],
      metadata: { turnTiming: running },
    } as const;
    observe([{ ...message, parts: [] }], monotonicNow);
    const label = (
      timing: Parameters<typeof ChatTurnDuration>[0]["timing"],
    ) => (
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <FormattingProvider locale="en" timeZone="UTC">
          <ChatTurnDuration timing={timing} />
        </FormattingProvider>
      </IntlProvider>
    );
    const view = render(label(running));
    expect(view.container.textContent).toBe("Worked for 5s");
    await act(async () => {
      monotonicNow += 1000;
      setSystemTime(new Date(wallStart + 1000));
      jest.advanceTimersByTime(1000);
    });
    expect(view.container.textContent).toBe("Worked for 6s");
    // A label remount keeps advancing from receipt, not from its mount.
    view.unmount();
    monotonicNow += 1000;
    const remounted = render(label(running));
    expect(remounted.container.textContent).toBe("Worked for 7s");
    remounted.rerender(label({ status: "finished", durationMs: 7000 }));
    await act(async () => {
      monotonicNow += 1000;
      setSystemTime(new Date(wallStart - 3_600_000));
      jest.advanceTimersByTime(1000);
    });
    expect(remounted.container.textContent).toBe("Worked for 7s");
    // A fresh running server observation starts the resumed active segment.
    const resumed = {
      ...running,
      durationMs: 7000,
      elapsedMs: 0,
      startedAt: "2026-01-01T01:00:00.000Z",
      observedAt: "2026-01-01T01:00:00.000Z",
    };
    observe(
      [{ ...message, parts: [], metadata: { turnTiming: resumed } }],
      monotonicNow,
    );
    remounted.rerender(label(resumed));
    await act(async () => {
      monotonicNow += 1000;
      jest.advanceTimersByTime(1000);
    });
    expect(remounted.container.textContent).toBe("Worked for 8s");
    clock.mockRestore();
  });
}
