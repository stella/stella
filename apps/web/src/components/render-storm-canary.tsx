import { createContext, Profiler, use, useCallback, useState } from "react";
import type { PropsWithChildren, ReactNode } from "react";

import type {
  RenderStormDetails,
  RenderStormMonitor,
  RenderStormPhase,
} from "@/lib/render-storm-canary";
import { createRenderStormMonitor } from "@/lib/render-storm-canary";

const RENDER_STORM_CANARY_PROFILER_ID = "render-storm-canary";

const RENDER_STORM_REPORTED_REGIONS = 5;

/**
 * Dev-only render-loop detector. Wraps the app root in a React `<Profiler>`
 * that counts commits per second; a sustained storm (see the lib module
 * "render-storm-canary" under apps/web/src/lib for thresholds and
 * calibration) emits a single `console.error`, which the e2e
 * `browserErrors` fixture (apps/web/e2e/helpers/test.ts) turns into a CI
 * failure on ANY spec, not just one dedicated to a specific past
 * regression. Damped near-loops (hundreds of re-renders/sec that never
 * trip React's own "Maximum update depth exceeded" throw) ship silently
 * without this.
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
  // eslint-disable-next-line no-console -- dev-only render-storm canary; this is the one sanctioned diagnostic emitter whose entire purpose is to be caught by the e2e browserErrors fixture as a CI-failing signal
  console.error(
    `[render-storm] sustained render storm detected: ~${details.commitsPerSecond} commits/sec ` +
      `(phases: ${formatPhaseBreakdown(details.phaseCounts)}; ` +
      `regions: ${formatRegionBreakdown(details.regionCounts)}). A component is re-rendering ` +
      "far above legitimate streaming rates (~20/s) without tripping React's own " +
      '"Maximum update depth exceeded" guard. Find the state update that re-triggers ' +
      "itself and break the loop.",
  );
};

const RenderStormProfiler = ({ children }: PropsWithChildren) => {
  const [monitor] = useState(() =>
    createRenderStormMonitor(emitRenderStormError),
  );

  return (
    <RenderStormMonitorContext value={monitor}>
      <Profiler
        id={RENDER_STORM_CANARY_PROFILER_ID}
        onRender={monitor.onRender}
      >
        {children}
      </Profiler>
    </RenderStormMonitorContext>
  );
};
