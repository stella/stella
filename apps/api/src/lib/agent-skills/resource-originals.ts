import { panic, Result } from "better-result";
import { and, eq, isNotNull } from "drizzle-orm";

import { sha256Hex } from "@stll/sha256/bun";

import type { Transaction } from "@/api/db/root";
import type { SafeDb } from "@/api/db/safe-db";
import { agentSkillResources } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockObjectCleanupIntentsForWriter,
  lockOrganizationObjectIntentsForWriter,
  reserveObjectCleanupIntents,
  retirePublishedObjectCleanupIntentsInTransaction,
  settleObjectCleanupIntentsAfterWriter,
} from "@/api/lib/buffer-intent-reconciliation";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import {
  organizationFileUsageHandlerError,
  writeOrganizationFiles,
} from "@/api/lib/files/organization-file-usage";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  S3_OBJECT_WRITE_CERTAINTY,
  type S3ObjectWriteCertainty,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";

const abandonSettlementFailure = failureSink({
  event: "agent_skills.original_abandon_settlement_failed",
  expected: [],
});

/**
 * A skill file's original: the bytes it was uploaded or imported with, kept
 * in object storage beside the row's text so an export hands them back
 * unchanged. Keys live under the organization's prefix, one fresh key per
 * file (`{org}/agent-skills/originals/{uuid}`), never named by two rows (a
 * cleanup intent cannot reserve a key a file names), and triggers on the row
 * queue the object for erasure when the row is deleted or its original dropped.
 */
export type SkillResourceOriginal = {
  mediaType: string;
  s3Key: string;
  sha256: string;
  sizeBytes: number;
};

/** One file whose original is to be stored, at its path in the skill. */
export type SkillResourceOriginalFile = {
  bytes: Uint8Array;
  mediaType: string;
  path: string;
};

/** Originals written to storage and not yet named by a committed row. */
type StoredSkillResourceOriginals = {
  intentIds: SafeId<"pendingUpload">[];
  organizationId: SafeId<"organization">;
  originals: ReadonlyMap<string, SkillResourceOriginal>;
};

const skillOriginalObjectKey = (organizationId: SafeId<"organization">) =>
  `${organizationId}/agent-skills/originals/${Bun.randomUUIDv7()}`;

const KIB = 1024;

const formatSize = (sizeBytes: number) =>
  sizeBytes < KIB * KIB
    ? `${String(Math.max(1, Math.round(sizeBytes / KIB)))} KB`
    : `${(sizeBytes / (KIB * KIB)).toFixed(1)} MB`;

/**
 * The text a file without text is stored with, so every reader (a model,
 * the editor, an MCP read) is told what the file is instead of shown its
 * bytes. Writing other text over it makes the file a text file: the original
 * is dropped with the old text.
 */
export const binarySkillResourceText = ({
  mediaType,
  path,
  sizeBytes,
}: {
  mediaType: string;
  path: string;
  sizeBytes: number;
}) =>
  `${path} is a binary file (${mediaType}, ${formatSize(sizeBytes)}). It has no text to read; its bytes are kept with the skill and included when the skill is exported.\n`;

/**
 * Write originals to object storage before the transaction that stores the
 * rows naming them. Each key is first reserved for crash recovery, so an
 * object whose row never commits is erased; the bytes count toward the
 * organization's storage. Nothing is written for an empty list.
 */
export const storeSkillResourceOriginals = async ({
  files,
  organizationId,
  safeDb,
  writeObject = writeS3ObjectWithRetry,
}: {
  files: readonly SkillResourceOriginalFile[];
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  writeObject?: typeof writeS3ObjectWithRetry;
}): Promise<Result<StoredSkillResourceOriginals, HandlerError>> => {
  const keyed = files.map((file) => ({
    ...file,
    s3Key: skillOriginalObjectKey(organizationId),
  }));
  const [first, ...rest] = keyed.map(({ s3Key }) => s3Key);
  if (first === undefined) {
    return Result.ok({ intentIds: [], organizationId, originals: new Map() });
  }
  const reserved = await reserveObjectCleanupIntents({
    objectKeys: [first, ...rest],
    organizationId,
    safeDb,
    workspaceIds: [],
  });
  if (Result.isError(reserved)) {
    return Result.err(
      new HandlerError({
        status: 500,
        message: "Could not reserve storage for the skill's files",
        cause: reserved.error,
      }),
    );
  }
  const intentIds = [...reserved.value.values()].flat();
  const stored: StoredSkillResourceOriginals = {
    intentIds,
    organizationId,
    originals: new Map(),
  };
  // One accounting call for every file: the quota is checked against the
  // whole set, and each object is written under its own recovery intent.
  const hashed = keyed.map((file) => ({
    ...file,
    intent:
      reserved.value.get(file.s3Key) ??
      panic("An original's key was reserved without an intent"),
    sha256: sha256Hex(file.bytes),
  }));
  const writes = await writeOrganizationFiles<
    S3ObjectWriteCertainty,
    (typeof hashed)[number]
  >(
    hashed.map((file) => ({
      content: file,
      contentSha256Hex: file.sha256,
      objectKey: file.s3Key,
      organizationId,
      sizeBytes: file.bytes.byteLength,
      write: async ({ content, objectKey }) =>
        await writeObject(
          {
            contentType: content.mediaType,
            data: content.bytes,
            key: objectKey,
          },
          { type: "cleanup-intent", intent: content.intent },
        ),
    })),
  );
  if (Result.isError(writes)) {
    await abandonSkillResourceOriginals({ safeDb, stored });
    return Result.err(organizationFileUsageHandlerError(writes.error));
  }
  // The first file, in order, that was not stored decides the error; every
  // object of a failed set is left to recovery.
  const failure = writes.value
    .map((written) => {
      if (Result.isError(written)) {
        return organizationFileUsageHandlerError(written.error);
      }
      // A timed-out PUT may still land: leave its intent to recovery.
      return written.value === S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN
        ? new HandlerError({
            status: 503,
            code: "upstream_unavailable",
            message:
              "Storing the skill's file could not be confirmed. Retry the operation.",
          })
        : null;
    })
    .find((error) => error !== null);
  if (failure !== undefined) {
    await abandonSkillResourceOriginals({ safeDb, stored });
    return Result.err(failure);
  }
  const originals = new Map<string, SkillResourceOriginal>(
    hashed.map((file) => [
      file.path,
      {
        mediaType: file.mediaType,
        s3Key: file.s3Key,
        sha256: file.sha256,
        sizeBytes: file.bytes.byteLength,
      },
    ]),
  );
  return Result.ok({ ...stored, originals });
};

/**
 * Hand the originals over to the rows that name them, first thing in the
 * transaction that inserts those rows (the organization intent lock comes
 * before any row lock): from its commit on, the rows' triggers own the
 * objects' erasure. A rollback leaves the recovery intents in place.
 */
export const publishSkillResourceOriginals = async (
  tx: Transaction,
  stored: StoredSkillResourceOriginals,
): Promise<void> => {
  if (stored.intentIds.length === 0) {
    return;
  }
  await lockOrganizationObjectIntentsForWriter(tx, stored.organizationId);
  await lockObjectCleanupIntentsForWriter(tx, stored.intentIds);
  await retirePublishedObjectCleanupIntentsInTransaction({
    intentIds: stored.intentIds,
    tx,
  });
};

/**
 * Give up originals whose rows were never stored: recovery erases them. Safe
 * after a commit too, as published intents are gone and nothing is touched.
 */
export const abandonSkillResourceOriginals = async ({
  safeDb,
  stored,
}: {
  safeDb: SafeDb;
  stored: StoredSkillResourceOriginals;
}): Promise<void> => {
  if (stored.intentIds.length === 0) {
    return;
  }
  // A failure leaves the intents writing; recovery takes them over once
  // their deadline passes, so the objects are erased either way. It is
  // reported, not returned: the caller is already failing.
  const settled = await settleObjectCleanupIntentsAfterWriter({
    intentIds: stored.intentIds,
    objectState: "cleanup-required",
    safeDb,
  });
  if (Result.isError(settled)) {
    observeFailure(settled.error, {
      sink: abandonSettlementFailure,
      ctx: { organizationId: stored.organizationId },
    });
  }
};

/** The original columns of a row that stores one; spread into its insert. */
export const originalColumns = (original: SkillResourceOriginal) => ({
  originalMediaType: original.mediaType,
  originalS3Key: original.s3Key,
  originalSha256: original.sha256,
  originalSizeBytes: original.sizeBytes,
});

/**
 * A row's original, from its four original columns as selected: absent when
 * the file was only ever text. Every write sets and clears the columns
 * together, so a partial set is a broken invariant.
 */
export const originalFromColumns = ({
  mediaType,
  s3Key,
  sha256,
  sizeBytes,
}: {
  mediaType: string | null;
  s3Key: string | null;
  sha256: string | null;
  sizeBytes: number | null;
}): SkillResourceOriginal | undefined => {
  if (
    mediaType === null &&
    s3Key === null &&
    sha256 === null &&
    sizeBytes === null
  ) {
    return undefined;
  }
  if (
    mediaType === null ||
    s3Key === null ||
    sha256 === null ||
    sizeBytes === null
  ) {
    return panic("A skill file's original columns are set together");
  }
  return { mediaType, s3Key, sha256, sizeBytes };
};

/**
 * Every original a skill's files keep, by file path, read in the caller's
 * transaction (so under its row security and with the rest of its read).
 * Files that were only ever text are absent.
 */
export const readSkillResourceOriginals = async (
  tx: Transaction,
  skillId: SafeId<"agentSkill">,
): Promise<Map<string, SkillResourceOriginal>> => {
  const rows = await tx
    .select({
      mediaType: agentSkillResources.originalMediaType,
      path: agentSkillResources.path,
      s3Key: agentSkillResources.originalS3Key,
      sha256: agentSkillResources.originalSha256,
      sizeBytes: agentSkillResources.originalSizeBytes,
    })
    .from(agentSkillResources)
    .where(
      and(
        eq(agentSkillResources.skillId, skillId),
        isNotNull(agentSkillResources.originalS3Key),
      ),
    );
  const originals = new Map<string, SkillResourceOriginal>();
  for (const { path, ...columns } of rows) {
    const original = originalFromColumns(columns);
    if (original === undefined) {
      return panic("A skill file's original columns are set together");
    }
    originals.set(path, original);
  }
  return originals;
};
