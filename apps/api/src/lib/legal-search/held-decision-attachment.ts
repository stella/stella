import { panic } from "better-result";
import type * as v from "valibot";

import {
  DECISION_IDENTIFIER_TYPES,
  type DecisionIdentifierType,
} from "@stll/legal-ast/decision-identifier";

import { ADAPTER_MANIFESTS } from "@/api/lib/legal-search/adapter-manifest";
import {
  CZ_ISIR_METADATA_KEY,
  czIsirDecisionMetadataSchema,
} from "@/api/lib/legal-search/cz-isir-decision";
import {
  CZ_NS_COLLECTION_METADATA_KEY,
  storedCzNsCollectionEntrySchema,
} from "@/api/lib/legal-search/cz-ns-collection-entry";
import {
  ADAPTER_KEYS,
  type AdapterKey,
  type ImportSourceKey,
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
  /**
   * What becomes of a record whose court and docket a host holds only under
   * another decision date: parked for review, or written as a decision of its
   * own. Stated per source, since only the source knows whether its dates
   * and its hosts' can disagree for one decision.
   */
  readonly docketHeldUnderOtherDate: "park-for-review" | "own-row";
};

/**
 * Every other registered source of the declaring source's jurisdiction, so a
 * source registered later is a host without anyone listing it.
 */
const otherSourcesOf = (
  adapterKey: AdapterKey,
): readonly [AdapterKey, ...AdapterKey[]] => {
  const { country } = ADAPTER_MANIFESTS[adapterKey];
  const [first, ...rest] = Object.values(ADAPTER_MANIFESTS).flatMap(
    (manifest) =>
      manifest.country === country && manifest.key !== adapterKey
        ? [manifest.key]
        : [],
  );
  return first === undefined
    ? panic(`No other ${country} source can hold ${adapterKey}'s decisions`)
    : [first, ...rest];
};

/**
 * The sources that opt in. A source not listed writes every record as a
 * decision of its own.
 */
export const HELD_DECISION_ATTACHMENTS: Readonly<
  Partial<Record<AdapterKey | ImportSourceKey, HeldDecisionAttachment>>
> = {
  // The Supreme Court's collection reprints decisions the Czech courts'
  // databases already publish; its dates and its hosts' sometimes disagree
  // for one decision, so a docket held under another date waits for review.
  // The insolvency register republishes, unanonymised, decisions the
  // courts' database and the Supreme Court's collection publish too: a
  // register copy of a decision already held enriches that decision. A high
  // court decides many times under one senate mark, so the same docket on
  // another date is another decision.
  [ADAPTER_KEYS.CZ_ISIR]: {
    hostAdapterKeys: otherSourcesOf(ADAPTER_KEYS.CZ_ISIR),
    metadataKey: CZ_ISIR_METADATA_KEY,
    metadataSchema: czIsirDecisionMetadataSchema,
    declaredIdentifierTypes: [DECISION_IDENTIFIER_TYPES.CASE_NUMBER],
    docketHeldUnderOtherDate: "own-row",
  },
  [ADAPTER_KEYS.CZ_NS_SBIRKA]: {
    hostAdapterKeys: otherSourcesOf(ADAPTER_KEYS.CZ_NS_SBIRKA),
    metadataKey: CZ_NS_COLLECTION_METADATA_KEY,
    metadataSchema: storedCzNsCollectionEntrySchema,
    declaredIdentifierTypes: [DECISION_IDENTIFIER_TYPES.REPORTER_CITATION],
    docketHeldUnderOtherDate: "park-for-review",
  },
};

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
