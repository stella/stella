import { SIGNAL_SEVERITY } from "@stll/api-contract/signals";
import type { SignalSeverity } from "@stll/api-contract/signals";
import { DAY_IN_MS } from "@stll/time";

import type { SafeId } from "@/api/lib/branded-types";
import { isRecord } from "@/api/lib/type-guards";

/** Hearings this close to now are flagged even when not rescheduled. */
export const HEARING_SOON_WINDOW_MS = 14 * DAY_IN_MS;

/** The slice of an infosoud hearing entity the scout reasons about. */
export type HearingRecord = {
  externalId: string;
  caseMark: string;
  court: string;
  hearingType: string | null;
  startAt: Date | null;
  cancelled: boolean;
  date: string | null;
  time: string | null;
};

const readString = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * Narrow an entity's `externalData` into a hearing record; `null` when the
 * row is not a hearing (events carry `event`, not `hearing`).
 */
export const toHearingRecord = (row: {
  externalId: string | null;
  externalData: Record<string, unknown> | null;
  startAt: Date | null;
}): HearingRecord | null => {
  if (!row.externalId || !row.externalData) {
    return null;
  }
  const data = row.externalData;
  const hearing = data["hearing"];
  if (!isRecord(hearing)) {
    return null;
  }
  const rawCase = data["case"];
  const caseData = isRecord(rawCase) ? rawCase : null;
  const caseMark = readString(caseData?.["caseMark"]);
  if (!caseMark) {
    return null;
  }
  return {
    externalId: row.externalId,
    caseMark,
    court: readString(caseData?.["court"]) ?? "",
    hearingType: readString(hearing["type"]),
    startAt: row.startAt,
    cancelled: hearing["cancelled"] === true,
    date: readString(hearing["date"]),
    time: readString(hearing["time"]),
  };
};

/**
 * A reschedule is a pre-existing, non-cancelled hearing of the same case and
 * type with a different external id (the id hashes date/time/room, so any
 * change mints a new id). Returns its start, or `null` for a first listing.
 */
export const findPreviousStart = (
  hearing: HearingRecord,
  existing: readonly HearingRecord[],
): Date | null => {
  const candidates = existing.filter(
    (candidate) =>
      candidate.externalId !== hearing.externalId &&
      !candidate.cancelled &&
      candidate.caseMark === hearing.caseMark &&
      candidate.hearingType === hearing.hearingType &&
      candidate.startAt !== null,
  );
  if (candidates.length === 0) {
    return null;
  }
  let latest: HearingRecord | null = null;
  for (const candidate of candidates) {
    if (
      latest === null ||
      (candidate.startAt?.getTime() ?? 0) > (latest.startAt?.getTime() ?? 0)
    ) {
      latest = candidate;
    }
  }
  return latest?.startAt ?? null;
};

export const hearingSeverity = (
  hearing: HearingRecord,
  previousAt: Date | null,
  now: Date,
): SignalSeverity => {
  if (previousAt !== null) {
    return SIGNAL_SEVERITY.WARNING;
  }
  if (
    hearing.startAt !== null &&
    hearing.startAt.getTime() - now.getTime() <= HEARING_SOON_WINDOW_MS
  ) {
    return SIGNAL_SEVERITY.WARNING;
  }
  return SIGNAL_SEVERITY.NOTICE;
};

export const hearingDedupeKey = (
  workspaceId: SafeId<"workspace">,
  externalId: string,
): string => `infosoud:${workspaceId}:${externalId}`;
