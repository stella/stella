import { Temporal } from "temporal-polyfill/full";

/** Wall-clock epoch milliseconds, the unit token lifetimes are counted in. */
export const epochMilliseconds = (): number =>
  Temporal.Now.instant().epochMilliseconds;
