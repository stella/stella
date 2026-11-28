import { panic } from "better-result";
import type * as v from "valibot";

import { ADAPTER_MANIFESTS } from "@stll/case-law-ingestion-core/adapter-manifest";
import {
  ADAPTER_KEYS,
  type AdapterKey,
  type ImportSourceKey,
} from "@stll/case-law-ingestion-core/ingestion-constants";
import {
  CZ_ISIR_METADATA_KEY,
  czIsirDecisionMetadataSchema,
} from "@stll/legal-ast/cz-isir-decision";
import {
  DECISION_IDENTIFIER_TYPES,
  type DecisionIdentifierType,
} from "@stll/legal-ast/decision-identifier";

import {
  CZ_NS_COLLECTION_METADATA_KEY,
  czNsCollectionDocumentPartSchema,
  storedCzNsCollectionEntrySchema,
} from "@/api/lib/legal-search/cz-ns-collection-entry";

import type { CollectionDocumentPart } from "./collection-document-part";

/**
 * What tells two orders of one docket on one day apart: the sheet within the
 * file (`-24`), or the file position a high court's docket names (`B-24`).
 */
type HeldDecisionOrderMark = {
  readonly sheetNumber: string | null;
  readonly filePosition: string | null;
};

/**
 * A source whose records can enrich a decision another source already holds,
 * instead of being written as a second row of the same decision.
 *
 * Identity matching checks both ECLI and court, docket and decision date across
 * every source in the country. Authoritative publisher rows precede collection
 * copies; same-source sibling posts share one canonical decision. Conflicting,
 * ambiguous or policy-disallowed matches are durably parked. Only complete
 * absence on both identity paths permits a new own row.
 *
 * An attached record keeps its typed metadata, raw payload and provenance in
 * `case_law_held_decision_attachments`, and its identifiers of the declared
 * types become declared identifier rows of the host, so a lookup by them
 * finds the host. Nothing else of the host changes.
 */
export type HeldDecisionAttachment<THostKey extends string = AdapterKey> = {
  /**
   * The sources whose stored decisions this source's records can enrich.
   * This policy restricts attachment after the all-source safety lookup;
   * it never excludes a candidate from the new-row prevention fence.
   * Same-source sibling posts can always share their verified canonical row.
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
  /** Validated source-owned descriptor of the retained document edition. */
  readonly documentPartSchema?: v.GenericSchema<
    unknown,
    CollectionDocumentPart
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
  /**
   * The record's order mark, where the source states one. A record with a
   * mark matches by court, docket and date only a decision that states the
   * same mark, since one court issues several orders under one docket on one
   * day. Absent where court, docket and date name one decision.
   */
  readonly orderMarkOf?: (observed: {
    readonly sheetNumber?: string | undefined;
    readonly metadata: Readonly<Record<string, unknown>>;
  }) => HeldDecisionOrderMark | null;
};

/** The register's order mark: the decision's sheet, or its file position. */
const czIsirOrderMark = ({
  sheetNumber,
  metadata,
}: {
  readonly sheetNumber?: string | undefined;
  readonly metadata: Readonly<Record<string, unknown>>;
}): HeldDecisionOrderMark | null => {
  const stored = metadata[CZ_ISIR_METADATA_KEY];
  const filePosition =
    typeof stored === "object" &&
    stored !== null &&
    "filePosition" in stored &&
    typeof stored.filePosition === "string"
      ? stored.filePosition
      : null;
  return sheetNumber === undefined && filePosition === null
    ? null
    : { sheetNumber: sheetNumber ?? null, filePosition };
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
    orderMarkOf: czIsirOrderMark,
  },
  [ADAPTER_KEYS.CZ_NS_SBIRKA]: {
    hostAdapterKeys: otherSourcesOf(ADAPTER_KEYS.CZ_NS_SBIRKA),
    metadataKey: CZ_NS_COLLECTION_METADATA_KEY,
    metadataSchema: storedCzNsCollectionEntrySchema,
    documentPartSchema: czNsCollectionDocumentPartSchema,
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
