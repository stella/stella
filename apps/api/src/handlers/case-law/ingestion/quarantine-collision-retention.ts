import { panic } from "better-result";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  type CollisionFilteredDecisions,
  type CollisionFilterProof,
  filterQuarantinePeerCollisions,
} from "@/api/handlers/case-law/ingestion/quarantine-collision-filter";
import type { CaseLawSourceIngestionLease } from "@/api/lib/legal-search/case-law-source-ingestion-lease";
import type {
  IngestionResult,
  ReconciliationBuildOutcome,
  ReconciliationListingItem,
} from "@/api/lib/legal-search/ingestion-types";
import { storeListingObservations } from "@/api/lib/legal-search/listing-observation-store";
import {
  isQuarantineListingIdentity,
  type QuarantineCollisionObservation,
  quarantineCollisionObservation,
} from "@/api/lib/legal-search/quarantine-identity";
import { snapshotReconciliationPayload } from "@/api/lib/legal-search/reconciliation-payload";

/** Parser output cannot turn the same publisher evidence into another revision. */
const INGESTION_EVIDENCE_FIELDS = {
  caseNumber: "publisher",
  caseNumberType: "publisher",
  identifiers: "publisher",
  caseNumberIsPlaceholder: "derived",
  isListingOnly: "derived",
  observationDetail: "derived",
  documentDelivery: "derived",
  sourceDocumentId: "publisher",
  sourceDocumentIdAliases: "publisher",
  sourceDocumentIdRepairAliases: "derived",
  legacySourceUrls: "derived",
  legacyEcli: "derived",
  legacyCaseNumber: "derived",
  sheetNumber: "publisher",
  ecli: "publisher",
  court: "publisher",
  courtId: "publisher",
  country: "publisher",
  language: "publisher",
  decisionDate: "publisher",
  decisionType: "publisher",
  documentRole: "publisher",
  fulltext: "publisher",
  sourceUrl: "publisher",
  documentUrl: "publisher",
  metadata: "publisher",
  judges: "publisher",
  textFields: "publisher",
  rawHash: "derived",
  documentAst: "derived",
  sections: "derived",
  citationScopes: "derived",
  parserVersion: "derived",
  sourceRaw: "publisher",
  publisherCitedCases: "publisher",
  sourceRawBytes: "publisher",
  sourceRawObjects: "publisher",
  sourceRawContentType: "publisher",
  plainTextOutcome: "derived",
} as const satisfies Record<keyof IngestionResult, "publisher" | "derived">;

const isIngestionEvidenceField = (
  field: string,
): field is keyof typeof INGESTION_EVIDENCE_FIELDS =>
  Object.hasOwn(INGESTION_EVIDENCE_FIELDS, field);

const publisherEvidenceOf = (decision: IngestionResult) => {
  const publisher = new Map<string, unknown>();
  for (const field of Object.keys(decision)) {
    if (!isIngestionEvidenceField(field)) {
      panic("An ingestion field has no publisher-evidence classification");
    }
    if (INGESTION_EVIDENCE_FIELDS[field] === "publisher") {
      publisher.set(field, decision[field]);
    }
  }
  return snapshotReconciliationPayload(Object.fromEntries(publisher));
};

type RetainListedQuarantineDecisionsOptions = {
  sourceLease: Pick<
    CaseLawSourceIngestionLease,
    "source" | "beforeDatabaseMark"
  >;
  scopedDb: ScopedDb;
  listing: ReconciliationListingItem;
  built: Extract<ReconciliationBuildOutcome, { type: "built" }>;
  proof: CollisionFilterProof;
};

/** Retain the listed input before applying its decision and dependent companions. */
export const retainListedQuarantineDecisions = async ({
  sourceLease,
  scopedDb,
  listing,
  built,
  proof,
}: RetainListedQuarantineDecisionsOptions): Promise<CollisionRetainedDecisions> => {
  const decisions = [built.decision];
  if (built.companions !== undefined) {
    decisions.push(...built.companions);
  }
  const { id: sourceId, adapterKey } = sourceLease.source;
  const retention = createQuarantineCollisionRetention({
    adapterKey,
    persistCollisionEvidence: async (observations) => {
      await sourceLease.beforeDatabaseMark();
      await storeListingObservations(scopedDb, {
        sourceId,
        adapterKey,
        observations,
      });
    },
  });
  return await retention.retainDecisions({
    type: "reconciliation",
    listing,
    decisions,
    proof,
  });
};

/** Only this owner constructs an apply receipt, after its evidence write finishes. */
class RetainedQuarantineDecisions {
  readonly #filtered: CollisionFilteredDecisions;

  constructor(filtered: CollisionFilteredDecisions) {
    this.#filtered = filtered;
  }

  get decisions(): readonly IngestionResult[] {
    return this.#filtered.decisions;
  }

  get collidingIds(): readonly string[] {
    return this.#filtered.collidingIds;
  }
}

export type CollisionRetainedDecisions = RetainedQuarantineDecisions;

type ObserveCollisionEvidenceOptions = {
  sourceDocumentId: string;
  payload: unknown;
};

type CollisionEvidenceGroup =
  | {
      type: "single-revision";
      observations: Map<string, QuarantineCollisionObservation>;
    }
  | { type: "colliding"; known: Set<string> };

type RetainDecisionsOptions = {
  decisions: readonly IngestionResult[];
  proof: CollisionFilterProof;
} & (
  | { type: "crawl" }
  | { type: "reconciliation"; listing: ReconciliationListingItem }
);

type CreateQuarantineCollisionRetentionOptions = {
  adapterKey: string;
  persistCollisionEvidence: (
    observations: readonly QuarantineCollisionObservation[],
  ) => Promise<void>;
};

/** One accumulator spans a crawl cycle or both passes of a reconciliation scope. */
export const createQuarantineCollisionRetention = ({
  adapterKey,
  persistCollisionEvidence,
}: CreateQuarantineCollisionRetentionOptions) => {
  const groups = new Map<string, CollisionEvidenceGroup>();
  const pending = new Map<string, QuarantineCollisionObservation>();
  const markCollision = (sourceDocumentId: string): void => {
    const group = groups.get(sourceDocumentId);
    if (group?.type !== "single-revision") {
      return;
    }
    for (const [fingerprint, observation] of group.observations) {
      pending.set(fingerprint, observation);
    }
    groups.set(sourceDocumentId, {
      type: "colliding",
      known: new Set(group.observations.keys()),
    });
  };
  const observe = ({
    sourceDocumentId,
    payload,
  }: ObserveCollisionEvidenceOptions): void => {
    if (!isQuarantineListingIdentity({ type: "document", sourceDocumentId })) {
      return;
    }
    const observation = quarantineCollisionObservation({
      source: adapterKey,
      quarantineId: sourceDocumentId,
      payload,
    });
    const key = observation.identity.fingerprint;
    const group = groups.get(sourceDocumentId);
    if (group === undefined) {
      groups.set(sourceDocumentId, {
        type: "single-revision",
        observations: new Map([[key, observation]]),
      });
      return;
    }
    switch (group.type) {
      case "single-revision":
        group.observations.set(key, observation);
        if (group.observations.size > 1) {
          markCollision(sourceDocumentId);
        }
        return;
      case "colliding":
        if (!group.known.has(key)) {
          group.known.add(key);
          pending.set(key, observation);
        }
        return;
      default:
        group satisfies never;
        panic("Unknown collision evidence state");
    }
  };
  const flush = async (): Promise<void> => {
    if (pending.size === 0) {
      return;
    }
    await persistCollisionEvidence([...pending.values()]);
    pending.clear();
  };
  return {
    observe,
    flush,
    retainDecisions: async (
      options: RetainDecisionsOptions,
    ): Promise<CollisionRetainedDecisions> => {
      const { decisions, proof } = options;
      switch (options.type) {
        case "crawl": {
          const pageIdentities = new Set<string>();
          for (const decision of decisions) {
            if (
              decision.sourceDocumentId !== undefined &&
              isQuarantineListingIdentity({
                type: "document",
                sourceDocumentId: decision.sourceDocumentId,
              })
            ) {
              observe({
                sourceDocumentId: decision.sourceDocumentId,
                payload: publisherEvidenceOf(decision),
              });
              if (pageIdentities.has(decision.sourceDocumentId)) {
                markCollision(decision.sourceDocumentId);
              }
              pageIdentities.add(decision.sourceDocumentId);
            }
          }
          break;
        }
        case "reconciliation":
          if (options.listing.identity.type === "document") {
            observe({
              sourceDocumentId: options.listing.identity.sourceDocumentId,
              payload: options.listing.payload,
            });
          }
          break;
        default:
          options satisfies never;
          panic("Unknown collision evidence input");
      }
      await flush();
      return new RetainedQuarantineDecisions(
        filterQuarantinePeerCollisions({ decisions, proof }),
      );
    },
  };
};
