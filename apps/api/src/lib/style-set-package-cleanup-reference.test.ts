/**
 * The cleanup job is enqueued before its object exists, so the worker is what
 * decides whether an object is abandoned. Getting that check wrong deletes a
 * live package, which is why it is exercised against a real (PGlite) database
 * rather than a stubbed lookup.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";

import { styleSets } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { createSafeId } from "@/api/lib/branded-types";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

const { testDb, ids } = await getRlsFixture();

void mock.module("@/api/db/root", () => ({ rootDb: testDb, rlsDb: testDb }));

const { deleteUnreferencedStyleSetPackage } =
  await import("@/api/lib/style-set-package-cleanup-queue");

const bucket = envBase.S3_BUCKET;
let fake: FakeS3;

/** The packages surviving in the store, in the order they were seeded. */
const storedKeys = (): string[] =>
  [...fake.objects.keys()].map((id) => id.slice(bucket.length + 1));

const styleSetId = createSafeId<"styleSet">();
const liveKey = `${ids.orgA}/style-sets/${styleSetId}/live.docx`;
const replacedKey = `${ids.orgA}/style-sets/${styleSetId}/replaced.docx`;
const abandonedKey = `${ids.orgA}/style-sets/${styleSetId}/abandoned.docx`;

describe("style set package cleanup reference check", () => {
  beforeAll(() => {
    fake = startFakeS3();
    for (const key of [liveKey, replacedKey, abandonedKey]) {
      fake.put(bucket, key, "style set package");
    }
  });

  afterAll(async () => {
    try {
      await testDb.delete(styleSets).where(eq(styleSets.id, styleSetId));
    } finally {
      fake.stop();
      await releaseRlsFixture();
    }
  });

  test("deletes only packages no style set names", async () => {
    // Abandoned before any row exists: the crash-shaped case.
    await deleteUnreferencedStyleSetPackage(abandonedKey);
    expect(storedKeys()).toEqual([liveKey, replacedKey]);

    await testDb.insert(styleSets).values({
      id: styleSetId,
      organizationId: ids.orgA,
      name: "Kancelářské styly",
      fileName: "kancelarske-styly.docx",
      s3Key: liveKey,
      cleanupS3Key: replacedKey,
      sizeBytes: 1024,
      createdBy: ids.userA1,
    });

    await deleteUnreferencedStyleSetPackage(liveKey);
    // Still recorded in the row's cleanup outbox: not this job's to delete.
    await deleteUnreferencedStyleSetPackage(replacedKey);
    expect(storedKeys()).toEqual([liveKey, replacedKey]);

    await testDb
      .update(styleSets)
      .set({ cleanupS3Key: null })
      .where(eq(styleSets.id, styleSetId));
    await deleteUnreferencedStyleSetPackage(replacedKey);
    expect(storedKeys()).toEqual([liveKey]);
  });
});
