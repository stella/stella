import { panic } from "better-result";

import type { WebApiRoutes } from "@/lib/eden-client";

type OrganizationSettings =
  WebApiRoutes["organization-settings"]["get"]["response"][200];

/**
 * The picker entry for "no stored zone": choosing it clears the zone so the
 * server derives it from the primary jurisdiction again. Not an IANA id.
 */
export const FOLLOW_JURISDICTION = "follow-primary-jurisdiction";

/** A derived zone selects the follow entry, so the same zone can be pinned. */
export const timeZonePickerValue = ({
  timeZone,
  timeZoneSource,
}: Pick<OrganizationSettings, "timeZone" | "timeZoneSource">): string => {
  switch (timeZoneSource) {
    case "organization":
      return timeZone;
    case "practice-jurisdiction":
      return FOLLOW_JURISDICTION;
    default:
      timeZoneSource satisfies never;
      return panic(`Unhandled time-zone source: ${String(timeZoneSource)}`);
  }
};

/** The `timeZone` a picker choice saves: `null` clears it to the derived one. */
export const timeZoneToSave = (choice: string): string | null =>
  choice === FOLLOW_JURISDICTION ? null : choice;
