import {
  LEGISLATION_DOCUMENT_STATUSES,
  isLegislationDocumentStatus,
} from "@stll/api-contract/legislation-status";
import type { LegislationDocumentStatus } from "@stll/api-contract/legislation-status";

import type { TranslationKey } from "@/i18n/types";

export { LEGISLATION_DOCUMENT_STATUSES as STATUTE_STATUSES };
export { isLegislationDocumentStatus as isStatuteStatus };
export type StatuteStatus = LegislationDocumentStatus;

/**
 * Total over the shared lifecycle contract: a status added to the corpus
 * fails this map until it has a label, rather than reaching the reader as
 * machine text.
 */
export const STATUTE_STATUS_LABEL_KEYS = {
  current: "statutes.status.current",
  draft: "statutes.status.draft",
  historical: "statutes.status.historical",
  repealed: "statutes.status.repealed",
} as const satisfies Record<StatuteStatus, TranslationKey>;
