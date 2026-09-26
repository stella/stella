/**
 * The registry of index groups under a contract of their own, and the gate
 * every read and write of such a group passes.
 *
 * An operator binds a group to its effective contract before creating the
 * physical index, then attests the group once the index is proven to carry
 * that contract's configuration. Binding is compare-or-insert: a second bind
 * with the same contract converges, and one with another contract fails
 * rather than overwriting. Until the attestation a group is neither read nor
 * written, even under a generation that is already serving; groups under the
 * manifest's own contract never touch the registry.
 */
import { panic, TaggedError } from "better-result";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexGroupEnrollments,
} from "@/api/db/schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  readServingCorpusIndexGenerationTx,
  requireRegisteredCorpusIndexManifest,
  type ServingCorpusIndexGeneration,
} from "@/api/lib/legal-search/corpus-index-generation-store";
import {
  corpusIndexGroupContractForJurisdiction,
  corpusIndexReadTarget,
  enrolledCorpusIndexGroupContracts,
  resolveCorpusIndexGroupContract,
  type CorpusIndexGroupContract,
  type CorpusIndexReadTarget,
  type EnrolledGroupContract,
} from "@/api/lib/legal-search/corpus-index-group-contract";
import {
  corpusIndexManifestDigest,
  requireCorpusIndexManifest,
  type CorpusIndexManifest,
} from "@/api/lib/legal-search/corpus-index-manifest";

type CorpusIndexGroupTarget = {
  manifest: CorpusIndexManifest;
  indexGroup: string;
};

type ReadTransaction = Pick<Transaction, "select">;

const requireEnrolledContract = (
  target: CorpusIndexGroupTarget,
): EnrolledGroupContract => {
  const contract = resolveCorpusIndexGroupContract(target);
  return contract.type === "base"
    ? panic(
        `Corpus index group is under its manifest's contract: ${target.manifest.generation}/${target.indexGroup}`,
      )
    : contract;
};

const enrollmentKey = (contract: EnrolledGroupContract) =>
  and(
    eq(corpusIndexGroupEnrollments.family, contract.manifest.family),
    eq(corpusIndexGroupEnrollments.generation, contract.manifest.generation),
    eq(corpusIndexGroupEnrollments.indexGroup, contract.indexGroup),
  );

/** A bound group's recorded contract differs from the one declared now. */
export class CorpusIndexGroupContractMismatchError extends TaggedError(
  "CorpusIndexGroupContractMismatchError",
)<{ message: string; indexId: string }> {}

export type CorpusIndexGroupEnrollment =
  typeof corpusIndexGroupEnrollments.$inferSelect;

/**
 * Bind an enrolled group of a registered, active generation to its declared
 * contract. Replays converge on the same row; a row bound to another index id,
 * contract version or effective digest fails closed.
 */
export const bindCorpusIndexGroupEnrollmentTx = async (
  tx: Transaction,
  target: CorpusIndexGroupTarget,
): Promise<CorpusIndexGroupEnrollment> => {
  const contract = requireEnrolledContract(target);
  const { family, generation } = contract.manifest;
  const generationRow = (
    await tx
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
      .limit(1)
      .for("share")
  ).at(0);
  if (generationRow === undefined) {
    return panic(
      `Corpus index group needs an active generation: ${family}/${generation}`,
    );
  }
  if (
    corpusIndexManifestDigest(
      requireRegisteredCorpusIndexManifest(generationRow),
    ) !== corpusIndexManifestDigest(contract.manifest)
  ) {
    return panic(
      `Corpus index group manifest mismatch: ${family}/${generation}`,
    );
  }
  await tx
    .insert(corpusIndexGroupEnrollments)
    .values({
      family,
      generation,
      indexGroup: contract.indexGroup,
      physicalIndexId: contract.indexId,
      contractVersion: contract.type,
      effectiveDigest: contract.effectiveDigest,
      provisioningStatus: "pending",
    })
    .onConflictDoNothing();
  const row = (
    await tx
      .select()
      .from(corpusIndexGroupEnrollments)
      .where(enrollmentKey(contract))
      .limit(1)
      .for("share")
  ).at(0);
  if (row === undefined) {
    return panic(`Corpus index group enrollment was lost: ${contract.indexId}`);
  }
  if (
    row.physicalIndexId !== contract.indexId ||
    row.contractVersion !== contract.type ||
    row.effectiveDigest !== contract.effectiveDigest
  ) {
    const message = `Corpus index group is bound to another contract: ${contract.indexId}`;
    return panic(
      message,
      new CorpusIndexGroupContractMismatchError({
        message,
        indexId: contract.indexId,
      }),
    );
  }
  return row;
};

/**
 * Record that the group's physical index carries the effective contract whose
 * digest the operator verified. The digest must be the one declared and bound
 * now; attesting again converges, attesting anything else fails.
 */
export const attestCorpusIndexGroupEnrollmentTx = async (
  tx: Transaction,
  {
    effectiveDigest,
    ...target
  }: CorpusIndexGroupTarget & { effectiveDigest: string },
): Promise<void> => {
  const contract = requireEnrolledContract(target);
  if (effectiveDigest !== contract.effectiveDigest) {
    return panic(
      `Attested contract is not the declared one: ${contract.indexId}`,
    );
  }
  const attested = await tx
    .update(corpusIndexGroupEnrollments)
    .set({
      provisioningStatus: "attested",
      attestedAt: sql`clock_timestamp()`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        enrollmentKey(contract),
        eq(corpusIndexGroupEnrollments.effectiveDigest, effectiveDigest),
        eq(corpusIndexGroupEnrollments.provisioningStatus, "pending"),
      ),
    )
    .returning({ indexGroup: corpusIndexGroupEnrollments.indexGroup });
  if (attested.length === 1) {
    return;
  }
  const readiness = await readCorpusIndexGroupReadinessTx(tx, contract);
  if (readiness.type !== "attested") {
    return panic(
      `Corpus index group cannot be attested (${readiness.type === "unready" ? readiness.reason : readiness.type}): ${contract.indexId}`,
    );
  }
};

export type CorpusIndexGroupReadiness =
  | { type: "base" }
  | { type: "attested" }
  | {
      type: "unready";
      reason: "unbound" | "pending" | "contract_mismatch";
    };

/**
 * Whether a group may be read and written. Only the columns the public
 * reader may see are read, so request code and workers ask the same question.
 */
export const readCorpusIndexGroupReadinessTx = async (
  tx: ReadTransaction,
  contract: CorpusIndexGroupContract,
): Promise<CorpusIndexGroupReadiness> => {
  if (contract.type === "base") {
    return { type: "base" };
  }
  const row = (
    await tx
      .select({
        effectiveDigest: corpusIndexGroupEnrollments.effectiveDigest,
        provisioningStatus: corpusIndexGroupEnrollments.provisioningStatus,
      })
      .from(corpusIndexGroupEnrollments)
      .where(enrollmentKey(contract))
      .limit(1)
  ).at(0);
  if (row === undefined) {
    return { type: "unready", reason: "unbound" };
  }
  if (row.effectiveDigest !== contract.effectiveDigest) {
    return { type: "unready", reason: "contract_mismatch" };
  }
  return row.provisioningStatus === "attested"
    ? { type: "attested" }
    : { type: "unready", reason: "pending" };
};

/** A read or write reached a group whose index is not attested. */
export class CorpusIndexGroupNotReadyError extends TaggedError(
  "CorpusIndexGroupNotReadyError",
)<{
  message: string;
  indexId: string;
  reason: Extract<CorpusIndexGroupReadiness, { type: "unready" }>["reason"];
}> {}

type AttestedGroupsOptions = {
  /**
   * `share` holds each attested row until the transaction ends, so an
   * attestation withdrawn concurrently waits for the work checked against it.
   */
  lock?: "share";
};

/**
 * The enrolled groups of `manifest` whose current contract is attested. Empty,
 * with no read, for a manifest whose groups are all under its own contract.
 */
export const attestedCorpusIndexGroupsTx = async (
  tx: ReadTransaction,
  manifest: CorpusIndexManifest,
  { lock }: AttestedGroupsOptions = {},
): Promise<ReadonlySet<string>> => {
  const contracts = enrolledCorpusIndexGroupContracts(manifest);
  if (contracts.length === 0) {
    return new Set();
  }
  const query = tx
    .select({
      indexGroup: corpusIndexGroupEnrollments.indexGroup,
      effectiveDigest: corpusIndexGroupEnrollments.effectiveDigest,
    })
    .from(corpusIndexGroupEnrollments)
    .where(
      and(
        eq(corpusIndexGroupEnrollments.family, manifest.family),
        eq(corpusIndexGroupEnrollments.generation, manifest.generation),
        inArray(
          corpusIndexGroupEnrollments.indexGroup,
          contracts.map(({ indexGroup }) => indexGroup),
        ),
        eq(corpusIndexGroupEnrollments.provisioningStatus, "attested"),
      ),
    )
    .orderBy(corpusIndexGroupEnrollments.indexGroup)
    .limit(contracts.length);
  const attested = lock === "share" ? await query.for("share") : await query;
  const digestOf = new Map(
    attested.map(({ indexGroup, effectiveDigest }) => [
      indexGroup,
      effectiveDigest,
    ]),
  );
  return new Set(
    contracts
      .filter(
        ({ indexGroup, effectiveDigest }) =>
          digestOf.get(indexGroup) === effectiveDigest,
      )
      .map(({ indexGroup }) => indexGroup),
  );
};

/**
 * The physical indexes of `manifest` that no append may reach yet: every
 * enrolled group without an attestation of its current contract.
 */
export const unattestedCorpusIndexIdsTx = async (
  tx: ReadTransaction,
  manifest: CorpusIndexManifest,
  options: AttestedGroupsOptions = {},
): Promise<string[]> => {
  const attested = await attestedCorpusIndexGroupsTx(tx, manifest, options);
  return enrolledCorpusIndexGroupContracts(manifest)
    .filter(({ indexGroup }) => !attested.has(indexGroup))
    .map(({ indexId }) => indexId);
};

export type ServingCorpusIndexTarget = CorpusIndexReadTarget & {
  serving: ServingCorpusIndexGeneration;
  manifest: CorpusIndexManifest;
};

/**
 * The serving generation and what a read of it reaches
 * (`corpusIndexReadTarget`). A scoped read of a group that is not attested
 * refuses as unavailable rather than answering from an index nobody proved:
 * an empty or differently mapped index would read as a corpus with no
 * matches. A scoped read of a group under its manifest's contract reads no
 * enrollment.
 */
export const readServingCorpusIndexTargetTx = async (
  tx: ReadTransaction,
  {
    family,
    jurisdiction,
  }: { family: CorpusFamily; jurisdiction: string | undefined },
): Promise<ServingCorpusIndexTarget> => {
  const serving = await readServingCorpusIndexGenerationTx(tx, family);
  const manifest = requireCorpusIndexManifest(family, serving.generation);
  const readsEnrollment =
    jurisdiction === undefined ||
    corpusIndexGroupContractForJurisdiction(manifest, jurisdiction).type !==
      "base";
  const resolution = corpusIndexReadTarget({
    manifest,
    jurisdiction,
    attestedGroups: readsEnrollment
      ? await attestedCorpusIndexGroupsTx(tx, manifest)
      : new Set(),
  });
  if (resolution.type === "unready") {
    const readiness = await readCorpusIndexGroupReadinessTx(
      tx,
      resolution.contract,
    );
    const reason = readiness.type === "unready" ? readiness.reason : "pending";
    throw new HandlerError({
      status: 503,
      message: "Search is temporarily unavailable",
      cause: new CorpusIndexGroupNotReadyError({
        message: `Corpus index group is not attested (${reason}): ${resolution.contract.indexId}`,
        indexId: resolution.contract.indexId,
        reason,
      }),
    });
  }
  return { serving, manifest, ...resolution.target };
};
