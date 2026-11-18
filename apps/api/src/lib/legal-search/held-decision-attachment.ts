import type * as v from "valibot";

import type { DecisionIdentifierType } from "@stll/legal-ast/decision-identifier";

import type {
  AdapterKey,
  ImportSourceKey,
} from "@/api/lib/legal-search/ingestion-constants";

/**
 * A source whose records can enrich a decision another source already holds,
 * instead of being written as a second row of the same decision.
 *
 * An official collection reprints decisions a court's own database already
 * publishes. At write time a record of a declaring source that has no row of
 * its own looks for the held decision it names among the host sources' rows:
 * exactly one by its stated ECLI, else exactly one by court, docket and
 * decision date. One match attaches the record; none writes it as a decision
 * of its own, as any other source's record; several park it as ambiguous and
 * write nothing.
 *
 * An attached record keeps its typed metadata, raw payload and provenance in
 * `case_law_held_decision_attachments`, and its identifiers of the declared
 * types become declared identifier rows of the host, so a lookup by them
 * finds the host. Nothing else of the host changes.
 */
export type HeldDecisionAttachment<THostKey extends string = AdapterKey> = {
  /**
   * The sources whose stored decisions this source's records can enrich.
   * Never the declaring source itself: a source's own duplicates are its
   * identity resolution's to settle.
   */
  readonly hostAdapterKeys: readonly [THostKey, ...THostKey[]];
  /** The key of the result's metadata that holds the record's typed metadata. */
  readonly metadataKey: string;
  /**
   * The schema that typed metadata must satisfy. A record whose metadata does
   * not is rejected into the failure ledger, never attached half-read.
   */
  readonly metadataSchema: v.GenericSchema<
    unknown,
    Readonly<Record<string, unknown>>
  >;
  /** The identifier types the record declares on its host, such as reporter citations. */
  readonly declaredIdentifierTypes: readonly [
    DecisionIdentifierType,
    ...DecisionIdentifierType[],
  ];
};

/**
 * The sources that opt in. A source not listed writes every record as a
 * decision of its own.
 */
export const HELD_DECISION_ATTACHMENTS: Readonly<
  Partial<Record<AdapterKey | ImportSourceKey, HeldDecisionAttachment>>
> = {};

const declaresAttachment = (
  adapterKey: string,
): adapterKey is keyof typeof HELD_DECISION_ATTACHMENTS =>
  Object.hasOwn(HELD_DECISION_ATTACHMENTS, adapterKey);

/** Callers carry the adapter identity; a record never selects its own declaration. */
export const heldDecisionAttachmentForAdapter = (
  adapterKey: string,
): HeldDecisionAttachment<string> | null =>
  declaresAttachment(adapterKey)
    ? (HELD_DECISION_ATTACHMENTS[adapterKey] ?? null)
    : null;
