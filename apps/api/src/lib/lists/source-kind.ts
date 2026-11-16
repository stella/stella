// What a list's source documents are to its facts, and the footing that gives
// each fact. A document records a fact itself (a letter, minutes, a
// register); testimony is a person's account of it (a witness statement, an
// interview note, a transcript). The kind is set once per document on a list
// and every fact source citing that document inherits it, so a fact's tier
// is always derived from its sources as they stand, never stored.
//
// Dependency-light on purpose: the database schema derives its CHECK from
// these consts.

import { LIST_SOURCE_KINDS } from "@stll/api-contract/list-source-kinds";
import type { ListSourceKind } from "@stll/api-contract/list-source-kinds";

/** What a source document is to a list's facts. */
export type SourceKind = ListSourceKind;

/** A document nobody has classified records what it says: testimony is the
 *  exception a reviewer marks. */
export const DEFAULT_SOURCE_KIND = "document" satisfies SourceKind;

/** A document's kind on a list: the one a reviewer set, else the default. */
export const sourceKindOrDefault = (kind: SourceKind | null): SourceKind =>
  kind ?? DEFAULT_SOURCE_KIND;

/** A fact's footing: the best kind among its sources, or unsourced when no
 *  source that has not been rejected is linked. */
export const FACT_TIERS = [...LIST_SOURCE_KINDS, "unsourced"] as const;
export type FactTier = (typeof FACT_TIERS)[number];

/** Lower ranks are better footing; a record outranks an account of it. */
const FACT_TIER_RANK = {
  document: 0,
  testimony: 1,
  unsourced: 2,
} as const satisfies Record<FactTier, number>;

/** The tier of a fact whose live sources cite documents of these kinds. */
export const factTier = (sourceKinds: Iterable<SourceKind>): FactTier => {
  let best: FactTier = "unsourced";
  for (const kind of sourceKinds) {
    if (FACT_TIER_RANK[kind] < FACT_TIER_RANK[best]) {
      best = kind;
    }
  }
  return best;
};

export const SOURCE_KIND_LIMITS = {
  /** Documents one kind read may name. */
  READ_DOCUMENTS_MAX: 200,
} as const;

/** Audit operation of setting a document's kind on a list. */
export const SOURCE_KIND_SET_OPERATION = "source_kind_set";
