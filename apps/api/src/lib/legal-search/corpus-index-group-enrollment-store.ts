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
import { panic, Result, TaggedError } from "better-result";
import { and, eq, inArray, or, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexGenerations,
  corpusIndexGroupEnrollments,
  corpusIndexGroupWithdrawals,
} from "@/api/db/schema";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import {
  type CorpusServingGenerationAbsentError,
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
class CorpusIndexGroupContractMismatchError extends TaggedError(
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

/** Who withdraws a group's attestation, and why. */
export type CorpusIndexGroupWithdrawal = {
  /**
   * The acting process or operator as its own runtime names it, e.g.
   * `service:corpus-index-group-provision@host`; lowercase, at most 128.
   */
  actor: string;
  reason: string;
};

const WITHDRAWAL_ACTOR = /^[a-z0-9][a-z0-9:._@/-]{0,127}$/u;

/** The trail's column width; a reason is a sentence, not a payload. */
const WITHDRAWAL_REASON_LIMIT = 2048;

/** A withdrawal was asked of a group whose attestation gates nothing. */
export class CorpusIndexGroupWithdrawalRefusedError extends TaggedError(
  "CorpusIndexGroupWithdrawalRefusedError",
)<{ message: string; indexId: string }> {}

/**
 * Withdraw a group's attestation: an attested row returns to `pending`, so
 * its scoped reads refuse, generation-wide reads leave its index out and no
 * append to it starts, until it is attested anew. The binding is left as it
 * is. Returns whether this call changed the row; an unbound or pending group
 * is not changed.
 *
 * Only a group under a contract of its own can be withdrawn. A group under
 * its manifest's contract is read by scope and appended to without asking
 * the registry, so a withdrawal would report a group out of service that
 * still serves; it is refused with `CorpusIndexGroupWithdrawalRefusedError`.
 *
 * Every withdrawal is attributed: the caller passes the actor its own
 * process establishes (never a value read from a request) and the reason,
 * and the transition is recorded in `corpus_index_group_withdrawals` in the
 * same transaction. A call that changes nothing records nothing.
 */
export const withdrawCorpusIndexGroupEnrollmentTx = async (
  tx: Transaction,
  {
    actor,
    reason,
    ...target
  }: CorpusIndexGroupTarget & CorpusIndexGroupWithdrawal,
): Promise<boolean> => {
  const group = requireRegisteredGroup(target);
  if (!WITHDRAWAL_ACTOR.test(actor)) {
    return panic(`Withdrawal actor is not an actor name: ${group.indexId}`);
  }
  const statedReason = reason.replaceAll("\u0000", "").trim();
  if (statedReason === "") {
    return panic(`Withdrawal needs a reason: ${group.indexId}`);
  }
  if (group.contractVersion === "base") {
    const message = `Corpus index group under its manifest's contract cannot be withdrawn: ${group.indexId}`;
    return panic(
      message,
      new CorpusIndexGroupWithdrawalRefusedError({
        message,
        indexId: group.indexId,
      }),
    );
  }
  const withdrawn = await tx
    .update(corpusIndexGroupEnrollments)
    .set({
      provisioningStatus: "pending",
      attestedAt: null,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        enrollmentKey(group),
        eq(corpusIndexGroupEnrollments.provisioningStatus, "attested"),
      ),
    )
    .returning({
      effectiveDigest: corpusIndexGroupEnrollments.effectiveDigest,
    });
  const [row] = withdrawn;
  if (withdrawn.length !== 1 || row === undefined) {
    return false;
  }
  // The trail names the contract the row was attested against, which differs
  // from the declared one when the declaration moved after the attestation.
  await tx.insert(corpusIndexGroupWithdrawals).values({
    family: group.manifest.family,
    generation: group.manifest.generation,
    indexGroup: group.indexGroup,
    effectiveDigest: row.effectiveDigest,
    actor,
    reason: statedReason.slice(0, WITHDRAWAL_REASON_LIMIT),
  });
  return true;
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

type CorpusIndexGroupRegistry = {
  /** Registered groups whose current digest is attested. */
  attested: ReadonlySet<string>;
  /** Registered groups with an enrollment row, whatever its state. */
  enrolled: ReadonlySet<string>;
};

/**
 * What the registry holds for `manifest`'s groups. Empty, with no read, for a
 * manifest the registry records no group of.
 */
const readCorpusIndexGroupRegistryTx = async (
  tx: ReadTransaction,
  manifest: CorpusIndexManifest,
  { lock }: AttestedGroupsOptions = {},
): Promise<CorpusIndexGroupRegistry> => {
  const groups = registeredCorpusIndexGroups(manifest);
  if (groups.length === 0) {
    return { attested: new Set(), enrolled: new Set() };
  }
  const query = tx
    .select({
      indexGroup: corpusIndexGroupEnrollments.indexGroup,
      effectiveDigest: corpusIndexGroupEnrollments.effectiveDigest,
      provisioningStatus: corpusIndexGroupEnrollments.provisioningStatus,
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
      ),
    )
    .orderBy(corpusIndexGroupEnrollments.indexGroup)
    .limit(groups.length);
  const rows = lock === "share" ? await query.for("share") : await query;
  const rowOf = new Map(rows.map((row) => [row.indexGroup, row]));
  return {
    attested: new Set(
      groups
        .filter(({ indexGroup, effectiveDigest }) => {
          const row = rowOf.get(indexGroup);
          return (
            row?.provisioningStatus === "attested" &&
            row.effectiveDigest === effectiveDigest
          );
        })
        .map(({ indexGroup }) => indexGroup),
    ),
    enrolled: new Set(rowOf.keys()),
  };
};

/** The registered groups of `manifest` whose current digest is attested. */
const attestedCorpusIndexGroupsTx = async (
  tx: ReadTransaction,
  manifest: CorpusIndexManifest,
  options: AttestedGroupsOptions = {},
): Promise<ReadonlySet<string>> =>
  (await readCorpusIndexGroupRegistryTx(tx, manifest, options)).attested;

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

/** Why a read of the serving generation reaches no index. */
export type ServingCorpusIndexTargetError =
  | CorpusServingGenerationAbsentError
  | CorpusIndexGroupNotReadyError;

/**
 * The serving generation and what a read of it reaches
 * (`corpusIndexReadTarget`). A family with no serving generation is refused
 * with `CorpusServingGenerationAbsentError`. A scoped read of a group that is
 * not attested is refused with `CorpusIndexGroupNotReadyError`, which each
 * caller answers as unavailable, rather than answering from an index nobody
 * proved: an empty or differently mapped index would read as a corpus with no
 * matches. A scoped read of a group under its manifest's contract reads no
 * enrollment.
 */
export const readServingCorpusIndexTargetTx = async (
  tx: ReadTransaction,
  {
    family,
    jurisdiction,
  }: { family: CorpusFamily; jurisdiction: string | undefined },
): Promise<Result<ServingCorpusIndexTarget, ServingCorpusIndexTargetError>> => {
  const servingRead = await readServingCorpusIndexGenerationTx(tx, family);
  if (Result.isError(servingRead)) {
    return Result.err(servingRead.error);
  }
  const serving = servingRead.value;
  const manifest = requireCorpusIndexManifest(family, serving.generation);
  const readsEnrollment =
    jurisdiction === undefined ||
    corpusIndexGroupContractForJurisdiction(manifest, jurisdiction).type !==
      "base";
  const registry: CorpusIndexGroupRegistry = readsEnrollment
    ? await readCorpusIndexGroupRegistryTx(tx, manifest)
    : { attested: new Set(), enrolled: new Set() };
  const resolution = corpusIndexReadTarget({
    manifest,
    jurisdiction,
    attestedGroups: registry.attested,
    enrolledGroups: registry.enrolled,
  });
  if (resolution.type === "unready") {
    const readiness = await readCorpusIndexGroupReadinessTx(
      tx,
      resolution.contract,
    );
    const reason = readiness.type === "unready" ? readiness.reason : "pending";
    return Result.err(
      new CorpusIndexGroupNotReadyError({
        message: `Corpus index group is not attested (${reason}): ${resolution.contract.indexId}`,
        indexId: resolution.contract.indexId,
        reason,
      }),
    );
  }
  return Result.ok({ serving, manifest, ...resolution.target });
};
