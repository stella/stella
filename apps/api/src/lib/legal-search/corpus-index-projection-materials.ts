import { panic } from "better-result";
import { and, asc, eq, inArray } from "drizzle-orm";

import { DECISION_IDENTIFIER_MAX_COUNT } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { CorpusIndexManifest } from "@/api/lib/legal-search/corpus-index-manifest";
import { deriveCorpusIndexProjectionDescriptor } from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import {
  caseLawProjectionInputFromCanonical,
  legislationProjectionInputFromCanonical,
  readActiveCorpusProjectionManifest,
} from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import {
  CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE,
  type CorpusProjectionIntentLease,
} from "@/api/lib/legal-search/corpus-index-projection-store";

type CorpusProjectionMaterialBase = {
  lease: CorpusProjectionIntentLease;
  textS3Key: string;
};

export type CorpusProjectionMaterial =
  | (CorpusProjectionMaterialBase & {
      family: "case_law";
      manifest: Extract<CorpusIndexManifest, { family: "case_law" }>;
      input: ReturnType<typeof caseLawProjectionInputFromCanonical>;
      astS3Key: string | null;
    })
  | (CorpusProjectionMaterialBase & {
      family: "legislation";
      manifest: Extract<CorpusIndexManifest, { family: "legislation" }>;
      input: ReturnType<typeof legislationProjectionInputFromCanonical>;
      astS3Key: null;
    });

export type CorpusProjectionMaterialRejection = {
  lease: CorpusProjectionIntentLease;
  status: "lease_lost" | "stale" | "unreadable";
  reason: string;
};

export type CorpusProjectionMaterialsResult = {
  ready: CorpusProjectionMaterial[];
  rejected: CorpusProjectionMaterialRejection[];
};

type ReadReservedCorpusProjectionMaterialsOptions = {
  leases: readonly CorpusProjectionIntentLease[];
};

const validateLeases = (
  leases: readonly CorpusProjectionIntentLease[],
): {
  family: CorpusProjectionIntentLease["family"];
  generation: string;
} => {
  const first = leases.at(0);
  if (
    first === undefined ||
    leases.length > CORPUS_PROJECTION_STORE_MAX_BATCH_SIZE
  ) {
    return panic("Corpus projection material batch is invalid");
  }
  const intentIds = new Set(leases.map(({ intentId }) => intentId));
  const entityIds = new Set(leases.map(({ entityId }) => entityId));
  if (
    intentIds.size !== leases.length ||
    entityIds.size !== leases.length ||
    leases.some(
      ({ family, generation }) =>
        family !== first.family || generation !== first.generation,
    )
  ) {
    return panic("Corpus projection material leases must be unique and scoped");
  }
  return { family: first.family, generation: first.generation };
};

type IntentSnapshot = Pick<
  typeof corpusIndexProjectionIntents.$inferSelect,
  | "id"
  | "family"
  | "generation"
  | "entityId"
  | "epoch"
  | "fingerprint"
  | "indexId"
  | "status"
  | "leaseToken"
>;

const intentMatchesLease = (
  intent: IntentSnapshot,
  lease: CorpusProjectionIntentLease,
): boolean =>
  intent.status === "reserved" &&
  intent.family === lease.family &&
  intent.generation === lease.generation &&
  intent.entityId === lease.entityId &&
  intent.epoch === lease.epoch &&
  intent.fingerprint === lease.fingerprint &&
  intent.indexId === lease.indexId &&
  intent.leaseToken === lease.leaseToken;

type StateSnapshot = Pick<
  typeof corpusIndexProjectionStates.$inferSelect,
  | "entityId"
  | "desiredAction"
  | "desiredEpoch"
  | "desiredFingerprint"
  | "desiredIndexId"
>;

const stateMatchesLease = (
  state: StateSnapshot,
  lease: CorpusProjectionIntentLease,
): boolean =>
  state.desiredAction === "upsert" &&
  state.desiredEpoch === lease.epoch &&
  state.desiredFingerprint === lease.fingerprint &&
  state.desiredIndexId === lease.indexId;

const descriptorMatchesLease = (
  descriptor: ReturnType<typeof deriveCorpusIndexProjectionDescriptor>,
  lease: CorpusProjectionIntentLease,
): boolean =>
  descriptor.action === "upsert" &&
  descriptor.fingerprint === lease.fingerprint &&
  descriptor.indexId === lease.indexId;

const rejection = (
  lease: CorpusProjectionIntentLease,
  status: CorpusProjectionMaterialRejection["status"],
  reason: string,
): CorpusProjectionMaterialRejection => ({ lease, status, reason });

const readCaseLawMaterials = async (
  tx: Transaction,
  leases: readonly CorpusProjectionIntentLease[],
  manifest: Extract<CorpusIndexManifest, { family: "case_law" }>,
  intents: ReadonlyMap<string, IntentSnapshot>,
  states: ReadonlyMap<string, StateSnapshot>,
): Promise<CorpusProjectionMaterialsResult> => {
  const entityIds = leases.map(({ entityId }) =>
    toSafeId<"caseLawDecision">(entityId),
  );
  const rows = await tx
    .select({
      documentId: caseLawDecisions.id,
      sourceId: caseLawDecisions.sourceId,
      jurisdiction: caseLawDecisions.country,
      language: caseLawDecisions.language,
      documentType: caseLawDecisions.decisionType,
      contentHash: caseLawDecisions.contentHash,
      redactedAt: caseLawDecisions.redactedAt,
      caseNumber: caseLawDecisions.caseNumber,
      court: caseLawDecisions.court,
      decisionDate: caseLawDecisions.decisionDate,
      ecli: caseLawDecisions.ecli,
      projectionEpoch: caseLawDecisions.projectionEpoch,
      textS3Key: caseLawDecisions.textS3Key,
      astS3Key: caseLawDecisions.astS3Key,
      sourceDescriptor: caseLawSources.descriptor,
    })
    .from(caseLawDecisions)
    .innerJoin(caseLawSources, eq(caseLawSources.id, caseLawDecisions.sourceId))
    .where(inArray(caseLawDecisions.id, entityIds))
    .limit(entityIds.length);
  const identifiers = await tx
    .select({
      decisionId: caseLawDecisionIdentifiers.decisionId,
      type: caseLawDecisionIdentifiers.type,
      value: caseLawDecisionIdentifiers.value,
    })
    .from(caseLawDecisionIdentifiers)
    .where(inArray(caseLawDecisionIdentifiers.decisionId, entityIds))
    .orderBy(
      asc(caseLawDecisionIdentifiers.decisionId),
      asc(caseLawDecisionIdentifiers.type),
      asc(caseLawDecisionIdentifiers.value),
    )
    .limit(entityIds.length * DECISION_IDENTIFIER_MAX_COUNT + 1);
  if (identifiers.length > entityIds.length * DECISION_IDENTIFIER_MAX_COUNT) {
    return panic(
      `Corpus projection material identifier count exceeds ${DECISION_IDENTIFIER_MAX_COUNT} per decision`,
    );
  }
  const identifiersByDecision = new Map<
    string,
    { type: string; value: string }[]
  >(entityIds.map((entityId) => [String(entityId), []]));
  for (const identifier of identifiers) {
    const values = identifiersByDecision.get(identifier.decisionId);
    if (
      values === undefined ||
      values.length >= DECISION_IDENTIFIER_MAX_COUNT
    ) {
      return panic(
        `Corpus projection material identifier invariant failed: ${identifier.decisionId}`,
      );
    }
    values.push({ type: identifier.type, value: identifier.value });
  }
  const byEntityId = new Map(rows.map((row) => [String(row.documentId), row]));
  const ready: CorpusProjectionMaterial[] = [];
  const rejected: CorpusProjectionMaterialRejection[] = [];
  for (const lease of leases) {
    const intent = intents.get(lease.intentId);
    if (intent === undefined || !intentMatchesLease(intent, lease)) {
      rejected.push(rejection(lease, "lease_lost", "reservation changed"));
      continue;
    }
    const state = states.get(lease.entityId);
    const row = byEntityId.get(lease.entityId);
    if (state === undefined || row === undefined) {
      rejected.push(rejection(lease, "stale", "canonical state disappeared"));
      continue;
    }
    const input = caseLawProjectionInputFromCanonical({
      ...row,
      identifiers:
        identifiersByDecision.get(row.documentId) ??
        panic(`Corpus projection material lost identifiers: ${row.documentId}`),
    });
    const descriptor = deriveCorpusIndexProjectionDescriptor(manifest, input);
    if (
      row.projectionEpoch !== lease.epoch ||
      !stateMatchesLease(state, lease) ||
      !descriptorMatchesLease(descriptor, lease)
    ) {
      rejected.push(rejection(lease, "stale", "canonical input changed"));
      continue;
    }
    if (row.textS3Key === null) {
      rejected.push(
        rejection(lease, "unreadable", "canonical text pointer is absent"),
      );
      continue;
    }
    ready.push({
      family: "case_law",
      lease,
      manifest,
      input,
      textS3Key: row.textS3Key,
      astS3Key: row.astS3Key,
    });
  }
  return { ready, rejected };
};

const readLegislationMaterials = async (
  tx: Transaction,
  leases: readonly CorpusProjectionIntentLease[],
  manifest: Extract<CorpusIndexManifest, { family: "legislation" }>,
  intents: ReadonlyMap<string, IntentSnapshot>,
  states: ReadonlyMap<string, StateSnapshot>,
): Promise<CorpusProjectionMaterialsResult> => {
  const entityIds = leases.map(({ entityId }) =>
    toSafeId<"legislationDocument">(entityId),
  );
  const rows = await tx
    .select({
      documentId: legislationDocuments.id,
      sourceId: legislationDocuments.sourceId,
      jurisdiction: legislationDocuments.country,
      language: legislationDocuments.language,
      documentType: legislationDocuments.documentType,
      contentHash: legislationDocuments.contentHash,
      title: legislationDocuments.title,
      status: legislationDocuments.status,
      effectiveDate: legislationDocuments.effectiveDate,
      versionValidFrom: legislationDocuments.versionValidFrom,
      versionValidTo: legislationDocuments.versionValidTo,
      eli: legislationDocuments.eli,
      projectionEpoch: legislationDocuments.projectionEpoch,
      textS3Key: legislationDocuments.textS3Key,
      sourceDescriptor: legislationSources.descriptor,
    })
    .from(legislationDocuments)
    .innerJoin(
      legislationSources,
      eq(legislationSources.id, legislationDocuments.sourceId),
    )
    .where(inArray(legislationDocuments.id, entityIds))
    .limit(entityIds.length);
  const byEntityId = new Map(rows.map((row) => [String(row.documentId), row]));
  const ready: CorpusProjectionMaterial[] = [];
  const rejected: CorpusProjectionMaterialRejection[] = [];
  for (const lease of leases) {
    const intent = intents.get(lease.intentId);
    if (intent === undefined || !intentMatchesLease(intent, lease)) {
      rejected.push(rejection(lease, "lease_lost", "reservation changed"));
      continue;
    }
    const state = states.get(lease.entityId);
    const row = byEntityId.get(lease.entityId);
    if (state === undefined || row === undefined) {
      rejected.push(rejection(lease, "stale", "canonical state disappeared"));
      continue;
    }
    const input = legislationProjectionInputFromCanonical(row);
    const descriptor = deriveCorpusIndexProjectionDescriptor(manifest, input);
    if (
      row.projectionEpoch !== lease.epoch ||
      !stateMatchesLease(state, lease) ||
      !descriptorMatchesLease(descriptor, lease)
    ) {
      rejected.push(rejection(lease, "stale", "canonical input changed"));
      continue;
    }
    if (row.textS3Key === null) {
      rejected.push(
        rejection(lease, "unreadable", "canonical text pointer is absent"),
      );
      continue;
    }
    ready.push({
      family: "legislation",
      lease,
      manifest,
      input,
      textS3Key: row.textS3Key,
      astS3Key: null,
    });
  }
  return { ready, rejected };
};

/**
 * Read only canonical metadata and pointers for exact live reservations.
 * Payload bytes are deliberately loaded after this transaction returns.
 */
export const readReservedCorpusProjectionMaterialsTx = async (
  tx: Transaction,
  { leases }: ReadReservedCorpusProjectionMaterialsOptions,
): Promise<CorpusProjectionMaterialsResult> => {
  const { family, generation } = validateLeases(leases);
  const manifest = await readActiveCorpusProjectionManifest(
    tx,
    family,
    generation,
    false,
  );
  const intentIds = leases.map(({ intentId }) => intentId);
  const entityIds = leases.map(({ entityId }) => entityId);
  const intentRows = await tx
    .select({
      id: corpusIndexProjectionIntents.id,
      family: corpusIndexProjectionIntents.family,
      generation: corpusIndexProjectionIntents.generation,
      entityId: corpusIndexProjectionIntents.entityId,
      epoch: corpusIndexProjectionIntents.epoch,
      fingerprint: corpusIndexProjectionIntents.fingerprint,
      indexId: corpusIndexProjectionIntents.indexId,
      status: corpusIndexProjectionIntents.status,
      leaseToken: corpusIndexProjectionIntents.leaseToken,
    })
    .from(corpusIndexProjectionIntents)
    .where(inArray(corpusIndexProjectionIntents.id, intentIds))
    .limit(intentIds.length);
  const stateRows = await tx
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      desiredAction: corpusIndexProjectionStates.desiredAction,
      desiredEpoch: corpusIndexProjectionStates.desiredEpoch,
      desiredFingerprint: corpusIndexProjectionStates.desiredFingerprint,
      desiredIndexId: corpusIndexProjectionStates.desiredIndexId,
    })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        inArray(corpusIndexProjectionStates.entityId, entityIds),
      ),
    )
    .limit(entityIds.length);
  const intents = new Map(intentRows.map((row) => [row.id, row]));
  const states = new Map(stateRows.map((row) => [row.entityId, row]));
  switch (family) {
    case "case_law": {
      if (manifest.family !== "case_law") {
        return panic("Case-law material manifest has another family");
      }
      return await readCaseLawMaterials(tx, leases, manifest, intents, states);
    }
    case "legislation": {
      if (manifest.family !== "legislation") {
        return panic("Legislation material manifest has another family");
      }
      return await readLegislationMaterials(
        tx,
        leases,
        manifest,
        intents,
        states,
      );
    }
    default:
      return family satisfies never;
  }
};
