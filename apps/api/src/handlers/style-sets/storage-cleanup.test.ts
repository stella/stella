/**
 * A style-set package is written before the row that names it exists, so
 * everything between the two writes is a window where a crash strands the
 * object. What is asserted here is that the window is covered by a durable
 * record rather than by the request surviving: the cleanup is claimed before
 * the write, and a failed inline delete no longer takes the caller's error
 * (or the process) with it.
 */

import { Result } from "better-result";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { SafeDb } from "@/api/db/safe-db";
import { envBase } from "@/api/env-base";
import { createStoredStyleSet } from "@/api/handlers/style-sets/storage";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { STYLE_SET_PACKAGE_ABANDON_DELAY_MS } from "@/api/lib/style-set-package-cleanup-queue";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

type CleanupClaim = { delayMs?: number; s3Key: string; styleSetId: string };

const claims: CleanupClaim[] = [];

const enqueueCleanup = async (claim: CleanupClaim) => {
  claims.push(claim);
};

const bucket = envBase.S3_BUCKET;
let fake: FakeS3;

/** The keys the store accepted a package under, in write order. */
const writtenKeys = (): string[] =>
  fake.requests.flatMap(({ key, method }) => (method === "PUT" ? [key] : []));

/** The packages still in the store: what a lost cleanup would strand. */
const storedKeys = (): string[] =>
  [...fake.objects.keys()].map((id) => id.slice(bucket.length + 1));

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
    enqueueCleanup,
  });

describe("style set package cleanup durability", () => {
  beforeEach(() => {
    claims.length = 0;
    fake = startFakeS3();
  });

  afterEach(() => {
    fake.stop();
  });

  test("claims the cleanup before the package is written", async () => {
    const result = await createRejectedStyleSet();

    expect(Result.isError(result)).toBe(true);
    expect(writtenKeys()).toHaveLength(1);
    expect(claims.map(({ s3Key }) => s3Key)).toEqual(writtenKeys());
    expect(claims.at(0)?.delayMs).toBe(STYLE_SET_PACKAGE_ABANDON_DELAY_MS);
    // The inline cleanup ran: nothing the claim would have to collect later.
    expect(storedKeys()).toEqual([]);
  });

  test("survives an inline delete that fails, leaving the claim to run", async () => {
    fake.failNext({ method: "DELETE", code: "InternalError", status: 500 });

    const result = await createRejectedStyleSet();

    // The caller still sees the failure that rejected the style set, not the
    // storage error the cleanup hit, and the queued claim still owns the key
    // the store is still holding.
    expect(Result.isError(result)).toBe(true);
    expect(claims.map(({ s3Key }) => s3Key)).toEqual(writtenKeys());
    expect(storedKeys()).toEqual(writtenKeys());
    // The stranded object is the package itself, so the claim collects the
    // bytes the caller uploaded rather than an empty placeholder.
    expect(fake.objects.get(`${bucket}/${writtenKeys().at(0)}`)?.bytes).toEqual(
      new TextEncoder().encode("style set"),
    );
  });
});
