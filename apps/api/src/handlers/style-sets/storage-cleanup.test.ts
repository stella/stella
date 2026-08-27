/**
 * A style-set package is written before the row that names it exists, so
 * everything between the two writes is a window where a crash strands the
 * object. What is asserted here is that the window is covered by a durable
 * record rather than by the request surviving: the cleanup is claimed before
 * the write, and a failed inline delete no longer takes the caller's error
 * (or the process) with it.
 */

import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type CleanupClaim = { delayMs?: number; s3Key: string; styleSetId: string };

const claims: CleanupClaim[] = [];
const writtenKeys: string[] = [];
const deletedKeys: string[] = [];
let deleteFails = false;

const cleanupQueueModule =
  await import("@/api/lib/style-set-package-cleanup-queue");
void mock.module("@/api/lib/style-set-package-cleanup-queue", () => ({
  ...cleanupQueueModule,
  enqueueStyleSetPackageCleanup: async (claim: CleanupClaim) => {
    claims.push(claim);
  },
}));

const realS3 = await import("@/api/lib/s3");
void mock.module("@/api/lib/s3", () => ({
  ...realS3,
  getS3: () => ({
    delete: async (key: string) => {
      if (deleteFails) {
        throw new Error("storage unavailable");
      }
      deletedKeys.push(key);
    },
  }),
  writeS3ObjectWithRetry: async ({ key }: { key: string }) => {
    writtenKeys.push(key);
  },
}));

const { createStoredStyleSet } =
  await import("@/api/handlers/style-sets/storage");

/** The row never commits: the shape a crash between the two writes leaves. */
const failingSafeDb = asTestRaw<SafeDb>(
  async () =>
    await Promise.resolve(
      Result.err(new DatabaseError({ message: "connection lost" })),
    ),
);

const recordAuditEvent: AuditRecorder = async () => undefined;

const createRejectedStyleSet = async () =>
  await createStoredStyleSet({
    safeDb: failingSafeDb,
    organizationId: mintAuthProviderId<"organization">(),
    userId: mintAuthProviderId<"user">(),
    name: "Kancelářské styly",
    buffer: Buffer.from("style set"),
    recordAuditEvent,
  });

describe("style set package cleanup durability", () => {
  beforeEach(() => {
    claims.length = 0;
    writtenKeys.length = 0;
    deletedKeys.length = 0;
    deleteFails = false;
  });

  test("claims the cleanup before the package is written", async () => {
    const result = await createRejectedStyleSet();

    expect(Result.isError(result)).toBe(true);
    expect(writtenKeys).toHaveLength(1);
    expect(claims.map(({ s3Key }) => s3Key)).toEqual(writtenKeys);
    expect(claims.at(0)?.delayMs).toBe(
      cleanupQueueModule.STYLE_SET_PACKAGE_ABANDON_DELAY_MS,
    );
    expect(deletedKeys).toEqual(writtenKeys);
  });

  test("survives an inline delete that fails, leaving the claim to run", async () => {
    deleteFails = true;

    const result = await createRejectedStyleSet();

    // The caller still sees the failure that rejected the style set, not the
    // storage error the cleanup hit, and the queued claim still owns the key.
    expect(Result.isError(result)).toBe(true);
    expect(claims.map(({ s3Key }) => s3Key)).toEqual(writtenKeys);
  });
});
