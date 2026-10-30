import { panic } from "better-result";
import { and, eq, inArray } from "drizzle-orm";

import { TIME_ENTRY_ACTIVITY_GROUP } from "@stll/api-contract";
import type { DesktopTimeEntryClassification } from "@stll/api-contract/desktop-time-entries";

import type { Transaction } from "@/api/db/root";
import { contacts } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";

export type ClassifiedMatter = {
  id: string;
  clientId: SafeId<"contact"> | null;
};

type LoadMatterLedesOptions = {
  organizationId: SafeId<"organization">;
  matters: readonly ClassifiedMatter[];
};

/**
 * Whether each matter's client bills in LEDES, keyed by matter id. A matter
 * without a client bills in categories.
 */
export const loadMatterLedes = async (
  tx: Transaction,
  { organizationId, matters }: LoadMatterLedesOptions,
) => {
  const clientIds = [
    ...new Set(matters.flatMap(({ clientId }) => (clientId ? [clientId] : []))),
  ];
  const formats =
    clientIds.length === 0
      ? []
      : await tx
          .select({ id: contacts.id, format: contacts.timeBillingFormat })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, organizationId),
              inArray(contacts.id, clientIds),
            ),
          )
          .limit(clientIds.length);
  const formatsById = new Map(formats.map(({ id, format }) => [id, format]));
  return new Map(
    matters.map(({ id, clientId }): [string, boolean] => {
      const format =
        clientId === null ? "categories" : formatsById.get(clientId);
      if (format === undefined) {
        return panic("Matter billing client is inaccessible");
      }
      return [id, format === "ledes"];
    }),
  );
};

/**
 * The one classification rule for matter time entries: UTBMS codes only on
 * matters whose client bills in LEDES, otherwise the client activity group.
 * Internal entries require a null matter, so no matter takes that group.
 */
export const matterClassificationAllowed = (
  classification: DesktopTimeEntryClassification,
  ledesEnabled: boolean,
) => {
  switch (classification.type) {
    case "ledes":
      return ledesEnabled;
    case "activity_group":
      return (
        !ledesEnabled &&
        classification.activityGroup === TIME_ENTRY_ACTIVITY_GROUP.CLIENT
      );
    default:
      return panic(
        "Unknown time entry classification",
        classification satisfies never,
      );
  }
};
