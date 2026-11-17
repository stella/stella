import type { ProfilerOnRenderCallback } from "react";

import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, expect, spyOn, test } from "bun:test";

import { unregisterDomEnvironment } from "@stll/property-testing/dom-environment";
import { createTestState } from "@stll/test-state";

import type { RenderStormMonitor } from "@/lib/render-storm-canary";

GlobalRegistrator.register({ url: "http://localhost:3000/" });
const testState = createTestState({
  file: import.meta.path,
  config: globalThis,
});
const { cleanup, render } = await import("@testing-library/react");
const { Profiler, useLayoutEffect, useState } = await import("react");
const monitorOwner = await import("@/lib/render-storm-canary");
const { RenderStormCanary, RenderStormRegion } =
  await import("./render-storm-canary");

afterEach(cleanup);
afterAll(unregisterDomEnvironment);

type RenderStormCommit = Parameters<RenderStormMonitor["onCommit"]>[0];

const NestedUpdate = ({ label }: { label: string }) => {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    setReady(true);
  }, []);
  return <span>{ready ? label : "Preparing"}</span>;
};

test("the React boundary forwards actual commit phase and time to one persistent monitor", () => {
  testState.setEnv("DEV", "true");
  testState.setConfig("__stellaRenderCommitCount", 17);
  const commits: RenderStormCommit[] = [];
  const expectedCommits: RenderStormCommit[] = [];
  const regions: string[] = [];
  const createMonitor = monitorOwner.createRenderStormMonitor;
  const factory = spyOn(
    monitorOwner,
    "createRenderStormMonitor",
  ).mockImplementation((emitStorm) => {
    const monitor = createMonitor(emitStorm);
    return {
      onCommit: (commit) => {
        commits.push(commit);
        monitor.onCommit(commit);
      },
      onRegionRender: (region) => {
        regions.push(region);
        monitor.onRegionRender(region);
      },
    };
  });
  const recordReactCommit: ProfilerOnRenderCallback = (...commit) => {
    expectedCommits.push({ phase: commit[1], commitTime: commit[5] });
  };
  const tree = (label: string) => (
    <Profiler id="reference" onRender={recordReactCommit}>
      <RenderStormCanary>
        <RenderStormRegion name="fixture-region">
          <NestedUpdate label={label} />
        </RenderStormRegion>
      </RenderStormCanary>
    </Profiler>
  );
  try {
    const ui = render(tree("First"));
    ui.rerender(tree("Second"));
    expect(ui.getByText("Second").textContent).toBe("Second");
    expect(expectedCommits.map(({ phase }) => phase)).toEqual([
      "mount",
      "nested-update",
      "update",
    ]);
    expect(commits).toEqual(expectedCommits);
    expect(regions).toEqual(expectedCommits.map(() => "fixture-region"));
    expect(globalThis.__stellaRenderCommitCount).toBe(
      17 + expectedCommits.length,
    );
    expect(factory).toHaveBeenCalledTimes(1);
  } finally {
    factory.mockRestore();
  }
});

test("the non-development boundary leaves children visible without profiling", () => {
  testState.deleteEnv("DEV");
  testState.setConfig("__stellaRenderCommitCount", 31);
  const label = "Visible";
  const factory = spyOn(monitorOwner, "createRenderStormMonitor");
  try {
    const ui = render(
      <RenderStormCanary>
        <RenderStormRegion name="unused-region">
          <span>{label}</span>
        </RenderStormRegion>
      </RenderStormCanary>,
    );
    expect(ui.getByText(label).textContent).toBe(label);
    expect(factory).not.toHaveBeenCalled();
    expect(globalThis.__stellaRenderCommitCount).toBe(31);
  } finally {
    factory.mockRestore();
  }
});
