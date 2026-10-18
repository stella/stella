import type { LegislationListValidity } from "@stll/api-contract/legislation-status";
import type { StatuteColumnId } from "@stll/api-contract/public-law-table";

import type { TranslationKey } from "@/i18n/types";

/**
 * The statute column model as data: which columns exist, what they are
 * called, how wide they start and which of them a reader may hide. The same
 * shape the decision columns are declared in, drawn by the same table.
 */
type StatuteColumnModel = {
  /** The width the column starts at, before a stored resize. */
  size: number;
  /** Whether the reader may hide it. */
  hide: boolean;
  emphasis: "content" | "metadata";
};

/** The act column is the row's identity, so it never hides. */
export const STATUTE_COLUMN_MODEL = {
  act: { size: 460, hide: false, emphasis: "content" },
  type: { size: 140, hide: true, emphasis: "metadata" },
  validity: { size: 130, hide: true, emphasis: "metadata" },
  firstVersion: { size: 130, hide: true, emphasis: "metadata" },
  amendments: { size: 150, hide: true, emphasis: "metadata" },
  lastAmended: { size: 150, hide: true, emphasis: "metadata" },
  citedBy: { size: 110, hide: true, emphasis: "metadata" },
} as const satisfies Record<StatuteColumnId, StatuteColumnModel>;

/** The narrowest a statute column may be dragged. */
export const STATUTE_COLUMN_MIN_SIZE = 80;

export const STATUTE_COLUMN_LABEL_KEYS = {
  act: "statutes.columns.act",
  type: "common.type",
  validity: "common.status",
  firstVersion: "statutes.columns.firstVersion",
  amendments: "statutes.columns.amendments",
  lastAmended: "statutes.columns.lastAmended",
  citedBy: "caseLaw.columns.citedBy",
} as const satisfies Record<StatuteColumnId, TranslationKey>;

/**
 * Whether a listed Work still applies. In force reads as the statute
 * reader's own "in force"; a Work whose last wording closed reads as no
 * longer in force, because the corpus cannot tell a repeal from an expiry.
 * A Work the publisher states never took effect says so; one whose versions
 * cannot establish any period in force reads as unclear, never as in force.
 */
export const STATUTE_VALIDITY_LABEL_KEYS = {
  "in-force": "statutes.status.current",
  ended: "statutes.status.ended",
  "never-in-force": "statutes.status.neverInForce",
  unknown: "statutes.status.unknown",
} as const satisfies Record<LegislationListValidity, TranslationKey>;
