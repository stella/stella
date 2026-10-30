import { Temporal } from "@stll/time";

/**
 * The browser's wall clock in epoch milliseconds, for measuring how long the
 * reader waited. Public server-rendered modules may not read the clock during
 * render (the server and the hydrating client would differ), so they call this
 * only from effects and event handlers, which never run on the server, the
 * same contract `useTimePassed` keeps.
 */
export const readClientClockMs = (): number =>
  Temporal.Now.instant().epochMilliseconds;
