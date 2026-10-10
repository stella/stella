// Passive regression fixture for
// `calendar-day/no-wall-clock-scheduler-decision`.
import { Temporal } from "@stll/time";

declare const viewerZone: string;
declare const dueAt: {
  instant: Temporal.Instant;
  dayIn: (zone: string) => Temporal.PlainDate;
};

export const decideOnSlot = () => [
  // oxlint-disable-next-line calendar-day/no-wall-clock-scheduler-decision -- fixture: the wall clock is not the slot that was due
  new Date(),
  // oxlint-disable-next-line calendar-day/no-wall-clock-scheduler-decision -- fixture: Date.now is the wall clock
  Date.now(),
  // oxlint-disable-next-line calendar-day/no-wall-clock-scheduler-decision -- fixture: Temporal.Now is the wall clock
  Temporal.Now.instant(),
  // expect-clean: calendar-day/no-wall-clock-scheduler-decision
  dueAt.dayIn(viewerZone),
  // expect-clean: calendar-day/no-wall-clock-scheduler-decision
  new Date(dueAt.instant.epochMilliseconds),
];
