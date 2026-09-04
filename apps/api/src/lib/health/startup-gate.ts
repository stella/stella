/**
 * Startup gate for deployment health checks: distinct from liveness (the
 * process serves HTTP) and readiness (every dependency answers right now).
 * It latches the first time readiness passes and never closes again, so a
 * rollout can tell "this instance never came up" apart from "it came up and
 * a dependency blipped later". One gate per health route instance, so tests
 * get a fresh state without a module-level reset.
 */

export const STARTUP_STATE = {
  starting: "starting",
  started: "started",
} as const;

type StartupState = (typeof STARTUP_STATE)[keyof typeof STARTUP_STATE];

type StartupGate = {
  startup: () => StartupState;
  markStarted: () => void;
};

export const createStartupGate = (): StartupGate => {
  let startup: StartupState = STARTUP_STATE.starting;
  return {
    startup: () => startup,
    markStarted: () => {
      startup = STARTUP_STATE.started;
    },
  };
};
