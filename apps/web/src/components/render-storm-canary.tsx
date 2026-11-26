import { createContext, Profiler, use, useCallback, useState } from "react";
import type {
  ProfilerOnRenderCallback,
  PropsWithChildren,
  ReactNode,
} from "react";

import { emitDevCanaryError } from "@/lib/dev-canary";
import type {
  RenderStormDetails,
  RenderStormMonitor,
  RenderStormPhase,
} from "@/lib/render-storm-canary";
import {
  createRenderStormMonitor,
  isUnderStormWatch,
  RENDER_STORM_CANARY_TAG,
} from "@/lib/render-storm-canary";

const RENDER_STORM_CANARY_PROFILER_ID = "render-storm-canary";

const RENDER_STORM_REPORTED_REGIONS = 5;

/**
 * Dev-only render-loop detector. Wraps the app root in a React `<Profiler>`
 * that counts commits per second; a sustained storm (see the lib module
 * "render-storm-canary" under apps/web/src/lib for thresholds and
 * calibration) emits a single `console.error` for whoever has the dev
 * console open. Damped near-loops (hundreds of re-renders/sec that never
 * trip React's own "Maximum update depth exceeded" throw) ship silently
 * without a detector. In e2e runs the storm watch
 * (apps/web/e2e/helpers/storm-watch.ts) is that detector instead, and the
 * canary stays silent there; it still counts commits for budget specs.
 *
 * `import.meta.env.DEV` is statically replaced at build time, so the
 * unreachable branch below (and everything it alone references —
 * RenderStormProfiler, the monitor, the emitter) is dead-code-eliminated
 * from production bundles.
 */
export const RenderStormCanary = ({
  children,
}: PropsWithChildren): ReactNode => {
  if (!import.meta.env.DEV) {
    return children;
  }

  return <RenderStormProfiler>{children}</RenderStormProfiler>;
};

/**
 * Attribute this subtree's commits to a named region in the canary's storm
 * report. Without regions a storm report says only "~N commits/sec
 * somewhere"; with them it names the surface to open first. Free outside
 * dev and when no root canary is mounted (children pass through
 * untouched), so it is safe to wrap any hot surface: the chat thread page,
 * the composer, the inspector, the search dialog.
 *
 * Keep `name` a short stable kebab-case surface id — it is grep bait for
 * the engineer reading the storm report.
 */
export const RenderStormRegion = ({
  name,
  children,
}: PropsWithChildren<{ name: string }>): ReactNode => {
  const monitor = use(RenderStormMonitorContext);
  if (monitor === null) {
    return children;
  }

  return (
    <RegionProfiler monitor={monitor} name={name}>
      {children}
    </RegionProfiler>
  );
};

const RegionProfiler = ({
  monitor,
  name,
  children,
}: PropsWithChildren<{ monitor: RenderStormMonitor; name: string }>) => {
  const onRender = useCallback(() => {
    monitor.onRegionRender(name);
  }, [monitor, name]);

  return (
    <Profiler id={name} onRender={onRender}>
      {children}
    </Profiler>
  );
};

const RenderStormMonitorContext = createContext<RenderStormMonitor | null>(
  null,
);

const formatPhaseBreakdown = (
  phaseCounts: Record<RenderStormPhase, number>,
): string => {
  const parts: string[] = [];
  for (const [phase, count] of Object.entries(phaseCounts)) {
    if (count > 0) {
      parts.push(`${phase}=${count}`);
    }
  }
  return parts.join(", ");
};

const formatRegionBreakdown = (
  regionCounts: RenderStormDetails["regionCounts"],
): string => {
  if (regionCounts.length === 0) {
    return "none attributed — wrap the suspect surface in <RenderStormRegion>";
  }
  return regionCounts
    .slice(0, RENDER_STORM_REPORTED_REGIONS)
    .map(([region, commits]) => `${region}=${commits}`)
    .join(", ");
};

const emitRenderStormError = (details: RenderStormDetails) => {
  // In e2e runs the storm watch judges each commit by its cause and fails the
  // test itself; a rate would also flag input a test drives faster than a
  // person (menus opened back to back).
  if (isUnderStormWatch()) {
    return;
  }
  emitDevCanaryError(
    RENDER_STORM_CANARY_TAG,
    `sustained render storm detected: ~${details.commitsPerSecond} commits/sec ` +
      `(phases: ${formatPhaseBreakdown(details.phaseCounts)}; ` +
      `regions: ${formatRegionBreakdown(details.regionCounts)}). A component is re-rendering ` +
      "far above legitimate streaming rates (~20/s) without tripping React's own " +
      '"Maximum update depth exceeded" guard. Find the state update that re-triggers ' +
      "itself and break the loop.",
  );
};

/** Counts one commit of the app where an e2e spec can read it. */
const countCommit = () => {
  const counted = globalThis.__stellaRenderCommitCount;
  globalThis.__stellaRenderCommitCount = (counted ?? 0) + 1;
};

const RenderStormProfiler = ({ children }: PropsWithChildren) => {
  const [{ monitor, onRender }] = useState(() => {
    const created = createRenderStormMonitor(emitRenderStormError);
    const handleRender: ProfilerOnRenderCallback = (...commit) => {
      countCommit();
      created.onCommit({ phase: commit[1], commitTime: commit[5] });
    };
    return { monitor: created, onRender: handleRender };
  });

  return (
    <RenderStormMonitorContext value={monitor}>
      <Profiler id={RENDER_STORM_CANARY_PROFILER_ID} onRender={onRender}>
        {children}
      </Profiler>
    </RenderStormMonitorContext>
  );
};
