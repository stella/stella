/**
 * Erasing a decision's raw objects: everything it owns goes, nothing another
 * decision names goes with it, and no write, retry or leftover of the older
 * source-wide layout brings any of it back.
 *
 * The store is a fake S3 speaking the wire protocol, and every assertion is
 * about the keys it holds, so a key format drifting between writer and
 * eraser is what these tests catch rather than what they assume away.
 */
import { Result } from "better-result";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { ScopedDb } from "@/api/db/safe-db";
import {
  caseLawDecisionSourceIdentities,
  caseLawDecisions,
  caseLawIndexJobs,
  caseLawRawSweeps,
  caseLawSources,
  relations,
} from "@/api/db/schema";
import { envBase } from "@/api/env-base";
import { redactCaseLawDecision } from "@/api/handlers/case-law/erasure";
import {
  EMPTY_AST,
  encodeSourceRawEnvelope,
  SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
} from "@/api/handlers/case-law/ingestion/adapter";
import {
  DECISION_REFRESH,
  processDecision,
} from "@/api/handlers/case-law/ingestion/pipeline";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  TEXT_ABSENCE_REASON,
  absentDecisionTextFields,
} from "@/api/lib/case-law/decision-text";
import {
  censusCaseLawRawObjectsPage,
  RAW_CENSUS_MODE,
  RAW_ORPHAN_GRACE_MS,
} from "@/api/lib/legal-search/case-law-raw-census";
import {
  RAW_LAYOUT_MODE,
  reconcileCaseLawRawLayoutPage,
} from "@/api/lib/legal-search/case-law-raw-layout";
import {
  LEGACY_RAW_SWEEP_MODE,
  sweepCaseLawLegacyRawSource,
} from "@/api/lib/legal-search/case-law-raw-legacy";
import {
  enqueueCaseLawRawSweepTx,
  reconcileCaseLawRawSweeps,
} from "@/api/lib/legal-search/case-law-raw-sweeps";
import { decodeSourceRawEnvelopeObjects } from "@/api/lib/legal-search/ingestion-types";
import {
  RAW_SOURCE_FAMILY,
  rawDocumentPrefix,
} from "@/api/lib/legal-search/raw-source-storage";
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;
let scopedDb: ScopedDb;
let fake: FakeS3;

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
  scopedDb = asTestRaw<ScopedDb>(
    async (callback: (tx: typeof db) => Promise<unknown>) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx))),
  );
}, 120_000);

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  fake = startFakeS3();
  await db.delete(caseLawRawSweeps).where(sql`true`);
});

afterEach(() => {
  fake.stop();
});

const signal = () => AbortSignal.timeout(30_000);
const bucketId = (key: string): string => `${envBase.S3_BUCKET}/${key}`;
const stored = (key: string): boolean => fake.objects.has(bucketId(key));
/**
 * Keys of every stored object whose bytes contain the text: whatever layout
 * a payload was written in, if it still holds a decision's words it is
 * found.
 */
const holding = (text: string): string[] =>
  [...fake.objects.entries()]
    .filter(([, { bytes }]) => new TextDecoder().decode(bytes).includes(text))
    .map(([id]) => id);
const bytesOf = (text: string) => new TextEncoder().encode(text);
const sha256 = (data: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(data).digest("hex");

const createSource = async (): Promise<SafeId<"caseLawSource">> => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `raw-erasure-${sourceId}`,
    name: "raw erasure fixture",
  });
  return sourceId;
};

const prefixOf = (
  sourceId: SafeId<"caseLawSource">,
  decisionId: SafeId<"caseLawDecision">,
): string =>
  rawDocumentPrefix({
    family: RAW_SOURCE_FAMILY.CASE_LAW,
    sourceId,
    documentId: decisionId,
  });

const keysUnder = (prefix: string): string[] =>
  [...fake.objects.keys()]
    .filter((id) => id.startsWith(bucketId(prefix)))
    .map((id) => id.slice(envBase.S3_BUCKET.length + 1));

type ObserveOptions = {
  sourceId: SafeId<"caseLawSource">;
  caseNumber: string;
  /** Omitted for a source keyed on case number and language. */
  sourceDocumentId?: string;
  listing: string;
  /** The publisher's file; omitted for a decision served as text only. */
  file?: string;
  order: bigint;
};

/** One observation of a decision, as a crawl feeds it. */
const observe = async ({
  sourceId,
  caseNumber,
  sourceDocumentId,
  listing,
  file,
  order,
}: ObserveOptions) =>
  await processDecision({
    input: {
      caseNumber,
      ...(sourceDocumentId === undefined ? {} : { sourceDocumentId }),
      court: "Ústavný súd Slovenskej republiky",
      country: "SVK",
      language: "sk",
      fulltext: "Rozhodnutie o veci samej.",
      metadata: {},
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      rawHash: sha256(`${listing}|${file ?? ""}`),
      documentAst: EMPTY_AST,
      sourceRaw: encodeSourceRawEnvelope({ listing }),
      ...(file === undefined
        ? {}
        : {
            sourceRawObjects: {
              "document-file": {
                bytes: bytesOf(file),
                contentType: "application/pdf",
              },
            },
          }),
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    },
    sourceId,
    scopedDb,
    observedAt: new Date(),
    observationOrder: order,
    refresh: DECISION_REFRESH.ALWAYS,
  });

const rowOf = async (decisionId: SafeId<"caseLawDecision">) =>
  (
    await db
      .select({
        sourceRawS3Key: caseLawDecisions.sourceRawS3Key,
        redactedAt: caseLawDecisions.redactedAt,
      })
      .from(caseLawDecisions)
      .where(eq(caseLawDecisions.id, decisionId))
  ).at(0);

const decisionIdOf = async (
  sourceId: SafeId<"caseLawSource">,
  caseNumber: string,
): Promise<SafeId<"caseLawDecision">> => {
  const row = (
    await db
      .select({ id: caseLawDecisions.id })
      .from(caseLawDecisions)
      .where(
        sql`${caseLawDecisions.sourceId} = ${sourceId} AND ${caseLawDecisions.caseNumber} = ${caseNumber}`,
      )
  ).at(0);
  if (row === undefined) {
    throw new Error(`no decision ${caseNumber}`);
  }
  return row.id;
};

/** Every key a decision names: its pointer, and each file its payload names. */
const namedBy = async (
  decisionId: SafeId<"caseLawDecision">,
): Promise<string[]> => {
  const pointer = (await rowOf(decisionId))?.sourceRawS3Key ?? null;
  if (pointer === null) {
    return [];
  }
  const payload = fake.objects.get(bucketId(pointer));
  const files =
    payload === undefined
      ? []
      : Object.values(
          decodeSourceRawEnvelopeObjects(
            new TextDecoder().decode(payload.bytes),
          ),
        ).map(({ location }) => location);
  return [pointer, ...files];
};

const redact = async (decisionId: SafeId<"caseLawDecision">) => {
  const outcome = await redactCaseLawDecision({ decisionId, scopedDb });
  if (Result.isError(outcome)) {
    throw outcome.error;
  }
  return outcome.value;
};

/** Every entry due now, including those not yet past their settle time. */
const drainSweeps = async (): Promise<void> => {
  await db
    .update(caseLawRawSweeps)
    .set({
      nextAttemptAt: sql`now() - interval '1 second'`,
      settleAfter: sql`now() - interval '1 second'`,
    })
    .where(sql`true`);
  await reconcileCaseLawRawSweeps({
    scopedDb,
    limit: 100,
    signal: signal(),
  });
};

type LegacyDecision = {
  decisionId: SafeId<"caseLawDecision">;
  payloadKey: string;
  fileKey: string;
};

/**
 * A decision stored the way every decision was before raw keys were per
 * decision: its envelope and its file under their digests, directly under
 * the source, where another decision served the same bytes names the same
 * objects.
 */
const legacyDecision = async ({
  sourceId,
  caseNumber,
  listing,
  file,
}: {
  sourceId: SafeId<"caseLawSource">;
  caseNumber: string;
  listing: string;
  file: string;
}): Promise<LegacyDecision> => {
  const fileBytes = bytesOf(file);
  const fileKey = `case-law/raw/${sourceId}/${sha256(fileBytes)}`;
  fake.put(envBase.S3_BUCKET, fileKey, fileBytes, "application/pdf");
  const envelope = encodeSourceRawEnvelope(
    { listing },
    {
      "document-file": {
        location: fileKey,
        sha256: sha256(fileBytes),
        contentType: "application/pdf",
        byteLength: fileBytes.byteLength,
      },
    },
  );
  const payloadKey = `case-law/raw/${sourceId}/${sha256(envelope)}`;
  fake.put(
    envBase.S3_BUCKET,
    payloadKey,
    envelope,
    SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  );
  const decisionId = createSafeId<"caseLawDecision">();
  await db.insert(caseLawDecisions).values({
    id: decisionId,
    sourceId,
    caseNumber,
    court: "Ústavný súd Slovenskej republiky",
    country: "SVK",
    language: "sk",
    fulltext: "Rozhodnutie.",
    contentHash: sha256(caseNumber),
    sourceRawS3Key: payloadKey,
    sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
  });
  return { decisionId, payloadKey, fileKey };
};

const openSweeps = async () =>
  (
    await db.select({ id: caseLawRawSweeps.decisionId }).from(caseLawRawSweeps)
  ).map(({ id }) => id);

const sweepLegacy = async (sourceId: SafeId<"caseLawSource">) =>
  await sweepCaseLawLegacyRawSource({
    scopedDb,
    sourceId,
    mode: LEGACY_RAW_SWEEP_MODE.APPLY,
    signal: signal(),
  });

const migrateSource = async (sourceId: SafeId<"caseLawSource">) =>
  await reconcileCaseLawRawLayoutPage({
    scopedDb,
    cursor: null,
    limit: 1000,
    mode: RAW_LAYOUT_MODE.APPLY,
    sourceId,
    signal: signal(),
  });

describe("erasing one decision's raw objects", () => {
  test.each([
    {
      name: "the same file and envelope",
      fileA: "%PDF same",
      fileB: "%PDF same",
    },
    {
      name: "the same envelope and no file",
      fileA: undefined,
      fileB: undefined,
    },
    { name: "different files", fileA: "%PDF a", fileB: "%PDF b" },
  ])(
    "leaves every object another decision names, when both were served $name",
    async ({ fileA, fileB }) => {
      const sourceId = await createSource();
      await observe({
        sourceId,
        caseNumber: "I. ÚS 1/2026",
        sourceDocumentId: "a",
        listing: "{}",
        ...(fileA === undefined ? {} : { file: fileA }),
        order: 1n,
      });
      await observe({
        sourceId,
        caseNumber: "I. ÚS 2/2026",
        sourceDocumentId: "b",
        listing: "{}",
        ...(fileB === undefined ? {} : { file: fileB }),
        order: 2n,
      });
      const a = await decisionIdOf(sourceId, "I. ÚS 1/2026");
      const b = await decisionIdOf(sourceId, "I. ÚS 2/2026");
      const keptForB = await namedBy(b);
      // Both decisions hold objects, or nothing below is at stake.
      expect(keysUnder(prefixOf(sourceId, a)).length).toBeGreaterThan(0);
      expect(keptForB.length).toBeGreaterThan(0);

      expect(await redact(a)).toMatchObject({
        type: "redacted",
        legacyRaw: "none",
      });

      expect(keysUnder(prefixOf(sourceId, a))).toEqual([]);
      expect(keptForB.filter((key) => !stored(key))).toEqual([]);
      await drainSweeps();
      expect(keptForB.filter((key) => !stored(key))).toEqual([]);
    },
  );

  test("removes every payload the decision was ever stored with, not only the current one", async () => {
    const sourceId = await createSource();
    for (const [order, listing] of [
      [1n, '{"v":1,"only":"erased-decision"}'],
      [2n, '{"v":2,"only":"erased-decision"}'],
    ] as const) {
      await observe({
        sourceId,
        caseNumber: "II. ÚS 1/2026",
        sourceDocumentId: "replaced",
        listing,
        file: "%PDF replaced",
        order,
      });
    }
    const a = await decisionIdOf(sourceId, "II. ÚS 1/2026");
    const pointer = (await rowOf(a))?.sourceRawS3Key;
    const payloads = keysUnder(`${prefixOf(sourceId, a)}payloads/`);
    // The earlier payload is still stored and no longer the pointer.
    expect(payloads).toHaveLength(2);
    expect(payloads.filter((key) => key !== pointer)).toHaveLength(1);

    expect(holding("erased-decision")).toHaveLength(2);

    await redact(a);

    expect(holding("erased-decision")).toEqual([]);
    expect(keysUnder(prefixOf(sourceId, a))).toEqual([]);
    expect(await rowOf(a)).toMatchObject({ sourceRawS3Key: null });
  });

  test.each([
    { name: "share one envelope and its file", sameEnvelope: true },
    { name: "share only a file", sameEnvelope: false },
  ])(
    "in the older layout, where two decisions $name, keeps A's erasure open until the source's older objects are swept, then leaves B whole",
    async ({ sameEnvelope }) => {
      const sourceId = await createSource();
      // An observation of A the row no longer points at: nothing names it.
      const replaced = encodeSourceRawEnvelope({
        listing: '{"only":"replaced"}',
      });
      const replacedKey = `case-law/raw/${sourceId}/${sha256(replaced)}`;
      fake.put(
        envBase.S3_BUCKET,
        replacedKey,
        replaced,
        SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      );
      const a = await legacyDecision({
        sourceId,
        caseNumber: "III. ÚS 1/2026",
        listing: sameEnvelope ? '{"only":"shared"}' : '{"only":"erased"}',
        file: "%PDF shared",
      });
      const b = await legacyDecision({
        sourceId,
        caseNumber: "III. ÚS 2/2026",
        listing: sameEnvelope ? '{"only":"shared"}' : '{"other":true}',
        file: "%PDF shared",
      });
      // The fixture shares what it says it shares.
      expect(a.fileKey).toBe(b.fileKey);
      expect(a.payloadKey === b.payloadKey).toBe(sameEnvelope);

      expect(await redact(a.decisionId)).toMatchObject({
        type: "redacted",
        legacyRaw: "pending",
      });
      await drainSweeps();
      // B still names both objects; neither may go, and A's entry stays.
      expect(
        (await namedBy(b.decisionId)).filter((key) => !stored(key)),
      ).toEqual([]);
      expect(await openSweeps()).toEqual([a.decisionId]);
      expect(
        await db
          .select({ detail: caseLawIndexJobs.detail })
          .from(caseLawIndexJobs)
          .where(eq(caseLawIndexJobs.decisionId, a.decisionId)),
      ).toEqual([{ detail: "legacy raw pending" }]);

      // B moves into its own prefix; A's entry still waits for the sweep.
      expect((await migrateSource(sourceId)).counts.migrated).toBe(1);
      const keptForB = await namedBy(b.decisionId);
      expect(keptForB.every((key) => key.includes("/documents/"))).toBe(true);
      await drainSweeps();
      expect(await openSweeps()).toEqual([a.decisionId]);

      expect(await sweepLegacy(sourceId)).toMatchObject({ type: "swept" });
      await drainSweeps();

      // Nothing A was ever stored with remains; everything B names does.
      expect(holding('"replaced"')).toEqual([]);
      if (!sameEnvelope) {
        expect(holding('"erased"')).toEqual([]);
      }
      expect(stored(a.payloadKey) || stored(a.fileKey)).toBe(false);
      expect(keptForB.filter((key) => !stored(key))).toEqual([]);
      expect(await openSweeps()).toEqual([]);
    },
  );
});

describe("a sweep", () => {
  test("never touches a decision that is live, whatever queued it", async () => {
    const sourceId = await createSource();
    await observe({
      sourceId,
      caseNumber: "X. ÚS 1/2026",
      sourceDocumentId: "live",
      listing: "{}",
      file: "%PDF live",
      order: 1n,
    });
    const live = await decisionIdOf(sourceId, "X. ÚS 1/2026");
    const keys = keysUnder(prefixOf(sourceId, live));
    expect(keys.length).toBeGreaterThan(0);
    // What an insert that looked lost, but committed, records.
    await db.transaction(async (tx) => {
      await enqueueCaseLawRawSweepTx(asTestRaw(tx), {
        decisionId: live,
        sourceId,
        firstAttemptAt: new Date(),
        settleAfter: new Date(),
      });
    });

    await drainSweeps();

    expect(keysUnder(prefixOf(sourceId, live))).toEqual(keys);
    expect(
      await db
        .select({ id: caseLawRawSweeps.decisionId })
        .from(caseLawRawSweeps),
    ).toEqual([]);
  });

  test("closes an erasure's entry only after its settle time, sweeping a late write each time", async () => {
    const sourceId = await createSource();
    await observe({
      sourceId,
      caseNumber: "X. ÚS 2/2026",
      sourceDocumentId: "settle",
      listing: "{}",
      file: "%PDF settle",
      order: 1n,
    });
    const a = await decisionIdOf(sourceId, "X. ÚS 2/2026");
    await redact(a);
    // What a writer that died after its write landed leaves: nothing
    // recorded but the erasure's own entry.
    const late = `${prefixOf(sourceId, a)}payloads/${"a".repeat(64)}`;
    fake.put(envBase.S3_BUCKET, late, "late");
    await db
      .update(caseLawRawSweeps)
      .set({ nextAttemptAt: sql`now() - interval '1 second'` })
      .where(sql`true`);

    await reconcileCaseLawRawSweeps({ scopedDb, limit: 10, signal: signal() });

    expect(stored(late)).toBe(false);
    // Swept, but not retired: its settle time is still ahead, and the next
    // attempt is not before it.
    const [entry] = await db
      .select({
        settleAfter: caseLawRawSweeps.settleAfter,
        nextAttemptAt: caseLawRawSweeps.nextAttemptAt,
      })
      .from(caseLawRawSweeps);
    expect(entry?.settleAfter.getTime()).toBeGreaterThan(Date.now());
    expect(entry?.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(
      entry?.settleAfter.getTime() ?? Number.POSITIVE_INFINITY,
    );

    fake.put(envBase.S3_BUCKET, late, "later still");
    await drainSweeps();

    expect(stored(late)).toBe(false);
    expect(await openSweeps()).toEqual([]);
  });
});

describe("a payload in its own prefix naming a file of the older layout", () => {
  test("keeps the erasure open until the source's older objects are swept", async () => {
    const sourceId = await createSource();
    await observe({
      sourceId,
      caseNumber: "XII. ÚS 1/2026",
      sourceDocumentId: "own",
      listing: "{}",
      order: 1n,
    });
    const a = await decisionIdOf(sourceId, "XII. ÚS 1/2026");
    const fileBytes = bytesOf("%PDF only named by an own envelope");
    const legacyFile = `case-law/raw/${sourceId}/${sha256(fileBytes)}`;
    fake.put(envBase.S3_BUCKET, legacyFile, fileBytes, "application/pdf");
    const pointer = (await rowOf(a))?.sourceRawS3Key ?? "";
    fake.put(
      envBase.S3_BUCKET,
      pointer,
      encodeSourceRawEnvelope(
        { listing: "{}" },
        {
          "document-file": {
            location: legacyFile,
            sha256: sha256(fileBytes),
            contentType: "application/pdf",
            byteLength: fileBytes.byteLength,
          },
        },
      ),
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );

    expect(await redact(a)).toMatchObject({ legacyRaw: "pending" });
    expect(keysUnder(prefixOf(sourceId, a))).toEqual([]);

    expect(await sweepLegacy(sourceId)).toMatchObject({ type: "swept" });
    await drainSweeps();

    expect(stored(legacyFile)).toBe(false);
    expect(await openSweeps()).toEqual([]);
  });
});

describe("a write racing an erasure", () => {
  test("a raw write in flight when the erasure commits is swept after it lands", async () => {
    const sourceId = await createSource();
    await observe({
      sourceId,
      caseNumber: "IV. ÚS 1/2026",
      sourceDocumentId: "raced",
      listing: '{"v":1}',
      file: "%PDF v1",
      order: 1n,
    });
    const a = await decisionIdOf(sourceId, "IV. ÚS 1/2026");
    // The next observation's file write is held after the writer has seen
    // the row live, and released only once the erasure has swept.
    const held = fake.holdNext({
      method: "PUT",
      keyIncludes: prefixOf(sourceId, a),
    });
    const writing = observe({
      sourceId,
      caseNumber: "IV. ÚS 1/2026",
      sourceDocumentId: "raced",
      listing: '{"v":2}',
      file: "%PDF v2",
      order: 2n,
    });
    await held.reached;

    await redact(a);
    expect(keysUnder(prefixOf(sourceId, a))).toEqual([]);
    held.release();
    expect((await writing).status).toBe("complete");
    // The late write landed after the erasure's sweep: the bytes are back
    // until the entry its writer recorded is drained.
    expect(keysUnder(prefixOf(sourceId, a)).length).toBeGreaterThan(0);

    await reconcileCaseLawRawSweeps({ scopedDb, limit: 100, signal: signal() });

    expect(keysUnder(prefixOf(sourceId, a))).toEqual([]);
    // The erasure's own follow-up stays until its settle time.
    expect(
      await db
        .select({ id: caseLawRawSweeps.decisionId })
        .from(caseLawRawSweeps),
    ).toEqual([{ id: a }]);
  });
});

describe("a refresh whose raw upload fails", () => {
  test("leaves the row's pointer as it is now, not as it was read", async () => {
    const sourceId = await createSource();
    await observe({
      sourceId,
      caseNumber: "XIV. ÚS 1/2026",
      sourceDocumentId: "moved",
      listing: '{"v":1}',
      file: "%PDF v1",
      order: 1n,
    });
    const a = await decisionIdOf(sourceId, "XIV. ÚS 1/2026");
    const held = fake.holdNext({
      method: "PUT",
      keyIncludes: prefixOf(sourceId, a),
    });
    fake.failNext({
      method: "PUT",
      code: "AccessDenied",
      status: 403,
      keyIncludes: "/payloads/",
    });
    const writing = observe({
      sourceId,
      caseNumber: "XIV. ÚS 1/2026",
      sourceDocumentId: "moved",
      listing: '{"v":2}',
      file: "%PDF v2",
      order: 2n,
    });
    await held.reached;
    // The pointer moves while the refresh is in flight, as the layout
    // backfill moves it.
    const movedTo = `${prefixOf(sourceId, a)}payloads/${"b".repeat(64)}`;
    await db
      .update(caseLawDecisions)
      .set({ sourceRawS3Key: movedTo })
      .where(eq(caseLawDecisions.id, a));
    held.release();
    await writing;

    expect((await rowOf(a))?.sourceRawS3Key).toBe(movedTo);
  });
});

describe("a write whose row never lands", () => {
  test("a lost insert does not leave objects under an id no row will ever have", async () => {
    const sourceId = await createSource();
    const caseNumber = "V. ÚS 1/2026";
    // Keyed on case number and language: the id the attempt proposes is
    // its own and is not reserved anywhere, so a retry picks another.
    const held = fake.holdNext({
      method: "PUT",
      keyIncludes: `case-law/raw/${sourceId}/documents/`,
    });
    const writing = observe({
      sourceId,
      caseNumber,
      listing: "{}",
      file: "%PDF lost",
      order: 1n,
    });
    await held.reached;
    // Another worker stores the same decision first.
    const winner = await observe({
      sourceId,
      caseNumber,
      listing: "{}",
      file: "%PDF lost",
      order: 2n,
    });
    expect(winner.status).toBe("complete");
    held.release();
    await writing;

    const owner = await decisionIdOf(sourceId, caseNumber);
    const prefixes = new Set(
      keysUnder(`case-law/raw/${sourceId}/documents/`).map(
        (key) => key.split("/documents/")[1]?.split("/")[0],
      ),
    );
    // The lost attempt did write under an id of its own.
    expect(prefixes.size).toBe(2);

    await drainSweeps();

    expect([
      ...new Set(
        keysUnder(`case-law/raw/${sourceId}/documents/`).map(
          (key) => key.split("/documents/")[1]?.split("/")[0],
        ),
      ),
    ]).toEqual([owner]);
    expect((await namedBy(owner)).filter((key) => !stored(key))).toEqual([]);
  });
});

describe("a new decision whose raw write fails partway", () => {
  test("has what did land swept, since a retry writes under another id", async () => {
    const sourceId = await createSource();
    // The file lands; the envelope naming it does not.
    fake.failNext({
      method: "PUT",
      code: "AccessDenied",
      status: 403,
      keyIncludes: "/payloads/",
    });
    const outcome = await observe({
      sourceId,
      caseNumber: "XIII. ÚS 1/2026",
      listing: "{}",
      file: "%PDF half written",
      order: 1n,
    });
    expect(outcome.status).toBe("retryable");
    const landed = keysUnder(`case-law/raw/${sourceId}/documents/`);
    expect(landed).toHaveLength(1);

    await drainSweeps();

    expect(keysUnder(`case-law/raw/${sourceId}/documents/`)).toEqual([]);
  });
});

describe("the raw object census", () => {
  const age = (key: string, ageMs: number) => {
    fake.modifiedAt.set(bucketId(key), new Date(Date.now() - ageMs));
  };

  test("queues what no live decision owns and leaves the rest", async () => {
    const sourceId = await createSource();
    const orphan = createSafeId<"caseLawDecision">();
    const recent = createSafeId<"caseLawDecision">();
    const reserved = createSafeId<"caseLawDecision">();
    for (const id of [orphan, recent, reserved]) {
      fake.put(envBase.S3_BUCKET, `${prefixOf(sourceId, id)}payloads/x`, "x");
    }
    age(`${prefixOf(sourceId, orphan)}payloads/x`, RAW_ORPHAN_GRACE_MS + 1);
    age(`${prefixOf(sourceId, recent)}payloads/x`, 0);
    age(`${prefixOf(sourceId, reserved)}payloads/x`, RAW_ORPHAN_GRACE_MS + 1);
    await db.insert(caseLawDecisionSourceIdentities).values({
      sourceId,
      sourceDocumentId: "reserved",
      decisionId: reserved,
    });
    await observe({
      sourceId,
      caseNumber: "VI. ÚS 1/2026",
      sourceDocumentId: "live",
      listing: "{}",
      file: "%PDF live",
      order: 1n,
    });
    await observe({
      sourceId,
      caseNumber: "VI. ÚS 2/2026",
      sourceDocumentId: "erased",
      listing: "{}",
      file: "%PDF erased",
      order: 2n,
    });
    const live = await decisionIdOf(sourceId, "VI. ÚS 1/2026");
    const erased = await decisionIdOf(sourceId, "VI. ÚS 2/2026");
    await redact(erased);
    // What a write racing the erasure left behind, with nothing recorded.
    fake.put(envBase.S3_BUCKET, `${prefixOf(sourceId, erased)}leftover`, "x");
    await db.delete(caseLawRawSweeps).where(sql`true`);
    const liveKeys = keysUnder(prefixOf(sourceId, live));

    const walk = async (
      cursor: Parameters<typeof censusCaseLawRawObjectsPage>[0]["cursor"],
    ) => {
      const page = await censusCaseLawRawObjectsPage({
        scopedDb,
        cursor,
        maxKeys: 2,
        mode: RAW_CENSUS_MODE.APPLY,
        signal: signal(),
      });
      if (page.next?.sourceId === sourceId) {
        await walk(page.next);
      }
    };
    await walk({ sourceId, startAfter: null });
    await drainSweeps();

    expect(keysUnder(prefixOf(sourceId, orphan))).toEqual([]);
    expect(keysUnder(prefixOf(sourceId, erased))).toEqual([]);
    expect(keysUnder(prefixOf(sourceId, recent))).toHaveLength(1);
    expect(keysUnder(prefixOf(sourceId, reserved))).toHaveLength(1);
    expect(keysUnder(prefixOf(sourceId, live))).toEqual(liveKeys);
  });
});

describe("moving decisions out of the older layout", () => {
  test("gives each decision its own copy and moves its pointer, once", async () => {
    const sourceId = await createSource();
    const a = await legacyDecision({
      sourceId,
      caseNumber: "VII. ÚS 1/2026",
      listing: "{}",
      file: "%PDF shared",
    });
    const b = await legacyDecision({
      sourceId,
      caseNumber: "VII. ÚS 2/2026",
      listing: "{}",
      file: "%PDF shared",
    });

    const plan = await reconcileCaseLawRawLayoutPage({
      scopedDb,
      cursor: null,
      limit: 1000,
      mode: RAW_LAYOUT_MODE.PLAN,
      sourceId,
      signal: signal(),
    });
    expect(plan.counts.migrated).toBe(2);
    expect((await rowOf(a.decisionId))?.sourceRawS3Key).toBe(a.payloadKey);

    expect((await migrateSource(sourceId)).counts.migrated).toBe(2);
    for (const { decisionId } of [a, b]) {
      const named = await namedBy(decisionId);
      expect(named).toHaveLength(2);
      expect(
        named.every((key) => key.startsWith(prefixOf(sourceId, decisionId))),
      ).toBe(true);
      expect(named.filter((key) => !stored(key))).toEqual([]);
    }
    // Nothing is deleted by the move.
    expect(stored(a.payloadKey) && stored(a.fileKey)).toBe(true);

    const versions = new Map(fake.versions);
    const again = await migrateSource(sourceId);
    expect(again.counts.current).toBe(2);
    expect(new Map(fake.versions)).toEqual(versions);
  });

  test("a cancelled page stops its object-storage calls and reports nothing", async () => {
    const sourceId = await createSource();
    const legacy = await legacyDecision({
      sourceId,
      caseNumber: "VII. ÚS 3/2026",
      listing: "{}",
      file: "%PDF cancelled",
    });
    const cancel = new AbortController();
    // The run's first call on the decision is still in flight when the run
    // is cancelled, as a shutdown or a runtime ceiling would leave it.
    const held = fake.holdNext({
      method: "HEAD",
      keyIncludes: legacy.payloadKey,
    });
    const page = reconcileCaseLawRawLayoutPage({
      scopedDb,
      cursor: null,
      limit: 1000,
      mode: RAW_LAYOUT_MODE.APPLY,
      sourceId,
      signal: cancel.signal,
    });
    const settled = page.then(
      () => "resolved",
      () => "rejected",
    );
    await held.reached;
    cancel.abort();
    held.release();

    expect(await settled).toBe("rejected");
    expect((await rowOf(legacy.decisionId))?.sourceRawS3Key).toBe(
      legacy.payloadKey,
    );
    expect(keysUnder(prefixOf(sourceId, legacy.decisionId))).toEqual([]);
  });

  test("a replayed envelope naming a file stored elsewhere is copied in", async () => {
    const sourceId = await createSource();
    const legacy = await legacyDecision({
      sourceId,
      caseNumber: "VIII. ÚS 1/2026",
      listing: "{}",
      file: "%PDF replayed",
    });
    const envelope = new TextDecoder().decode(
      fake.objects.get(bucketId(legacy.payloadKey))?.bytes,
    );
    await db
      .update(caseLawDecisions)
      .set({ sourceDocumentId: "replayed" })
      .where(eq(caseLawDecisions.id, legacy.decisionId));

    // What a replay hands the pipeline: the stored envelope, no bytes.
    await processDecision({
      input: {
        caseNumber: "VIII. ÚS 1/2026",
        sourceDocumentId: "replayed",
        court: "Ústavný súd Slovenskej republiky",
        country: "SVK",
        language: "sk",
        fulltext: "Rozhodnutie o veci samej.",
        metadata: {},
        textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
        rawHash: sha256(envelope),
        documentAst: EMPTY_AST,
        sourceRaw: envelope,
        sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
      },
      sourceId,
      scopedDb,
      observedAt: new Date(),
      observationOrder: 1n,
      refresh: DECISION_REFRESH.ALWAYS,
    });

    const named = await namedBy(legacy.decisionId);
    expect(named).toHaveLength(2);
    expect(
      named.every((key) =>
        key.startsWith(prefixOf(sourceId, legacy.decisionId)),
      ),
    ).toBe(true);
    expect(named.filter((key) => !stored(key))).toEqual([]);
  });
});

describe("a decision whose older-layout file is not what its envelope says", () => {
  test("is reported unmovable and its pointer left, never pointed at a bad copy", async () => {
    const sourceId = await createSource();
    const a = await legacyDecision({
      sourceId,
      caseNumber: "XV. ÚS 1/2026",
      listing: "{}",
      file: "%PDF as named",
    });
    // Same length, different bytes: only the digest tells them apart.
    expect("%PDF as nameX".length).toBe("%PDF as named".length);
    fake.put(envBase.S3_BUCKET, a.fileKey, "%PDF as nameX", "application/pdf");

    const page = await migrateSource(sourceId);

    expect(page.counts.unmovable).toBe(1);
    expect((await rowOf(a.decisionId))?.sourceRawS3Key).toBe(a.payloadKey);
    expect(keysUnder(prefixOf(sourceId, a.decisionId))).toEqual([]);
  });
});

describe("moving a decision while it changes", () => {
  test("a move overtaken by a newer observation leaves the newer pointer", async () => {
    const sourceId = await createSource();
    const a = await legacyDecision({
      sourceId,
      caseNumber: "XI. ÚS 1/2026",
      listing: "{}",
      file: "%PDF moving",
    });
    await db
      .update(caseLawDecisions)
      .set({ sourceDocumentId: "moving" })
      .where(eq(caseLawDecisions.id, a.decisionId));
    const held = fake.holdNext({
      method: "PUT",
      keyIncludes: `${prefixOf(sourceId, a.decisionId)}payloads/`,
    });
    const moving = migrateSource(sourceId);
    await held.reached;
    await observe({
      sourceId,
      caseNumber: "XI. ÚS 1/2026",
      sourceDocumentId: "moving",
      listing: '{"newer":true}',
      file: "%PDF newer",
      order: 5n,
    });
    const newer = (await rowOf(a.decisionId))?.sourceRawS3Key;
    held.release();

    expect((await moving).counts.overtaken).toBe(1);
    expect((await rowOf(a.decisionId))?.sourceRawS3Key).toBe(newer);
  });

  test("a move racing an erasure leaves nothing under the erased decision", async () => {
    const sourceId = await createSource();
    const a = await legacyDecision({
      sourceId,
      caseNumber: "XI. ÚS 2/2026",
      listing: '{"only":"moved-then-erased"}',
      file: "%PDF moved then erased",
    });
    const held = fake.holdNext({
      method: "PUT",
      keyIncludes: prefixOf(sourceId, a.decisionId),
    });
    const moving = migrateSource(sourceId);
    await held.reached;
    await redact(a.decisionId);
    held.release();
    expect((await moving).counts.overtaken).toBe(1);

    await reconcileCaseLawRawSweeps({ scopedDb, limit: 100, signal: signal() });

    expect(keysUnder(prefixOf(sourceId, a.decisionId))).toEqual([]);
    // Only the older-layout original is left, for the source's sweep.
    expect(holding("moved-then-erased")).toEqual([bucketId(a.payloadKey)]);
    await sweepLegacy(sourceId);
    expect(holding("moved-then-erased")).toEqual([]);
  });
});

describe("the older layout's sweep", () => {
  test("refuses while anything live names that layout, then deletes only its keys", async () => {
    const sourceId = await createSource();
    const a = await legacyDecision({
      sourceId,
      caseNumber: "IX. ÚS 1/2026",
      listing: "{}",
      file: "%PDF one",
    });
    await observe({
      sourceId,
      caseNumber: "IX. ÚS 2/2026",
      sourceDocumentId: "current",
      listing: "{}",
      file: "%PDF two",
      order: 1n,
    });
    const current = await decisionIdOf(sourceId, "IX. ÚS 2/2026");
    const currentKeys = keysUnder(prefixOf(sourceId, current));

    expect(
      await sweepCaseLawLegacyRawSource({
        scopedDb,
        sourceId,
        mode: LEGACY_RAW_SWEEP_MODE.APPLY,
        signal: signal(),
      }),
    ).toMatchObject({ type: "refused", reason: "pointer" });
    expect(stored(a.payloadKey) && stored(a.fileKey)).toBe(true);

    await migrateSource(sourceId);
    // A payload in its own prefix naming the older layout: the pointer alone
    // would call this source clean.
    const own = (await rowOf(current))?.sourceRawS3Key ?? "";
    const ownEnvelope = new TextDecoder().decode(
      fake.objects.get(bucketId(own))?.bytes,
    );
    fake.put(
      envBase.S3_BUCKET,
      own,
      ownEnvelope.replace(
        keysUnder(prefixOf(sourceId, current)).find(
          (key) => !key.includes("/payloads/"),
        ) ?? "",
        () => a.fileKey,
      ),
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );
    expect(
      await sweepCaseLawLegacyRawSource({
        scopedDb,
        sourceId,
        mode: LEGACY_RAW_SWEEP_MODE.APPLY,
        signal: signal(),
      }),
    ).toMatchObject({ type: "refused", reason: "payload" });
    expect(stored(a.fileKey)).toBe(true);
    fake.put(
      envBase.S3_BUCKET,
      own,
      ownEnvelope,
      SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    );

    const plan = await sweepCaseLawLegacyRawSource({
      scopedDb,
      sourceId,
      mode: LEGACY_RAW_SWEEP_MODE.PLAN,
      signal: signal(),
    });
    expect(plan).toMatchObject({ type: "swept", legacyObjects: 2 });
    expect(stored(a.payloadKey)).toBe(true);

    expect(
      await sweepCaseLawLegacyRawSource({
        scopedDb,
        sourceId,
        mode: LEGACY_RAW_SWEEP_MODE.APPLY,
        signal: signal(),
      }),
    ).toMatchObject({
      type: "swept",
      legacyObjects: 2,
      referencedAfter: false,
    });
    expect(stored(a.payloadKey) || stored(a.fileKey)).toBe(false);
    expect(currentKeys.filter((key) => !stored(key))).toEqual([]);
    for (const decisionId of [a.decisionId, current]) {
      expect((await namedBy(decisionId)).filter((key) => !stored(key))).toEqual(
        [],
      );
    }
  });
});
