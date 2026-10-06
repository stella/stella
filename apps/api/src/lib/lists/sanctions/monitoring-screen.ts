import { panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import type { contacts } from "@/api/db/schema";
import {
  monitoringFingerprint,
  monitoringSubject,
} from "@/api/lib/lists/sanctions/monitoring-input";
import type { SanctionsIndexCache } from "@/api/lib/lists/sanctions/screening-index";
import {
  screenSanctionsSubjects,
  unavailableSanctionsScreening,
} from "@/api/lib/lists/sanctions/screening-service";

type PrepareMonitoringContactsOptions = {
  db: ScopedDb;
  contactRows: readonly (typeof contacts.$inferSelect)[];
  now: Date;
  indexCache?: SanctionsIndexCache;
};

export const prepareMonitoringContacts = async ({
  db,
  contactRows,
  now,
  indexCache,
}: PrepareMonitoringContactsOptions) => {
  const results = await screenSanctionsSubjects({
    db,
    subjects: contactRows.map(monitoringSubject),
    practiceJurisdictions: [],
    now,
    resultMode: "complete",
    indexCache,
  });
  return contactRows.map((contact, index) => {
    const result =
      results.at(index) ?? panic("Monitoring batch outcome missing");
    // Invalid persisted names are an explicit unavailable result, never clear or a poisoned queue slot.
    const screened = result.isErr()
      ? unavailableSanctionsScreening({
          reason: "load-failed",
          practiceJurisdictions: [],
          now,
        })
      : result.value;
    return {
      contactId: contact.id,
      contactFingerprint: monitoringFingerprint(contact),
      lists: screened.lists,
    };
  });
};
