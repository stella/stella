import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Relative, so suites outside `src` (e2e unit tests) can import this helper
// without the `@/` path alias.
import { drainReactScheduler } from "./lib/react-scheduler-drain";

/**
 * Remove the happy-dom globals only after React has run every scheduled task,
 * so no callback can touch `window` once it is gone.
 */
export const unregisterDomEnvironment = async (): Promise<void> => {
  await drainReactScheduler();
  await GlobalRegistrator.unregister();
};
