import { panic } from "better-result";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import {
  corpusIndexProjectionIntents,
  corpusIndexProjectionStates,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import type { CorpusFamily } from "@/api/lib/legal-search/corpus-generation-contract";
import { CORPUS_INDEX_APPEND_PRODUCING_INTENT_STATUSES } from "@/api/lib/legal-search/corpus-index-projection-contract";
import { lockRegisteredCorpusProjectionManifestForMutation } from "@/api/lib/legal-search/corpus-index-projection-desired-state";
import { corpusIndexUnknownAppendBarrierAt } from "@/api/lib/legal-search/corpus-index-projection-engine";
import { corpusProjectionAcceptedAppendCleanupFence } from "@/api/lib/legal-search/corpus-index-projection-publish-fence";
import {
  CORPUS_PROJECTION_GENERATION_SCOPE,
  entityIdsForCorpusProjectionWorkScope,
  type CorpusProjectionScopedWorkOptions,
} from "@/api/lib/legal-search/corpus-index-projection-scope";
import { sqlCaseFragment } from "@/api/lib/sql-case-expression";

export const CORPUS_PROJECTION_ERASURE_MAX_BATCH_SIZE = 256;
export const CORPUS_PROJECTION_ERASURE_MAX_REVISIONS = 1024;

type ProjectionIntentId = SafeId<"corpusIndexProjectionIntent">;

type AdvanceCorpusProjectionErasuresOptions<Family extends CorpusFamily> =
  CorpusProjectionScopedWorkOptions<Family> & {
    generation: string;
    limit: number;
    testNow?: Date;
  };

export type AdvanceCorpusProjectionErasuresResult = {
  claimedCount: number;
  cancelledRevisions: ProjectionIntentId[];
  scheduledRevisions: ProjectionIntentId[];
  appliedEntityIds: string[];
};

const validateLimit = (limit: number): number => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > CORPUS_PROJECTION_ERASURE_MAX_BATCH_SIZE
  ) {
    return panic(
      `Corpus projection erasure batch size must be an integer from 1 to ${CORPUS_PROJECTION_ERASURE_MAX_BATCH_SIZE}`,
    );
  }
  return limit;
};

/**
 * Fence every pre-erasure append, then mark erasure applied only after each
 * exact revision is terminal. Engine I/O happens in the separate cleanup
 * phase; this transaction only advances durable state.
 */
export const advanceCorpusProjectionErasuresTx = async <
  Family extends CorpusFamily,
>(
  tx: Transaction,
  {
    family,
    generation,
    limit: requestedLimit,
    scope = CORPUS_PROJECTION_GENERATION_SCOPE,
    testNow,
  }: AdvanceCorpusProjectionErasuresOptions<Family>,
): Promise<AdvanceCorpusProjectionErasuresResult> => {
  const limit = validateLimit(requestedLimit);
  const scopedEntityIds = entityIdsForCorpusProjectionWorkScope(scope);
  const manifest = await lockRegisteredCorpusProjectionManifestForMutation(
    tx,
    family,
    generation,
  );
  const states = await tx
    .select({
      entityId: corpusIndexProjectionStates.entityId,
      desiredEpoch: corpusIndexProjectionStates.desiredEpoch,
    })
    .from(corpusIndexProjectionStates)
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        scopedEntityIds === null
          ? undefined
          : inArray(corpusIndexProjectionStates.entityId, scopedEntityIds),
        eq(corpusIndexProjectionStates.desiredAction, "erase"),
        sql`(
          ${corpusIndexProjectionStates.appliedAction} IS DISTINCT FROM 'erase'
          OR ${corpusIndexProjectionStates.appliedEpoch} IS DISTINCT FROM ${corpusIndexProjectionStates.desiredEpoch}
        )`,
      ),
    )
    .orderBy(
      asc(corpusIndexProjectionStates.updatedAt),
      asc(corpusIndexProjectionStates.entityId),
    )
    .limit(limit)
    .for("update", {
      of: corpusIndexProjectionStates,
      skipLocked: true,
    });
  if (states.length === 0) {
    return {
      claimedCount: 0,
      cancelledRevisions: [],
      scheduledRevisions: [],
      appliedEntityIds: [],
    };
  }
  const entityIds = states.map(({ entityId }) => entityId);
  const intents = await tx
    .select({
      id: corpusIndexProjectionIntents.id,
      status: corpusIndexProjectionIntents.status,
      appendStartedAt: corpusIndexProjectionIntents.appendStartedAt,
    })
    .from(corpusIndexProjectionIntents)
    .innerJoin(
      corpusIndexProjectionStates,
      and(
        eq(
          corpusIndexProjectionStates.family,
          corpusIndexProjectionIntents.family,
        ),
        eq(
          corpusIndexProjectionStates.generation,
          corpusIndexProjectionIntents.generation,
        ),
        eq(
          corpusIndexProjectionStates.entityId,
          corpusIndexProjectionIntents.entityId,
        ),
      ),
    )
    .where(
      and(
        eq(corpusIndexProjectionIntents.family, family),
        eq(corpusIndexProjectionIntents.generation, generation),
        inArray(corpusIndexProjectionIntents.entityId, entityIds),
        sql`${corpusIndexProjectionIntents.epoch} <= ${corpusIndexProjectionStates.desiredEpoch}`,
        inArray(
          corpusIndexProjectionIntents.status,
          CORPUS_INDEX_APPEND_PRODUCING_INTENT_STATUSES,
        ),
      ),
    )
    .orderBy(asc(corpusIndexProjectionIntents.id))
    .limit(CORPUS_PROJECTION_ERASURE_MAX_REVISIONS)
    .for("update", { of: corpusIndexProjectionIntents });

  const transitionAt = testNow ?? sql<Date>`clock_timestamp()`;

  // Every inspected state advances to the tail of the durable pending queue.
  // Cleanup-owned rows therefore cannot make a fixed old prefix hide later
  // erasures, while each transaction still examines at most `limit` rows.
  await tx
    .update(corpusIndexProjectionStates)
    .set({ updatedAt: transitionAt })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        inArray(corpusIndexProjectionStates.entityId, entityIds),
      ),
    );

  const reserved = intents.filter(({ status }) => status === "reserved");
  if (reserved.length > 0) {
    await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "cancelled",
        leaseToken: null,
        leaseExpiresAt: null,
        cancelledAt: transitionAt,
        lastError: "projection reservation cancelled by erasure",
        updatedAt: transitionAt,
      })
      .where(
        and(
          inArray(
            corpusIndexProjectionIntents.id,
            reserved.map(({ id }) => id),
          ),
          eq(corpusIndexProjectionIntents.status, "reserved"),
        ),
      );
  }

  const unknownAppends = intents.filter(
    ({ status }) => status === "append_started",
  );
  if (unknownAppends.length > 0) {
    const barriers = unknownAppends.map(({ id, appendStartedAt }) => {
      if (appendStartedAt === null) {
        return panic(`Append-started projection intent has no start: ${id}`);
      }
      return {
        id,
        barrier: corpusIndexUnknownAppendBarrierAt(appendStartedAt, manifest),
      };
    });
    const barrierSql = sqlCaseFragment({
      operand: sql`${corpusIndexProjectionIntents.id}`,
      branches: barriers.map(
        ({ id, barrier }) => sql`WHEN ${id} THEN ${barrier}::timestamptz`,
      ),
      fallback: sql`${corpusIndexProjectionIntents.appendPublishBarrierAt}`,
    });
    await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "cleanup_pending",
        leaseToken: null,
        leaseExpiresAt: null,
        appendPublishBarrierAt: barrierSql,
        cleanupNotBefore: barrierSql,
        lastError: "projection append fenced by erasure",
        updatedAt: transitionAt,
      })
      .where(
        and(
          inArray(
            corpusIndexProjectionIntents.id,
            unknownAppends.map(({ id }) => id),
          ),
          eq(corpusIndexProjectionIntents.status, "append_started"),
        ),
      );
  }

  const knownAppends = intents.filter(
    ({ status }) => status === "append_committed" || status === "applied",
  );
  if (knownAppends.length > 0) {
    await tx
      .update(corpusIndexProjectionIntents)
      .set({
        status: "cleanup_pending",
        leaseToken: null,
        leaseExpiresAt: null,
        ...corpusProjectionAcceptedAppendCleanupFence(manifest, transitionAt),
        lastError: "projection revision scheduled by erasure",
        updatedAt: transitionAt,
      })
      .where(
        and(
          inArray(
            corpusIndexProjectionIntents.id,
            knownAppends.map(({ id }) => id),
          ),
          inArray(corpusIndexProjectionIntents.status, [
            "append_committed",
            "applied",
          ]),
        ),
      );
  }

  const applied = await tx
    .update(corpusIndexProjectionStates)
    .set({
      appliedAction: "erase",
      appliedEpoch: sql`${corpusIndexProjectionStates.desiredEpoch}`,
      appliedRevision: null,
      appliedFingerprint: null,
      appliedIndexId: null,
      appliedAt: transitionAt,
      updatedAt: transitionAt,
    })
    .where(
      and(
        eq(corpusIndexProjectionStates.family, family),
        eq(corpusIndexProjectionStates.generation, generation),
        inArray(corpusIndexProjectionStates.entityId, entityIds),
        eq(corpusIndexProjectionStates.desiredAction, "erase"),
        sql`NOT EXISTS (
          SELECT 1
          FROM ${corpusIndexProjectionIntents} outstanding
          WHERE outstanding.family = ${corpusIndexProjectionStates.family}
            AND outstanding.generation = ${corpusIndexProjectionStates.generation}
            AND outstanding.entity_id = ${corpusIndexProjectionStates.entityId}
            AND outstanding.epoch <= ${corpusIndexProjectionStates.desiredEpoch}
            AND outstanding.status NOT IN ('settled', 'cancelled')
        )`,
      ),
    )
    .returning({ entityId: corpusIndexProjectionStates.entityId });

  return {
    claimedCount: states.length,
    cancelledRevisions: reserved.map(({ id }) => id),
    scheduledRevisions: [...unknownAppends, ...knownAppends].map(
      ({ id }) => id,
    ),
    appliedEntityIds: applied.map(({ entityId }) => entityId),
  };
};
