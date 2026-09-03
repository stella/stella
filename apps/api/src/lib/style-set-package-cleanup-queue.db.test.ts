/**
 * A style set that still names a superseded package is owed a deletion. If the
 * job that would run it was lost, nothing else observes that: the object stays
 * in storage and the column it left behind blocks the next replacement. What
 * is asserted here is who may release that column — the job, once the object
 * is actually gone, never the sweep that only enqueued it — and that the sweep
 * pages past packages a live job already covers. Driven against a real
 * (PGlite) database with a stubbed queue and a fake object store.
 */

import { panic } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, inArray } from "drizzle-orm";

import { styleSets } from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { createBullMqJobId } from "@/api/lib/bullmq-job-id";
import {
  deleteUnreferencedStyleSetPackage,
  reconcilePendingStyleSetPackageCleanups,
} from "@/api/lib/style-set-package-cleanup-queue";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import {
  getRlsFixture,
  releaseRlsFixture,
} from "@/api/tests/security/rls-fixture";

const { testDb, ids } = await getRlsFixture();

type StubJobState = "active" | "completed" | "delayed" | "failed";

type AddedJob = { data: unknown; delay: number; jobId: string; name: string };

const added: AddedJob[] = [];
const priorJobs = new Map<string, StubJobState>();

const cleanupQueue = {
  add: async (
    name: string,
    data: unknown,
    options: { delay: number; jobId: string },
  ) => {
    added.push({ data, delay: options.delay, jobId: options.jobId, name });
    priorJobs.set(options.jobId, "delayed");
  },
  getJob: async (jobId: string) => {
    const state = priorJobs.get(jobId);
    if (state === undefined) {
      return undefined;
    }
    return {
      getState: async () => state,
      remove: async () => {
        priorJobs.delete(jobId);
      },
    };
  },
};

const SETTLED_AT = new Date(Date.now() - 60 * 60 * 1000);

const bucket = envBase.S3_BUCKET;
let fake: FakeS3;

/** The packages surviving in the store. */
const storedKeys = (): string[] =>
  [...fake.objects.keys()].map((id) => id.slice(bucket.length + 1));

const seededStyleSetIds: SafeId<"styleSet">[] = [];

type SeedStyleSetOptions = {
  cleanupS3Key?: string | null;
  s3Key?: string;
  updatedAt?: Date;
};

const styleSetValues = ({
  cleanupS3Key = null,
  s3Key,
  updatedAt = SETTLED_AT,
}: SeedStyleSetOptions = {}) => {
  const styleSetId = createSafeId<"styleSet">();
  seededStyleSetIds.push(styleSetId);
  return {
    id: styleSetId,
    organizationId: ids.orgA,
    name: "Reconciler fixture",
    fileName: "styles.docx",
    s3Key: s3Key ?? `style-sets/${styleSetId}/current.docx`,
    cleanupS3Key,
    sizeBytes: 12,
    createdBy: ids.userA1,
    updatedAt,
  };
};

const seedStyleSet = async (
  options: SeedStyleSetOptions = {},
): Promise<SafeId<"styleSet">> => {
  const values = styleSetValues(options);
  await testDb.insert(styleSets).values(values);
  return values.id;
};

/** Panics rather than reporting a missing row as a released marker: the row is
 *  seeded by the test, so its absence is a broken fixture, and reading it as
 *  `null` would let every marker assertion pass without exercising anything. */
const readCleanupKey = async (styleSetId: SafeId<"styleSet">) => {
  const [row] = await testDb
    .select({ cleanupS3Key: styleSets.cleanupS3Key })
    .from(styleSets)
    .where(eq(styleSets.id, styleSetId));
  if (row === undefined) {
    panic(`expected the seeded style set ${styleSetId}`);
  }
  return row.cleanupS3Key;
};

const jobIdFor = (s3Key: string) =>
  createBullMqJobId("delete-style-set-package", s3Key);

describe("pending style set package cleanup reconciliation", () => {
  beforeAll(() => {
    fake = startFakeS3();
  });

  beforeEach(() => {
    added.length = 0;
    priorJobs.clear();
    fake.objects.clear();
  });

  afterEach(async () => {
    if (seededStyleSetIds.length > 0) {
      await testDb
        .delete(styleSets)
        .where(inArray(styleSets.id, seededStyleSetIds));
    }
    seededStyleSetIds.length = 0;
  });

  afterAll(async () => {
    try {
      fake.stop();
    } finally {
      await releaseRlsFixture();
    }
  });

  test("enqueues an owed deletion and leaves the marker for the job", async () => {
    const cleanupS3Key = "style-sets/owed/superseded.docx";
    const styleSetId = await seedStyleSet({ cleanupS3Key });

    const result = await reconcilePendingStyleSetPackageCleanups({
      cleanupQueue,
      db: testDb,
    });

    expect(result).toEqual({ handedOff: 1, scanned: 1 });
    expect(added).toEqual([
      {
        data: { s3Key: cleanupS3Key, styleSetId },
        // The download URL handed out before the replacement has already
        // expired for a row this old, so the deletion runs immediately.
        delay: 0,
        jobId: jobIdFor(cleanupS3Key),
        name: "delete-style-set-package",
      },
    ]);
    // The job may run before any write here lands, and a marker released
    // ahead of the deletion is the only record of the retry, gone.
    expect(await readCleanupKey(styleSetId)).toBe(cleanupS3Key);
  });

  test("releases the marker once the job has deleted the object", async () => {
    const cleanupS3Key = "style-sets/deleted/superseded.docx";
    const styleSetId = await seedStyleSet({ cleanupS3Key });
    fake.put(bucket, cleanupS3Key, "style set package");

    await deleteUnreferencedStyleSetPackage(cleanupS3Key, testDb);

    expect(storedKeys()).toEqual([]);
    expect(await readCleanupKey(styleSetId)).toBeNull();
  });

  test("leaves the marker for the next sweep when the job skipped", async () => {
    // Something still serves this key, so the deletion is refused. The marker
    // is the durable record that it is still owed and must survive.
    const servedKey = "style-sets/served/live.docx";
    await seedStyleSet({ s3Key: servedKey });
    const owingStyleSetId = await seedStyleSet({ cleanupS3Key: servedKey });
    fake.put(bucket, servedKey, "style set package");

    await deleteUnreferencedStyleSetPackage(servedKey, testDb);

    expect(storedKeys()).toEqual([servedKey]);
    expect(await readCleanupKey(owingStyleSetId)).toBe(servedKey);

    const result = await reconcilePendingStyleSetPackageCleanups({
      cleanupQueue,
      db: testDb,
    });

    expect(result).toEqual({ handedOff: 1, scanned: 1 });
    expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(servedKey)]);
  });

  test("leaves rows that owe nothing and rows still inside the handoff window", async () => {
    await seedStyleSet();
    await seedStyleSet({
      cleanupS3Key: "style-sets/fresh/superseded.docx",
      updatedAt: new Date(),
    });

    const result = await reconcilePendingStyleSetPackageCleanups({
      cleanupQueue,
      db: testDb,
    });

    expect(result).toEqual({ handedOff: 0, scanned: 0 });
    expect(added).toEqual([]);
  });

  test("does not spend budget on a deletion a live job already covers", async () => {
    const cleanupS3Key = "style-sets/live/superseded.docx";
    await seedStyleSet({ cleanupS3Key });
    priorJobs.set(jobIdFor(cleanupS3Key), "delayed");

    const result = await reconcilePendingStyleSetPackageCleanups({
      cleanupQueue,
      db: testDb,
    });

    expect(added).toEqual([]);
    expect(result).toEqual({ handedOff: 0, scanned: 1 });
  });

  test("pages past more covered rows than a tick may hand off", async () => {
    // A cleanup waits out the whole download TTL, so a healthy row keeps a
    // live delayed job long after it leaves the settle window. More such rows
    // than the per-tick handoff limit therefore sit ahead of a stranded one on
    // the keyset, and counting them as handoffs would end the tick before it
    // ever reached it.
    const base = SETTLED_AT.getTime();
    const covered = Array.from({ length: 60 }, (_, index) =>
      styleSetValues({
        cleanupS3Key: `style-sets/covered/${index}.docx`,
        updatedAt: new Date(base + index),
      }),
    );
    await testDb.insert(styleSets).values(covered);
    for (const { cleanupS3Key } of covered) {
      priorJobs.set(jobIdFor(cleanupS3Key ?? ""), "delayed");
    }
    const strandedKey = "style-sets/stranded/superseded.docx";
    await seedStyleSet({
      cleanupS3Key: strandedKey,
      updatedAt: new Date(base + 1000),
    });

    const result = await reconcilePendingStyleSetPackageCleanups({
      cleanupQueue,
      db: testDb,
    });

    expect(added.map(({ jobId }) => jobId)).toEqual([jobIdFor(strandedKey)]);
    expect(result).toEqual({ handedOff: 1, scanned: 61 });
  });
});
