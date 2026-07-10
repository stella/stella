import { Profiler, useState } from "react";
import type { PropsWithChildren, ReactNode } from "react";

import type {
  RenderStormDetails,
  RenderStormPhase,
} from "@/lib/render-storm-canary";
import { createRenderStormMonitor } from "@/lib/render-storm-canary";

const RENDER_STORM_CANARY_PROFILER_ID = "render-storm-canary";

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

const formatPhaseBreakdown = (
  phaseCounts: Record<RenderStormPhase, number>,
): string =>
  Object.entries(phaseCounts)
    .filter(([, count]) => count > 0)
    .map(([phase, count]) => `${phase}=${count}`)
    .join(", ");

const emitRenderStormError = (details: RenderStormDetails) => {
  // eslint-disable-next-line no-console -- dev-only render-storm canary; this is the one sanctioned diagnostic emitter whose entire purpose is to be caught by the e2e browserErrors fixture as a CI-failing signal
  console.error(
    `[render-storm] sustained render storm detected: ~${details.commitsPerSecond} commits/sec ` +
      `(phases: ${formatPhaseBreakdown(details.phaseCounts)}). A component is re-rendering ` +
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
    <Profiler id={RENDER_STORM_CANARY_PROFILER_ID} onRender={monitor.onRender}>
      {children}
    </Profiler>
  );
};
