import {
  LEGISLATION_DOCUMENT_STATUSES,
  isLegislationDocumentStatus,
} from "@stll/api-contract/legislation-status";
import type { LegislationDocumentStatus } from "@stll/api-contract/legislation-status";
import { parsePlainDate, Temporal } from "@stll/time";

import type { TranslationKey } from "@/i18n/types";

export { LEGISLATION_DOCUMENT_STATUSES as STATUTE_STATUSES };
export { isLegislationDocumentStatus as isStatuteStatus };
export type StatuteStatus = LegislationDocumentStatus;

export const STATUTE_DISPLAY_STATUSES = [
  ...LEGISLATION_DOCUMENT_STATUSES,
  "future",
] as const;
export type StatuteDisplayStatus = (typeof STATUTE_DISPLAY_STATUSES)[number];

/**
 * Total over the shared lifecycle contract: a status added to the corpus
 * fails this map until it has a label, rather than reaching the reader as
 * machine text.
 */
export const STATUTE_STATUS_LABEL_KEYS = {
  current: "statutes.status.current",
  draft: "statutes.status.draft",
  future: "statutes.status.future",
  historical: "statutes.status.historical",
  repealed: "statutes.status.repealed",
} as const satisfies Record<StatuteDisplayStatus, TranslationKey>;

type ResolveStatuteDisplayStatusOptions = {
  status: string;
  today?: string | undefined;
  validFrom: string | null;
};

/**
 * Lifecycle status describes the consolidation in the corpus; `future` is
 * temporal presentation derived from its validity window. Keeping the two
 * separate avoids persisting a state that changes merely because today did.
 */
export const resolveStatuteDisplayStatus = ({
  status,
  today = Temporal.Now.plainDateISO(Temporal.Now.timeZoneId()).toString(),
  validFrom,
}: ResolveStatuteDisplayStatusOptions): StatuteDisplayStatus | null => {
  if (!isLegislationDocumentStatus(status)) {
    return null;
  }

  const from = validFrom === null ? null : parsePlainDate(validFrom);
  const currentDay = parsePlainDate(today);
  if (
    from !== null &&
    currentDay !== null &&
    Temporal.PlainDate.compare(from, currentDay) > 0
  ) {
    return "future";
  }

  return status;
};
