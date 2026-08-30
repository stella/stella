import { Result, UnhandledException, panic } from "better-result";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";

import { rootDb } from "@/api/db/root";
import { emailIngestEffects } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { errorTag } from "@/api/lib/errors/utils";
import {
  enqueueImageThumbnailOrMarkFailed,
  enqueuePdfDerivativeOrMarkFailed,
} from "@/api/lib/file-derivative-queue";
import { maybeStartUploadTriggeredFlows } from "@/api/lib/flows/maybe-start-upload-triggered-flows";
import type { SchedulerTask } from "@/api/lib/scheduler/types";
import { processExtraction } from "@/api/lib/search/process-extraction";

export const DRAIN_EMAIL_INGEST_EFFECTS_TASK =
  "uploads.drainEmailIngestEffects" as const;

const EFFECT_BATCH_SIZE = 32;
const EFFECT_CONCURRENCY = 4;
const EFFECT_LEASE_MS = 15 * 60_000;
const EFFECT_HEARTBEAT_MS = EFFECT_LEASE_MS / 3;
const EFFECT_MAX_ATTEMPTS = 12;
const RETRY_BASE_SECONDS = 30;
const RETRY_MAX_SECONDS = 6 * 60 * 60;

type ClaimedEffect = typeof emailIngestEffects.$inferSelect;

export type EmailIngestEffectsDatabase = Pick<
  typeof rootDb,
  "transaction" | "update"
>;

export type EmailIngestEffectOperations = {
  processExtraction: typeof processExtraction;
  maybeStartUploadTriggeredFlows: typeof maybeStartUploadTriggeredFlows;
  enqueuePdfDerivativeOrMarkFailed: typeof enqueuePdfDerivativeOrMarkFailed;
  enqueueImageThumbnailOrMarkFailed: typeof enqueueImageThumbnailOrMarkFailed;
};

const defaultOperations: EmailIngestEffectOperations = {
  processExtraction,
  maybeStartUploadTriggeredFlows,
  enqueuePdfDerivativeOrMarkFailed,
  enqueueImageThumbnailOrMarkFailed,
};

export const getEmailIngestEffectRetryAt = ({
  attemptCount,
  now,
  random = Math.random,
}: {
  attemptCount: number;
  now: Date;
  random?: () => number;
}): Date => {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 30);
  const seconds = Math.min(
    RETRY_BASE_SECONDS * 2 ** exponent,
    RETRY_MAX_SECONDS,
  );
  const boundedRandom = Math.min(Math.max(random(), 0), 1);
  const jitteredSeconds = seconds * (0.5 + boundedRandom * 0.5);
  return new Date(now.getTime() + jitteredSeconds * 1000);
};

const claimEffects = async (
  database: EmailIngestEffectsDatabase,
  sourceUploadId?: SafeId<"pendingUpload">,
): Promise<ClaimedEffect[]> => {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - EFFECT_LEASE_MS);
  const claimToken = Bun.randomUUIDv7();
  return await database.transaction(async (tx) => {
    const due = or(
      eq(emailIngestEffects.status, "pending"),
      and(
        eq(emailIngestEffects.status, "failed"),
        lte(emailIngestEffects.nextAttemptAt, now),
      ),
      and(
        eq(emailIngestEffects.status, "processing"),
        sql`${emailIngestEffects.claimedAt} <= ${staleBefore}::timestamptz`,
      ),
    );
    const candidates = await tx
      .select({
        entityId: emailIngestEffects.entityId,
        kind: emailIngestEffects.kind,
        sourceUploadId: emailIngestEffects.sourceUploadId,
      })
      .from(emailIngestEffects)
      .where(
        sourceUploadId
          ? and(eq(emailIngestEffects.sourceUploadId, sourceUploadId), due)
          : due,
      )
      .orderBy(
        asc(emailIngestEffects.createdAt),
        asc(emailIngestEffects.entityId),
        asc(emailIngestEffects.kind),
      )
      .limit(EFFECT_BATCH_SIZE)
      .for("update", { skipLocked: true });
    if (candidates.length === 0) {
      return [];
    }
    const identities = candidates.map(
      (candidate) =>
        sql`(${candidate.sourceUploadId}, ${candidate.entityId}, ${candidate.kind})`,
    );
    return await tx
      .update(emailIngestEffects)
      .set({
        attemptCount: sql`${emailIngestEffects.attemptCount} + 1`,
        claimedAt: now,
        claimToken,
        lastErrorType: null,
        status: "processing",
        updatedAt: now,
      })
      .where(
        sql`(${emailIngestEffects.sourceUploadId}, ${emailIngestEffects.entityId}, ${emailIngestEffects.kind}) IN (${sql.join(identities, sql`, `)})`,
      )
      .returning();
  });
};

const claimedEffectIdentity = (effect: ClaimedEffect) => {
  if (!effect.claimToken) {
    return panic("Processing email ingest effect has no claim token");
  }
  return and(
    eq(emailIngestEffects.sourceUploadId, effect.sourceUploadId),
    eq(emailIngestEffects.entityId, effect.entityId),
    eq(emailIngestEffects.kind, effect.kind),
    eq(emailIngestEffects.status, "processing"),
    eq(emailIngestEffects.attemptCount, effect.attemptCount),
    eq(emailIngestEffects.claimToken, effect.claimToken),
  );
};

const refreshClaim = async (
  database: EmailIngestEffectsDatabase,
  effect: ClaimedEffect,
): Promise<boolean> => {
  const refreshedAt = new Date();
  const refreshed = await database
    .update(emailIngestEffects)
    .set({ claimedAt: refreshedAt, updatedAt: refreshedAt })
    .where(claimedEffectIdentity(effect))
    .returning({ sourceUploadId: emailIngestEffects.sourceUploadId });
  return refreshed.length === 1;
};

const runEffect = async (
  effect: ClaimedEffect,
  operations: EmailIngestEffectOperations,
): Promise<void> => {
  const derivativeArgs = {
    encrypted: effect.encrypted,
    entityId: effect.entityId,
    fieldId: effect.fieldId,
    mimeType: effect.mimeType,
    organizationId: effect.organizationId,
    userId: effect.userId,
    workspaceId: effect.workspaceId,
  };
  switch (effect.kind) {
    case "extract":
      await operations.processExtraction(effect.entityId);
      return;
    case "start_flows":
      await operations.maybeStartUploadTriggeredFlows({
        entityId: effect.entityId,
        fileName: effect.fileName,
        failureMode: "throw",
        idempotencyKey: [effect.sourceUploadId, effect.entityId].join(":"),
        organizationId: effect.organizationId,
        workspaceId: effect.workspaceId,
      });
      return;
    case "pdf_derivative":
      await operations.enqueuePdfDerivativeOrMarkFailed(derivativeArgs);
      return;
    case "thumbnail_derivative":
      await operations.enqueueImageThumbnailOrMarkFailed(derivativeArgs);
      return;
    default:
      return effect.kind satisfies never;
  }
};

type ProcessClaimedEmailIngestEffectOptions = {
  database?: EmailIngestEffectsDatabase;
  effect: ClaimedEffect;
  operations?: EmailIngestEffectOperations;
};

export const processClaimedEmailIngestEffect = async ({
  database = rootDb,
  effect,
  operations = defaultOperations,
}: ProcessClaimedEmailIngestEffectOptions): Promise<boolean> => {
  if (!(await refreshClaim(database, effect))) {
    return false;
  }
  const heartbeat = setInterval(() => {
    refreshClaim(database, effect).catch((error: unknown) =>
      captureError(error, {
        effectKind: effect.kind,
        entityId: effect.entityId,
        operation: "email_ingest_effect_heartbeat",
        sourceUploadId: effect.sourceUploadId,
        workspaceId: effect.workspaceId,
      }),
    );
  }, EFFECT_HEARTBEAT_MS);
  heartbeat.unref();
  const outcome = await Result.tryPromise({
    try: async () => await runEffect(effect, operations),
    catch: (cause) =>
      cause instanceof Error ? cause : new UnhandledException({ cause }),
  }).finally(() => clearInterval(heartbeat));
  const identity = claimedEffectIdentity(effect);
  if (Result.isOk(outcome)) {
    await database
      .update(emailIngestEffects)
      .set({
        completedAt: new Date(),
        claimedAt: null,
        claimToken: null,
        lastErrorType: null,
        status: "completed",
        updatedAt: new Date(),
      })
      .where(identity);
    return true;
  }

  captureError(outcome.error, {
    effectKind: effect.kind,
    entityId: effect.entityId,
    sourceUploadId: effect.sourceUploadId,
    workspaceId: effect.workspaceId,
  });
  const failedAt = new Date();
  const exhausted = effect.attemptCount >= EFFECT_MAX_ATTEMPTS;
  await database
    .update(emailIngestEffects)
    .set({
      claimedAt: null,
      claimToken: null,
      lastErrorType: errorTag(outcome.error).slice(0, 128),
      nextAttemptAt: getEmailIngestEffectRetryAt({
        attemptCount: effect.attemptCount,
        now: failedAt,
      }),
      status: exhausted ? "exhausted" : "failed",
      updatedAt: failedAt,
    })
    .where(identity);
  return false;
};

type DrainEmailIngestEffectsOptions = {
  database?: EmailIngestEffectsDatabase;
  operations?: EmailIngestEffectOperations;
  signal?: AbortSignal;
  sourceUploadId?: SafeId<"pendingUpload">;
};

export const drainEmailIngestEffects = async ({
  database = rootDb,
  operations = defaultOperations,
  signal,
  sourceUploadId,
}: DrainEmailIngestEffectsOptions = {}): Promise<{
  completed: number;
  failed: number;
}> => {
  if (signal?.aborted) {
    return { completed: 0, failed: 0 };
  }
  const claims = await claimEffects(database, sourceUploadId);
  let next = 0;
  let completed = 0;
  let failed = 0;
  const worker = async (): Promise<void> => {
    const claim = claims.at(next);
    next += 1;
    if (!claim || signal?.aborted) {
      return;
    }
    if (
      await processClaimedEmailIngestEffect({
        database,
        effect: claim,
        operations,
      })
    ) {
      completed += 1;
    } else {
      failed += 1;
    }
    await worker();
  };
  await Promise.all(
    Array.from({ length: Math.min(EFFECT_CONCURRENCY, claims.length) }, worker),
  );
  return { completed, failed };
};

export const drainEmailIngestEffectsTask: SchedulerTask = async ({
  logger,
  signal,
}) => {
  const result = await drainEmailIngestEffects({ signal });
  if (result.completed + result.failed > 0) {
    logger.info("uploads.email_ingest_effects_drained", result);
  }
  if (result.failed > 0) {
    logger.warn("uploads.email_ingest_effects_failed", {
      failed: result.failed,
    });
  }
};
