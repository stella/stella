/**
 * The API's runtime mode, resolved once at startup. Local development
 * capabilities (dev routes, echoed sign-in codes, relaxed transport rules,
 * feature-gate bypasses) require an explicit runtime opt-in; see
 * `@stll/runtime-mode`.
 */
import { panic } from "better-result";

import {
  type NodeEnvLabel,
  readRuntimeMode,
  RUNTIME_MODE,
  type RuntimeMode,
} from "@stll/runtime-mode";

let resolved = readRuntimeMode();

export const runtimeMode = (): RuntimeMode => resolved.runtimeMode;

export const isLocalDevOpen = (): boolean =>
  resolved.runtimeMode.mode === RUNTIME_MODE.open;

/** The runtime NODE_ENV label, for validators that name one environment. */
export const runtimeNodeEnv = (): NodeEnvLabel => resolved.nodeEnv;

/** A test run the harness opened; never true for a strict process. */
export const isLocalTestRun = (): boolean => resolved.isLocalTestRun;

/** Refuses to continue unless local development access is open. */
export const requireLocalDevOpen = (capability: string): void => {
  if (!isLocalDevOpen()) {
    panic(
      `${capability} requires local development access: NODE_ENV=development (or test) with STELLA_LOCAL_DEV=1.`,
    );
  }
};

/**
 * Switches the mode for the rest of a test and returns the restore function.
 * Values captured at module load (origins, query instrumentation) keep the
 * mode the process started with.
 */
export const setRuntimeModeForTesting = (
  nextMode: RuntimeMode,
): (() => void) => {
  if (!resolved.isLocalTestRun) {
    panic("setRuntimeModeForTesting is only available to local test runs.");
  }
  const previous = resolved;
  resolved = {
    runtimeMode: nextMode,
    nodeEnv: previous.nodeEnv,
    isLocalTestRun: previous.isLocalTestRun,
  };
  return () => {
    resolved = previous;
  };
};
