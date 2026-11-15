import { dbClock } from "@stll/test-kit/db";

const HELD_LEASE_MS = 60_000;

/** A lease the runner holds, written as its claim writes one: token, claim time and expiry together. */
export const heldSchedulerLease = (lockedBy: string) => ({
  lockedBy,
  lockedAt: dbClock.now(),
  lockedUntil: dbClock.fromNow(HELD_LEASE_MS),
});
