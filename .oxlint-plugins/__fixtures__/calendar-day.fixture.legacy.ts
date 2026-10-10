// A budgeted site passes; a second site in the same function exceeds the
// ledger budget of one and fails.
import { Temporal } from "@stll/time";

export const legacyDay = () => [
  // expect-clean: calendar-day/no-utc-user-day
  Temporal.Now.plainDateISO("UTC"),
  // oxlint-disable-next-line calendar-day/no-utc-user-day -- fixture: an existing budget cannot grow
  Temporal.Now.plainDateISO("UTC"),
];
