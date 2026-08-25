import { panic, TaggedError } from "better-result";
import { and, asc, eq, or, sql } from "drizzle-orm";

import { DECISION_IDENTIFIER_MAX_COUNT } from "@stll/legal-ast/decision-identifier";

import type { Transaction } from "@/api/db/root";
import {
  caseLawDecisionIdentifiers,
  caseLawDecisions,
  caseLawSources,
  corpusIndexGenerations,
  corpusIndexProjectionStates,
  legislationDocuments,
  legislationSources,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CORPUS_INDEX_MANIFESTS,
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";
import {
  deriveCorpusIndexProjectionDescriptor,
  type CaseLawV5ProjectionInput,
  type CorpusIndexProjectionDescriptor,
  type CorpusIndexProjectionInput,
  type LegislationV2ProjectionInput,
} from "@/api/lib/legal-search/corpus-index-projection-descriptor";
import { isRedistributable } from "@/api/lib/legal-search/corpus-source";

const CORPUS_INDEX_MANIFEST_COUNT = Object.keys(CORPUS_INDEX_MANIFESTS).length;

export type CorpusIndexProjectionSubject =
  | {
      family: "case_law";
      entityId: SafeId<"caseLawDecision">;
    }
  | {
      family: "legislation";
      entityId: SafeId<"legislationDocument">;
    };

export class CorpusIndexProjectionSubjectMissingError extends TaggedError(
  "CorpusIndexProjectionSubjectMissingError",
)<{ message: string; subject: CorpusIndexProjectionSubject }> {}

type LockedProjectionInput = {
  epoch: bigint;
  input: CorpusIndexProjectionInput;
};

export type CaseLawProjectionCanonicalInput = {
  documentId: SafeId<"caseLawDecision">;
  sourceId: SafeId<"caseLawSource">;
  jurisdiction: string;
  language: string;
  documentType: string | null;
  contentHash: string | null;
  redactedAt: Date | null;
  caseNumber: string;
  identifiers: readonly { type: string; value: string }[];
  court: string;
  decisionDate: string | null;
  ecli: string | null;
  sourceDescriptor: Parameters<typeof isRedistributable>[0];
};

export const caseLawProjectionInputFromCanonical = ({
  documentId,
  sourceId,
  jurisdiction,
  language,
  documentType,
  contentHash,
  redactedAt,
  caseNumber,
  identifiers,
  court,
  decisionDate,
  ecli,
  sourceDescriptor,
}: CaseLawProjectionCanonicalInput): CaseLawV5ProjectionInput => ({
  family: "case_law",
  documentId,
  sourceId,
  jurisdiction,
  language,
  documentType,
  contentHash,
  redistributionEligible: isRedistributable(sourceDescriptor),
  redacted: redactedAt !== null,
  caseNumber,
  identifiers,
  court,
  decisionDate,
  ecli,
});

export type LegislationProjectionCanonicalInput = {
  documentId: SafeId<"legislationDocument">;
  sourceId: SafeId<"legislationSource">;
  jurisdiction: string;
  language: string;
  documentType: string | null;
  contentHash: string | null;
  title: string;
  status: string;
  effectiveDate: string | null;
  versionValidFrom: string | null;
  versionValidTo: string | null;
  eli: string;
  sourceDescriptor: Parameters<typeof isRedistributable>[0];
};

export const legislationProjectionInputFromCanonical = ({
  documentId,
  sourceId,
  jurisdiction,
  language,
  documentType,
  contentHash,
  title,
  status,
  effectiveDate,
  versionValidFrom,
  versionValidTo,
  eli,
  sourceDescriptor,
}: LegislationProjectionCanonicalInput): LegislationV2ProjectionInput => ({
  family: "legislation",
  documentId,
  sourceId,
  jurisdiction,
  language,
  documentType,
  contentHash,
  redistributionEligible: isRedistributable(sourceDescriptor),
  title,
  status,
  effectiveDate,
  versionValidFrom,
  versionValidTo,
  eli,
});

const lockCaseLawProjectionInput = async (
  tx: Transaction,
  subject: Extract<CorpusIndexProjectionSubject, { family: "case_law" }>,
): Promise<LockedProjectionInput> => {
  // Source-policy writers own the source row before walking its documents.
  // Take the compatible source lock first so per-document projection never
  // inverts that order or exclusively serializes every decision in a source.
  const sourceRows = await tx
    .select({
      sourceId: caseLawSources.id,
      sourceDescriptor: caseLawSources.descriptor,
    })
    .from(caseLawSources)
    .innerJoin(
      caseLawDecisions,
      eq(caseLawDecisions.sourceId, caseLawSources.id),
    )
    .where(eq(caseLawDecisions.id, subject.entityId))
    .limit(1)
    .for("share", { of: caseLawSources });
  const source = sourceRows.at(0);
  if (source === undefined) {
    throw new CorpusIndexProjectionSubjectMissingError({
      message: `Case-law projection subject does not exist: ${subject.entityId}`,
      subject,
    });
  }
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
    })
    .from(caseLawDecisions)
    .where(
      and(
        eq(caseLawDecisions.id, subject.entityId),
        eq(caseLawDecisions.sourceId, source.sourceId),
      ),
    )
    .limit(1)
    .for("update", { of: caseLawDecisions });
  const row = rows.at(0);
  if (row === undefined) {
    throw new CorpusIndexProjectionSubjectMissingError({
      message: `Case-law projection subject does not exist: ${subject.entityId}`,
      subject,
    });
  }
  const identifiers = await tx
    .select({
      type: caseLawDecisionIdentifiers.type,
      value: caseLawDecisionIdentifiers.value,
    })
    .from(caseLawDecisionIdentifiers)
    .where(eq(caseLawDecisionIdentifiers.decisionId, subject.entityId))
    .orderBy(
      asc(caseLawDecisionIdentifiers.type),
      asc(caseLawDecisionIdentifiers.value),
    )
    .limit(DECISION_IDENTIFIER_MAX_COUNT + 1)
    .for("share");
  if (identifiers.length > DECISION_IDENTIFIER_MAX_COUNT) {
    return panic(
      `Case-law projection subject exceeds ${DECISION_IDENTIFIER_MAX_COUNT} identifiers: ${subject.entityId}`,
    );
  }
  return {
    epoch: row.projectionEpoch,
    input: caseLawProjectionInputFromCanonical({
      ...row,
      identifiers,
      sourceDescriptor: source.sourceDescriptor,
    }),
  };
};

const lockLegislationProjectionInput = async (
  tx: Transaction,
  subject: Extract<CorpusIndexProjectionSubject, { family: "legislation" }>,
): Promise<LockedProjectionInput> => {
  const sourceRows = await tx
    .select({
      sourceId: legislationSources.id,
      sourceDescriptor: legislationSources.descriptor,
    })
    .from(legislationSources)
    .innerJoin(
      legislationDocuments,
      eq(legislationDocuments.sourceId, legislationSources.id),
    )
    .where(eq(legislationDocuments.id, subject.entityId))
    .limit(1)
    .for("share", { of: legislationSources });
  const source = sourceRows.at(0);
  if (source === undefined) {
    throw new CorpusIndexProjectionSubjectMissingError({
      message: `Legislation projection subject does not exist: ${subject.entityId}`,
      subject,
    });
  }
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
    })
    .from(legislationDocuments)
    .where(
      and(
        eq(legislationDocuments.id, subject.entityId),
        eq(legislationDocuments.sourceId, source.sourceId),
      ),
    )
    .limit(1)
    .for("update", { of: legislationDocuments });
  const row = rows.at(0);
  if (row === undefined) {
    throw new CorpusIndexProjectionSubjectMissingError({
      message: `Legislation projection subject does not exist: ${subject.entityId}`,
      subject,
    });
  }
  return {
    epoch: row.projectionEpoch,
    input: legislationProjectionInputFromCanonical({
      ...row,
      sourceDescriptor: source.sourceDescriptor,
    }),
  };
};

const lockProjectionInput = async (
  tx: Transaction,
  subject: CorpusIndexProjectionSubject,
): Promise<LockedProjectionInput> => {
  switch (subject.family) {
    case "case_law":
      return await lockCaseLawProjectionInput(tx, subject);
    case "legislation":
      return await lockLegislationProjectionInput(tx, subject);
    default:
      return subject satisfies never;
  }
};

const setCanonicalProjectionEpoch = async (
  tx: Transaction,
  subject: CorpusIndexProjectionSubject,
  epoch: bigint,
): Promise<void> => {
  switch (subject.family) {
    case "case_law":
      await tx
        .update(caseLawDecisions)
        .set({ projectionEpoch: epoch })
        .where(eq(caseLawDecisions.id, subject.entityId));
      return;
    case "legislation":
      await tx
        .update(legislationDocuments)
        .set({ projectionEpoch: epoch })
        .where(eq(legislationDocuments.id, subject.entityId));
      return;
    default:
      return subject satisfies never;
  }
};

type RegisteredManifest = {
  generation: string;
  manifest: CorpusIndexManifest;
};

const verifiedManifest = ({
  family,
  generation,
  cluster,
  manifestDigest,
}: typeof corpusIndexGenerations.$inferSelect): CorpusIndexManifest => {
  const manifest = requireCorpusIndexManifest(family, generation);
  const expectedDigest = corpusIndexManifestDigest(manifest);
  if (cluster !== manifest.cluster || manifestDigest !== expectedDigest) {
    return panic(
      `Corpus generation contract mismatch: ${family}/${generation}`,
    );
  }
  return manifest;
};

const activeManifests = async (
  tx: Transaction,
  family: CorpusIndexProjectionSubject["family"],
): Promise<RegisteredManifest[]> => {
  const rows = await tx
    .select()
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, family),
        or(
          eq(corpusIndexGenerations.status, "building"),
          eq(corpusIndexGenerations.status, "serving"),
        ),
      ),
    )
    .orderBy(asc(corpusIndexGenerations.generation))
    .limit(CORPUS_INDEX_MANIFEST_COUNT + 1)
    .for("share");
  if (rows.length > CORPUS_INDEX_MANIFEST_COUNT) {
    return panic(`Active corpus generation registry exceeds its manifest set`);
  }
  return rows.map((row) => ({
    generation: row.generation,
    manifest: verifiedManifest(row),
  }));
};

export const readActiveCorpusProjectionManifest = async (
  tx: Transaction,
  family: CorpusIndexProjectionSubject["family"],
  generation: string,
  lock: boolean,
): Promise<CorpusIndexManifest> => {
  const query = tx
    .select()
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, family),
        eq(corpusIndexGenerations.generation, generation),
        or(
          eq(corpusIndexGenerations.status, "building"),
          eq(corpusIndexGenerations.status, "serving"),
        ),
      ),
    )
    .limit(1);
  const rows = lock ? await query.for("share") : await query;
  const row = rows.at(0);
  if (row === undefined) {
    return panic(
      `Active corpus generation is not registered: ${family}/${generation}`,
    );
  }
  return verifiedManifest(row);
};

/**
 * Cleanup outlives serving eligibility. Retiring generations can still carry
 * unknown append outcomes, so cleanup verifies and share-locks their immutable
 * registered manifest without requiring an active lifecycle status.
 */
export const readRegisteredCorpusProjectionManifestForCleanup = async (
  tx: Transaction,
  family: CorpusIndexProjectionSubject["family"],
  generation: string,
): Promise<CorpusIndexManifest> => {
  const rows = await tx
    .select()
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, family),
        eq(corpusIndexGenerations.generation, generation),
      ),
    )
    .limit(1)
    .for("share");
  const row = rows.at(0);
  if (row === undefined) {
    return panic(
      `Corpus generation is not registered for cleanup: ${family}/${generation}`,
    );
  }
  return verifiedManifest(row);
};

export const buildCorpusIndexProjectionDesiredStateValues = ({
  subject,
  generation,
  epoch,
  descriptor,
}: {
  subject: CorpusIndexProjectionSubject;
  generation: string;
  epoch: bigint;
  descriptor: CorpusIndexProjectionDescriptor;
}): typeof corpusIndexProjectionStates.$inferInsert => ({
  family: subject.family,
  generation,
  entityId: subject.entityId,
  desiredAction: descriptor.action,
  desiredEpoch: epoch,
  desiredFingerprint:
    descriptor.action === "upsert" ? descriptor.fingerprint : null,
  desiredIndexId: descriptor.action === "upsert" ? descriptor.indexId : null,
});

const writeDesiredStates = async (
  tx: Transaction,
  values: (typeof corpusIndexProjectionStates.$inferInsert)[],
): Promise<void> => {
  if (values.length === 0) {
    return;
  }
  await tx
    .insert(corpusIndexProjectionStates)
    .values(values)
    .onConflictDoUpdate({
      target: [
        corpusIndexProjectionStates.family,
        corpusIndexProjectionStates.generation,
        corpusIndexProjectionStates.entityId,
      ],
      set: {
        desiredAction: sql`excluded.desired_action`,
        desiredEpoch: sql`excluded.desired_epoch`,
        desiredFingerprint: sql`excluded.desired_fingerprint`,
        desiredIndexId: sql`excluded.desired_index_id`,
        updatedAt: sql<Date>`clock_timestamp()`,
      },
    });
};

type DesiredStateSnapshot = {
  generation: string;
  desiredAction: "upsert" | "erase";
  desiredEpoch: bigint;
  desiredFingerprint: string | null;
  desiredIndexId: string | null;
};

const desiredStateMatches = (
  state: DesiredStateSnapshot,
  epoch: bigint,
  descriptor: CorpusIndexProjectionDescriptor,
): boolean =>
  state.desiredEpoch === epoch &&
  state.desiredAction === descriptor.action &&
  state.desiredFingerprint ===
    (descriptor.action === "upsert" ? descriptor.fingerprint : null) &&
  state.desiredIndexId ===
    (descriptor.action === "upsert" ? descriptor.indexId : null);

/**
 * Advance one canonical mutation across every active final generation. The
 * caller must invoke this inside the same transaction that changed the
 * projection-relevant canonical fields.
 */
export const advanceCorpusProjectionDesiredStateTx = async (
  tx: Transaction,
  subject: CorpusIndexProjectionSubject,
): Promise<{ epoch: bigint; generationCount: number }> => {
  const locked = await lockProjectionInput(tx, subject);
  const manifests = await activeManifests(tx, subject.family);
  if (manifests.length === 0) {
    return { epoch: locked.epoch, generationCount: 0 };
  }

  const epoch = locked.epoch + 1n;
  await setCanonicalProjectionEpoch(tx, subject, epoch);
  await writeDesiredStates(
    tx,
    manifests.map(({ generation, manifest }) =>
      buildCorpusIndexProjectionDesiredStateValues({
        subject,
        generation,
        epoch,
        descriptor: deriveCorpusIndexProjectionDescriptor(
          manifest,
          locked.input,
        ),
      }),
    ),
  );
  return { epoch, generationCount: manifests.length };
};

/**
 * Repair or seed desired state from authoritative corpus rows. Plane may call
 * this from bounded sweeps after a projector or source-policy change; exact
 * matches are a fixed point and therefore do not manufacture new epochs.
 */
export const reconcileCorpusProjectionDesiredStateTx = async (
  tx: Transaction,
  subject: CorpusIndexProjectionSubject,
): Promise<{ epoch: bigint; changed: boolean; generationCount: number }> => {
  const locked = await lockProjectionInput(tx, subject);
  const manifests = await activeManifests(tx, subject.family);
  if (manifests.length === 0) {
    return {
      epoch: locked.epoch,
      changed: false,
      generationCount: 0,
    };
  }

  const existing = await tx
    .select({
      generation: corpusIndexProjectionStates.generation,
      desiredAction: corpusIndexProjectionStates.desiredAction,
      desiredEpoch: corpusIndexProjectionStates.desiredEpoch,
      desiredFingerprint: corpusIndexProjectionStates.desiredFingerprint,
      desiredIndexId: corpusIndexProjectionStates.desiredIndexId,
    })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, subject.family),
        eq(corpusIndexProjectionStates.entityId, subject.entityId),
      ),
    )
    .for("update");
  const byGeneration = new Map(
    existing.map((state) => [state.generation, state]),
  );
  const projections = manifests.map(({ generation, manifest }) => ({
    generation,
    descriptor: deriveCorpusIndexProjectionDescriptor(manifest, locked.input),
  }));
  const existingDrifted = projections.some(({ generation, descriptor }) => {
    const state = byGeneration.get(generation);
    return (
      state !== undefined &&
      !desiredStateMatches(state, locked.epoch, descriptor)
    );
  });

  let epoch = locked.epoch;
  if (existingDrifted || epoch === 0n) {
    epoch += 1n;
    await setCanonicalProjectionEpoch(tx, subject, epoch);
  }

  const values = projections
    .filter(({ generation, descriptor }) => {
      const state = byGeneration.get(generation);
      return (
        existingDrifted ||
        state === undefined ||
        !desiredStateMatches(state, epoch, descriptor)
      );
    })
    .map(({ generation, descriptor }) =>
      buildCorpusIndexProjectionDesiredStateValues({
        subject,
        generation,
        epoch,
        descriptor,
      }),
    );
  await writeDesiredStates(tx, values);
  return {
    epoch,
    changed: values.length > 0,
    generationCount: manifests.length,
  };
};

/** Seed one newly registered generation without invalidating existing ones. */
export const ensureCorpusProjectionDesiredStateTx = async (
  tx: Transaction,
  subject: CorpusIndexProjectionSubject,
  generation: string,
): Promise<{ epoch: bigint; created: boolean }> => {
  const locked = await lockProjectionInput(tx, subject);
  const generationRows = await tx
    .select()
    .from(corpusIndexGenerations)
    .where(
      and(
        eq(corpusIndexGenerations.family, subject.family),
        eq(corpusIndexGenerations.generation, generation),
        or(
          eq(corpusIndexGenerations.status, "building"),
          eq(corpusIndexGenerations.status, "serving"),
        ),
      ),
    )
    .limit(1)
    .for("share");
  const generationRow = generationRows.at(0);
  if (generationRow === undefined) {
    return panic(
      `Active corpus generation is not registered: ${subject.family}/${generation}`,
    );
  }
  const manifest = verifiedManifest(generationRow);
  const descriptor = deriveCorpusIndexProjectionDescriptor(
    manifest,
    locked.input,
  );
  const existing = await tx
    .select({
      desiredAction: corpusIndexProjectionStates.desiredAction,
      desiredEpoch: corpusIndexProjectionStates.desiredEpoch,
      desiredFingerprint: corpusIndexProjectionStates.desiredFingerprint,
      desiredIndexId: corpusIndexProjectionStates.desiredIndexId,
    })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, subject.family),
        eq(corpusIndexProjectionStates.generation, generation),
        eq(corpusIndexProjectionStates.entityId, subject.entityId),
      ),
    )
    .limit(1)
    .for("update");
  const existingState = existing.at(0);
  if (existingState !== undefined) {
    const expectedFingerprint =
      descriptor.action === "upsert" ? descriptor.fingerprint : null;
    const expectedIndexId =
      descriptor.action === "upsert" ? descriptor.indexId : null;
    if (
      existingState.desiredEpoch !== locked.epoch ||
      existingState.desiredAction !== descriptor.action ||
      existingState.desiredFingerprint !== expectedFingerprint ||
      existingState.desiredIndexId !== expectedIndexId
    ) {
      return panic(
        `Existing corpus desired state does not match canonical input: ${subject.family}/${generation}/${subject.entityId}`,
      );
    }
    return { epoch: locked.epoch, created: false };
  }

  const epoch = locked.epoch === 0n ? 1n : locked.epoch;
  if (epoch !== locked.epoch) {
    await setCanonicalProjectionEpoch(tx, subject, epoch);
  }
  await writeDesiredStates(tx, [
    buildCorpusIndexProjectionDesiredStateValues({
      subject,
      generation,
      epoch,
      descriptor,
    }),
  ]);
  return { epoch, created: true };
};
