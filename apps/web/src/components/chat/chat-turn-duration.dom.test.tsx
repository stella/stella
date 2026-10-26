import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  afterAll,
  afterEach,
  expect,
  jest,
  mock,
  setSystemTime,
  spyOn,
  test,
} from "bun:test";

import { unregisterDomEnvironment } from "@/test-dom-environment";

// Spies created in a test stay attached if it fails before restoring them.
afterEach(() => {
  mock.restore();
});

GlobalRegistrator.register({ url: "http://localhost:3000" });

const { act, cleanup, render } = await import("@testing-library/react");
const { Profiler } = await import("react");
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
  await unregisterDomEnvironment();
});

test("keeps the duration label in the first render of a new reading", () => {
  let monotonicNow = 100;
  spyOn(performance, "now").mockImplementation(() => monotonicNow);
  const observe = createChatTurnTimingObserver();
  const running = {
    status: "running",
    durationMs: 4000,
    elapsedMs: 1000,
    startedAt: START,
    observedAt: "2026-01-01T00:00:01.000Z",
  } as const;
  const message = { id: "duration", metadata: { turnTiming: running } };
  observe([message], monotonicNow);
  const container = document.createElement("div");
  const renderedLabels: (string | null)[] = [];
  const label = (timing: Parameters<typeof ChatTurnDuration>[0]["timing"]) => (
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <Profiler
          id="duration"
          onRender={() => {
            renderedLabels.push(container.textContent);
          }}
        >
          <ChatTurnDuration timing={timing} />
        </Profiler>
      </FormattingProvider>
    </IntlProvider>
  );
  const view = render(label(running), { container });
  expect(container.textContent).toBe("Worked for 5s");
  monotonicNow = 2100;
  const fresh = {
    ...running,
    elapsedMs: 3000,
    observedAt: "2026-01-01T00:00:03.000Z",
  };
  observe([{ ...message, metadata: { turnTiming: fresh } }], monotonicNow);
  renderedLabels.length = 0;
  view.rerender(label(fresh));
  expect(renderedLabels.length).toBeGreaterThan(0);
  expect(renderedLabels.at(0)).toBe("Worked for 7s");
  expect(renderedLabels).not.toContain("");
});

test("omits an unobserved running duration without crashing its surface", () => {
  const running = {
    status: "running",
    durationMs: 4000,
    elapsedMs: 1000,
    startedAt: START,
    observedAt: "2026-01-01T00:00:01.000Z",
  } as const;
  createChatTurnTimingObserver()(
    [{ id: "duration", metadata: { turnTiming: running } }],
    performance.now(),
  );
  const view = render(
    <IntlProvider locale="en" messages={messages} timeZone="UTC">
      <FormattingProvider locale="en" timeZone="UTC">
        <span>{messages.chat.sendPrompt}</span>
        <ChatTurnDuration timing={{ ...running }} />
      </FormattingProvider>
    </IntlProvider>,
  );
  expect(view.container.textContent).toBe(messages.chat.sendPrompt);
  expect(view.container.querySelector("[data-chat-turn-duration]")).toBeNull();
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
      metadata: { turnTiming: running },
    } as const;
    observe([message], monotonicNow);
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
    observe([{ ...message, metadata: { turnTiming: resumed } }], monotonicNow);
    remounted.rerender(label(resumed));
    await act(async () => {
      monotonicNow += 1000;
      jest.advanceTimersByTime(1000);
    });
    expect(remounted.container.textContent).toBe("Worked for 8s");
    clock.mockRestore();
  });
}
