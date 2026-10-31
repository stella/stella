// The route walk runs against the production build, where React never calls a
// `<Profiler>`'s onRender. Every React build, production included, reports
// each commit to the DevTools global hook instead, so the census installs a
// minimal hook from the test harness before any app script runs. Nothing
// ships in the app bundle; a page opened without the init script has no hook.
export const RENDER_CENSUS_GLOBAL = "__stellaRenderCensus";

/**
 * Playwright serializes this function into the page as an init script, so it
 * must not reference anything outside its own body.
 */
export const installRenderCommitHook = (globalKey: string): void => {
  const census = { renderers: 0, commits: 0 };
  const renderers = new Map<number, unknown>();
  Reflect.set(globalThis, globalKey, census);
  // The shape React and React Refresh expect from DevTools; Refresh wraps
  // `inject` and `onCommitFiberRoot` in place, so both stay writable.
  Reflect.set(globalThis, "__REACT_DEVTOOLS_GLOBAL_HOOK__", {
    renderers,
    supportsFiber: true,
    inject: (internals: unknown) => {
      census.renderers += 1;
      renderers.set(census.renderers, internals);
      return census.renderers;
    },
    onScheduleFiberRoot: () => undefined,
    onCommitFiberRoot: () => {
      census.commits += 1;
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
  });
};
