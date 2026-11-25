import { panic } from "better-result";

import { Temporal } from "@stll/time";

import type { ActivityDayOutages, ActivityStopReason } from "./activity-types";

/** The message naming each reason Activity could not record. */
export const STOP_REASON_KEYS = {
  reconnectNeeded: "stopReason.reconnectNeeded",
  notAvailable: "stopReason.notAvailable",
  blockedByPolicy: "stopReason.blockedByPolicy",
  signedOut: "stopReason.signedOut",
  notConfirmed: "stopReason.notConfirmed",
} as const satisfies Record<ActivityStopReason, string>;

export type OutageRange = {
  endMs: number;
  reason: ActivityStopReason;
  startMs: number;
};

/** A day's outages as ranges, longest first; none when they are unreadable
 * (the day says so separately). */
export const outageRanges = (outages: ActivityDayOutages): OutageRange[] => {
  switch (outages.status) {
    case "read":
      return outages.outages
        .map(({ start, end, reason }) => ({
          endMs: Temporal.Instant.from(end).epochMilliseconds,
          reason,
          startMs: Temporal.Instant.from(start).epochMilliseconds,
        }))
        .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs));
    case "unreadable":
      return [];
    default:
      outages satisfies never;
      return panic("Unhandled activity outage status");
  }
};
