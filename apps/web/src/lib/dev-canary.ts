/**
 * The one sanctioned `console.error` emitter for dev-only canaries (render
 * storm, rebuild churn, perf budget). Each canary detects a class of bug
 * that ships silently otherwise; emitting through `console.error` is what
 * lets the e2e `browserErrors` fixture (apps/web/e2e/helpers/test.ts) turn
 * a recurrence into a CI failure on ANY spec.
 *
 * Callers gate on `import.meta.env.DEV` themselves so the whole canary,
 * not just its message, is dead-code-eliminated from production bundles.
 * The `[tag]` prefix names the canary; keep it stable — specs match on it.
 */
export const emitDevCanaryError = (tag: string, message: string): void => {
  // eslint-disable-next-line no-console -- dev-only canary emitter; the sole console.error whose entire purpose is to be caught by the e2e browserErrors fixture as a CI-failing signal
  console.error(`[${tag}] ${message}`);
};
