import { panic } from "better-result";
import { eq } from "drizzle-orm";

import { parseTimeZoneId } from "@stll/time";
import type { TimeZoneId } from "@stll/time";

import type { Transaction } from "@/api/db/root";
import { organizationSettings, workspaces } from "@/api/db/schema";
import type { PracticeJurisdiction } from "@/api/db/schema";
import { arrayOrEmpty } from "@/api/lib/array";
import type { SafeId } from "@/api/lib/branded-types";

const UTC_ZONE = parseTimeZoneId("UTC") ?? panic("Runtime does not know UTC");
const PRAGUE_ZONE =
  parseTimeZoneId("Europe/Prague") ??
  panic("Runtime does not know Europe/Prague");

/**
 * Practice countries whose organizations default to the Prague day. Slovakia
 * shares the zone's rules (`Europe/Bratislava` is its alias).
 */
const PRAGUE_DAY_COUNTRIES: ReadonlySet<string> = new Set(["CZ", "SK"]);

/** Longer than any IANA id; bounds the request before the tz lookup. */
export const TIME_ZONE_ID_MAX_LENGTH = 64;

/** Whether the effective zone was chosen or derived. */
export const ORGANIZATION_TIME_ZONE_SOURCE = {
  ORGANIZATION: "organization",
  PRACTICE_JURISDICTION: "practice-jurisdiction",
} as const;

/** The stored columns the effective zone is derived from. */
export type OrganizationTimeZoneSource = {
  timeZone: TimeZoneId | null;
  practiceJurisdictions: readonly PracticeJurisdiction[];
};

/**
 * The organization's zone: the stored one, else the default derived at read
 * time from the primary practice jurisdiction (Europe/Prague for CZ and SK,
 * UTC otherwise). Deriving instead of backfilling keeps the default following
 * the jurisdiction until an admin picks a zone.
 *
 * A stored id the runtime no longer knows is an invariant break (writes go
 * through `parseTimeZoneId`), so it panics instead of moving the day silently.
 */
export const effectiveOrganizationTimeZone = ({
  timeZone,
  practiceJurisdictions,
}: OrganizationTimeZoneSource): TimeZoneId => {
  if (timeZone !== null) {
    return (
      parseTimeZoneId(timeZone) ??
      panic(`Stored organization time zone ${timeZone} is unknown`)
    );
  }
  const primary = practiceJurisdictions.find(({ isPrimary }) => isPrimary);
  return primary !== undefined && PRAGUE_DAY_COUNTRIES.has(primary.countryCode)
    ? PRAGUE_ZONE
    : UTC_ZONE;
};

/** The columns to select for `effectiveOrganizationTimeZone`. */
export const organizationTimeZoneColumns = {
  timeZone: organizationSettings.timeZone,
  practiceJurisdictions: organizationSettings.practiceJurisdictions,
} as const;

/** An organization that never saved settings has no row: defaults apply. */
const NO_SETTINGS: OrganizationTimeZoneSource = {
  timeZone: null,
  practiceJurisdictions: [],
};

type TimeZoneReader = Pick<Transaction, "select">;

/** The organization's effective zone, read inside the caller's transaction. */
export const readOrganizationTimeZone = async (
  tx: TimeZoneReader,
  organizationId: SafeId<"organization">,
): Promise<TimeZoneId> => {
  const rows = await tx
    .select(organizationTimeZoneColumns)
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return effectiveOrganizationTimeZone(rows.at(0) ?? NO_SETTINGS);
};

/** The effective zone of the organization that owns a workspace. */
export const readWorkspaceOrganizationTimeZone = async (
  tx: TimeZoneReader,
  workspaceId: SafeId<"workspace">,
): Promise<TimeZoneId> => {
  const rows = await tx
    .select(organizationTimeZoneColumns)
    .from(workspaces)
    .leftJoin(
      organizationSettings,
      eq(organizationSettings.organizationId, workspaces.organizationId),
    )
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const row = rows.at(0) ?? panic(`Workspace ${workspaceId} has no row`);
  return effectiveOrganizationTimeZone({
    timeZone: row.timeZone,
    practiceJurisdictions: arrayOrEmpty(row.practiceJurisdictions),
  });
};
