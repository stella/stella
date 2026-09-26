/**
 * The registry of index groups whose index the manifest cannot vouch for, and
 * the gate reads and writes of such a group pass.
 *
 * Two kinds of group are recorded (`RegisteredCorpusIndexGroup`). A group
 * under a contract of its own is neither read nor written until attested,
 * even under a generation that is already serving. A group under its
 * manifest's contract declared after the generation was created is reached by
 * generation-wide reads only once attested; its scoped reads and its writes
 * never wait on the registry. Groups the generation was created with never
 * touch it.
 *
 * An operator binds a group to its digest before creating the physical index,
 * then attests the group once the index is proven to carry that
 * configuration. Binding is compare-or-insert: a second bind with the same
 * digest converges, and one with another fails rather than overwriting.
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
  registeredCorpusIndexGroups,
  type CorpusIndexGroupContract,
  type CorpusIndexReadTarget,
  type RegisteredCorpusIndexGroup,
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

const requireRegisteredGroup = (
  target: CorpusIndexGroupTarget,
): RegisteredCorpusIndexGroup =>
  registeredCorpusIndexGroups(target.manifest).find(
    ({ indexGroup }) => indexGroup === target.indexGroup,
  ) ??
  panic(
    `Corpus index group is not one the registry records: ${target.manifest.generation}/${target.indexGroup}`,
  );

const enrollmentKey = ({ manifest, indexGroup }: CorpusIndexGroupTarget) =>
  and(
    eq(corpusIndexGroupEnrollments.family, manifest.family),
    eq(corpusIndexGroupEnrollments.generation, manifest.generation),
    eq(corpusIndexGroupEnrollments.indexGroup, indexGroup),
  );

/** A bound group's recorded digest differs from the one declared now. */
export class CorpusIndexGroupContractMismatchError extends TaggedError(
  "CorpusIndexGroupContractMismatchError",
)<{ message: string; indexId: string }> {}

export type CorpusIndexGroupEnrollment =
  typeof corpusIndexGroupEnrollments.$inferSelect;

/**
 * Bind a registered group of a registered, active generation to its declared
 * contract and digest. Replays converge on the same row; a row bound to
 * another index id, contract or digest fails closed.
 */
export const bindCorpusIndexGroupEnrollmentTx = async (
  tx: Transaction,
  target: CorpusIndexGroupTarget,
): Promise<CorpusIndexGroupEnrollment> => {
  const group = requireRegisteredGroup(target);
  const { family, generation } = group.manifest;
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
    ) !== corpusIndexManifestDigest(group.manifest)
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
      indexGroup: group.indexGroup,
      physicalIndexId: group.indexId,
      contractVersion: group.contractVersion,
      effectiveDigest: group.effectiveDigest,
      provisioningStatus: "pending",
    })
    .onConflictDoNothing();
  const row = (
    await tx
      .select()
      .from(corpusIndexGroupEnrollments)
      .where(enrollmentKey(group))
      .limit(1)
      .for("share")
  ).at(0);
  if (row === undefined) {
    return panic(`Corpus index group enrollment was lost: ${group.indexId}`);
  }
  if (
    row.physicalIndexId !== group.indexId ||
    row.contractVersion !== group.contractVersion ||
    row.effectiveDigest !== group.effectiveDigest
  ) {
    const message = `Corpus index group is bound to another contract: ${group.indexId}`;
    return panic(
      message,
      new CorpusIndexGroupContractMismatchError({
        message,
        indexId: group.indexId,
      }),
    );
  }
  return row;
};

export type CorpusIndexGroupReadiness =
  | { type: "base" }
  | { type: "attested" }
  | {
      type: "unready";
      reason: "unbound" | "pending" | "contract_mismatch";
    };

const readRegisteredGroupReadinessTx = async (
  tx: ReadTransaction,
  group: RegisteredCorpusIndexGroup,
): Promise<Exclude<CorpusIndexGroupReadiness, { type: "base" }>> => {
  const row = (
    await tx
      .select({
        effectiveDigest: corpusIndexGroupEnrollments.effectiveDigest,
        provisioningStatus: corpusIndexGroupEnrollments.provisioningStatus,
      })
      .from(corpusIndexGroupEnrollments)
      .where(enrollmentKey(group))
      .limit(1)
  ).at(0);
  if (row === undefined) {
    return { type: "unready", reason: "unbound" };
  }
  if (row.effectiveDigest !== group.effectiveDigest) {
    return { type: "unready", reason: "contract_mismatch" };
  }
  return row.provisioningStatus === "attested"
    ? { type: "attested" }
    : { type: "unready", reason: "pending" };
};

/**
 * Record that the group's physical index carries the configuration whose
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
  const group = requireRegisteredGroup(target);
  if (effectiveDigest !== group.effectiveDigest) {
    return panic(`Attested contract is not the declared one: ${group.indexId}`);
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
        enrollmentKey(group),
        eq(corpusIndexGroupEnrollments.effectiveDigest, effectiveDigest),
        eq(corpusIndexGroupEnrollments.provisioningStatus, "pending"),
      ),
    )
    .returning({ indexGroup: corpusIndexGroupEnrollments.indexGroup });
  if (attested.length === 1) {
    return;
  }
  const readiness = await readRegisteredGroupReadinessTx(tx, group);
  if (readiness.type !== "attested") {
    return panic(
      `Corpus index group cannot be attested (${readiness.reason}): ${group.indexId}`,
    );
  }
};

/**
 * Whether a group under a contract of its own may be read and written; a
 * group under its manifest's contract always may. Only the columns the public
 * reader may see are read, so request code and workers ask the same question.
 */
export const readCorpusIndexGroupReadinessTx = async (
  tx: ReadTransaction,
  contract: CorpusIndexGroupContract,
): Promise<CorpusIndexGroupReadiness> =>
  contract.type === "base"
    ? { type: "base" }
    : await readRegisteredGroupReadinessTx(tx, {
        manifest: contract.manifest,
        indexGroup: contract.indexGroup,
        indexId: contract.indexId,
        contractVersion: contract.type,
        effectiveDigest: contract.effectiveDigest,
      });

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
 * The registered groups of `manifest` whose current digest is attested.
 * Empty, with no read, for a manifest the registry records no group of.
 */
export const attestedCorpusIndexGroupsTx = async (
  tx: ReadTransaction,
  manifest: CorpusIndexManifest,
  { lock }: AttestedGroupsOptions = {},
): Promise<ReadonlySet<string>> => {
  const groups = registeredCorpusIndexGroups(manifest);
  if (groups.length === 0) {
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
          groups.map(({ indexGroup }) => indexGroup),
        ),
        eq(corpusIndexGroupEnrollments.provisioningStatus, "attested"),
      ),
    )
    .orderBy(corpusIndexGroupEnrollments.indexGroup)
    .limit(groups.length);
  const attested = lock === "share" ? await query.for("share") : await query;
  const digestOf = new Map(
    attested.map(({ indexGroup, effectiveDigest }) => [
      indexGroup,
      effectiveDigest,
    ]),
  );
  return new Set(
    groups
      .filter(
        ({ indexGroup, effectiveDigest }) =>
          digestOf.get(indexGroup) === effectiveDigest,
      )
      .map(({ indexGroup }) => indexGroup),
  );
};

/**
 * The physical indexes of `manifest` that no append may reach yet: every
 * group under a contract of its own without an attestation of it.
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
