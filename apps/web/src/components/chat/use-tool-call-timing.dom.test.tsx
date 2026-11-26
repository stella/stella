import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";

GlobalRegistrator.register({ url: "http://localhost:3000/chat" });

const { Profiler } = await import("react");
const { cleanup, render } = await import("@testing-library/react");
const { useToolCallTiming } =
  await import("@/components/chat/use-tool-call-timing");

afterEach(() => {
  cleanup();
  setSystemTime();
});
afterAll(async () => {
  await unregisterDomEnvironment();
});

type Props = { durationMs: number | undefined; isRunning: boolean };

const renderTiming = (initial: Props) => {
  const seen: unknown[] = [];
  let commits = 0;
  const Probe = (props: Props) => {
    seen.push(useToolCallTiming(props));
    return null;
  };
  const view = render(
    <Profiler
      id="timing"
      onRender={() => {
        commits += 1;
      }}
    >
      <Probe {...initial} />
    </Profiler>,
  );
  return {
    commits: () => commits,
    latest: () => seen.at(-1),
    rerender: (next: Props) => {
      view.rerender(
        <Profiler
          id="timing"
          onRender={() => {
            commits += 1;
          }}
        >
          <Probe {...next} />
        </Profiler>,
      );
    },
  };
};

test("a step that finishes keeps the time it was seen running, in the commit that finishes it", () => {
  setSystemTime(new Date(1000));
  const timing = renderTiming({ durationMs: undefined, isRunning: true });
  expect(timing.latest()).toEqual({ status: "running", startedAt: 1000 });

  setSystemTime(new Date(3450));
  const commitsBefore = timing.commits();
  timing.rerender({ durationMs: undefined, isRunning: false });

  expect(timing.latest()).toEqual({ status: "finished", durationMs: 2450 });
  expect(timing.commits()).toBe(commitsBefore + 1);
});

test("a reported duration wins over the observed one", () => {
  setSystemTime(new Date(1000));
  const timing = renderTiming({ durationMs: undefined, isRunning: true });
  setSystemTime(new Date(9000));
  timing.rerender({ durationMs: 1200, isRunning: false });

  expect(timing.latest()).toEqual({ status: "finished", durationMs: 1200 });
});

test("a step that renders settled has no observed duration", () => {
  const timing = renderTiming({ durationMs: undefined, isRunning: false });
  timing.rerender({ durationMs: undefined, isRunning: false });

  expect(timing.latest()).toEqual({
    status: "finished",
    durationMs: undefined,
  });
});
