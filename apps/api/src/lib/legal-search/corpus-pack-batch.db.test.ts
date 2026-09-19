import { Result } from "better-result";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import {
  CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS,
  caseLawCorpusPackRefs,
  caseLawCorpusTombstones,
  caseLawCorpusUploadIntents,
  caseLawDecisions,
  caseLawSources,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { reconcileCaseLawCorpusUploadIntents } from "@/api/lib/legal-search/case-law-corpus-upload-intents";
import { parseCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  CorpusPackError,
  decodePackFooter,
} from "@/api/lib/legal-search/corpus-pack";
import type { EncodedPack } from "@/api/lib/legal-search/corpus-pack";
import { openCorpusPackBatch } from "@/api/lib/legal-search/corpus-pack-batch";
import type {
  CorpusPackBatch,
  CorpusPackBatchEntry,
  CorpusPackBatchOutcomes,
  CorpusTransfer,
} from "@/api/lib/legal-search/corpus-pack-batch";
import {
  CORPUS_TRANSFER_MAX_BYTES,
  planCorpusDocumentWrite,
  readCorpusBytesAt,
  reclaimCorpusUpload as realReclaimCorpusUpload,
  storedCorpusWrite,
} from "@/api/lib/legal-search/corpus-storage";
import type { WriteCorpusResult } from "@/api/lib/legal-search/corpus-storage";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * The batch is what makes an ingestion page one transfer instead of one per
 * decision, so what it has to prove is not that a pack encodes: it is that a
 * page's decisions land in the same pack, that the reservations that own that
 * pack exist before it is transferred, and that one decision failing to
 * settle costs the page nothing but that decision.
 */

const SOURCE_ID = toSafeId<"caseLawSource">(
  "0198e331-e578-7000-8000-0000000003a0",
);
const FIRST_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-0000000003a1",
);
const SECOND_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-0000000003a2",
);
const THIRD_DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-0000000003a3",
);
const DECISION_IDS = [FIRST_DECISION_ID, SECOND_DECISION_ID, THIRD_DECISION_ID];

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;
let safeDb: SafeDb;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = asTestRaw<ScopedDb>(
    async (callback: (tx: typeof db) => Promise<unknown>) =>
      await db.transaction(async (tx) => await callback(asTestRaw(tx))),
  );
  safeDb = asTestRaw<SafeDb>(
    async (callback: (tx: typeof db) => Promise<unknown>) =>
      await Result.tryPromise({
        try: async () =>
          await db.transaction(async (tx) => await callback(asTestRaw(tx))),
        catch: (cause) => cause,
      }),
  );
});

afterAll(async () => {
  await client.close();
});

beforeEach(async () => {
  await db.delete(caseLawCorpusTombstones).where(sql`true`);
  await db.delete(caseLawCorpusPackRefs).where(sql`true`);
  await db.delete(caseLawCorpusUploadIntents).where(sql`true`);
  await db.delete(caseLawDecisions).where(sql`true`);
  await db.delete(caseLawSources).where(sql`true`);
  await db.insert(caseLawSources).values({
    id: SOURCE_ID,
    adapterKey: "pack-batch",
    name: "Pack batch",
  });
  await db.insert(caseLawDecisions).values(
    DECISION_IDS.map((id, index) => ({
      id,
      sourceId: SOURCE_ID,
      caseNumber: `4 As ${index}/2008`,
      court: "Nejvyšší správní soud",
      country: "CZE",
      language: "cs",
    })),
  );
});

/** A batch that could not answer at all is a failure of the test, not a case. */
const unwrapOutcomes = (
  flushed: Awaited<ReturnType<CorpusPackBatch["flush"]>>,
): CorpusPackBatchOutcomes => {
  if (Result.isError(flushed)) {
    throw flushed.error;
  }
  return flushed.value;
};

type SettledWrite = {
  decisionId: SafeId<"caseLawDecision">;
  written: WriteCorpusResult | null;
};

const entryFor = (
  decisionId: SafeId<"caseLawDecision">,
  text: string,
  settled: SettledWrite[],
  settle?: CorpusPackBatchEntry["settle"],
): CorpusPackBatchEntry => ({
  decisionId,
  jurisdiction: "CZE",
  payload: {
    text,
    sections: [{ index: 0, type: "ruling", title: null, text }],
    ast: null,
  },
  stored: null,
  settle:
    settle ??
    (async ({ intentId, written }) => {
      settled.push({ decisionId, written });
      // What the real settlement does in the transaction that repoints the
      // row: the reservation stops owning addresses the row now carries.
      await db
        .delete(caseLawCorpusUploadIntents)
        .where(eq(caseLawCorpusUploadIntents.id, intentId));
      return { type: "settled" };
    }),
});

/** The denial list as the corpus reader asks for it, over the test database. */
const tombstonesFrom =
  (database: typeof db) =>
  async (locations: readonly string[]): Promise<ReadonlySet<string>> => {
    const rows = await database
      .select({ location: caseLawCorpusTombstones.location })
      .from(caseLawCorpusTombstones)
      .where(inArray(caseLawCorpusTombstones.location, [...locations]));
    return new Set(rows.map((row) => row.location));
  };

/** Records what was transferred, and what the database held at that moment. */
const recordingTransfer = () => {
  const transferred: EncodedPack[] = [];
  const reservedAtTransfer: string[] = [];
  const transfer = {
    layout: "packs",
    putPacks: async ({ packs }) => {
      transferred.push(...packs);
      const rows = await db
        .select({ packKey: caseLawCorpusUploadIntents.packKey })
        .from(caseLawCorpusUploadIntents);
      reservedAtTransfer.push(
        ...rows.flatMap(({ packKey }) => (packKey === null ? [] : [packKey])),
      );
      return await Promise.resolve(Result.ok(undefined));
    },
  } as const satisfies CorpusTransfer;
  return { transferred, reservedAtTransfer, transfer };
};

test("a page of decisions becomes one pack whose members they all address", async () => {
  const settled: SettledWrite[] = [];
  const { transferred, reservedAtTransfer, transfer } = recordingTransfer();
  const batch = openCorpusPackBatch({ scopedDb, transfer });
  for (const [index, decisionId] of DECISION_IDS.entries()) {
    batch.enqueue(entryFor(decisionId, `Rozsudek ${index}.`, settled));
  }

  const outcomes = unwrapOutcomes(await batch.flush());

  expect([...outcomes.values()]).toEqual(
    DECISION_IDS.map(() => ({ type: "settled" })),
  );
  expect(transferred).toHaveLength(1);
  const pack = transferred.at(0) ?? expect.unreachable();
  // Three payloads for each of three decisions, in one object.
  const decoded = await decodePackFooter(pack.bytes);
  if (Result.isError(decoded)) {
    throw decoded.error;
  }
  const footer = decoded.value;
  expect(footer.members).toHaveLength(9);
  expect(new Set(footer.members.map(({ documentId }) => documentId))).toEqual(
    new Set(DECISION_IDS),
  );

  expect(settled).toHaveLength(3);
  for (const { written } of settled) {
    const location = parseCorpusLocation(written?.textKey ?? "");
    expect(location.type).toBe("packed");
    if (location.type !== "packed") {
      continue;
    }
    expect(location.packKey).toBe(pack.packKey);
    // The address carries the digest the reader verifies against.
    expect(location.sha256).toMatch(/^[0-9a-f]{64}$/u);
  }

  // Every one of those addresses was owned by a reservation before the pack
  // left the process, which is what makes an orphaned pack recoverable.
  expect(reservedAtTransfer).toEqual(DECISION_IDS.map(() => pack.packKey));
  expect(
    await db
      .select({ id: caseLawCorpusUploadIntents.id })
      .from(caseLawCorpusUploadIntents),
  ).toEqual([]);
});

test("a decision whose payload is unchanged contributes no member", async () => {
  const settled: SettledWrite[] = [];
  const first = recordingTransfer();
  const firstBatch = openCorpusPackBatch({
    scopedDb,
    transfer: first.transfer,
  });
  firstBatch.enqueue(entryFor(FIRST_DECISION_ID, "Rozsudek.", settled));
  unwrapOutcomes(await firstBatch.flush());
  const stored = settled.at(0)?.written ?? expect.unreachable();

  const resettled: SettledWrite[] = [];
  const second = recordingTransfer();
  const secondBatch = openCorpusPackBatch({
    scopedDb,
    transfer: second.transfer,
  });
  secondBatch.enqueue({
    ...entryFor(FIRST_DECISION_ID, "Rozsudek.", resettled),
    stored,
  });

  unwrapOutcomes(await secondBatch.flush());

  // A re-observation of the same document re-packs nothing: the addresses the
  // row already carries name this jurisdiction's partition and this payload.
  expect(second.transferred).toEqual([]);
  expect(resettled.at(0)?.written).toEqual(stored);
});

test("one decision that cannot settle leaves the rest of the page settled", async () => {
  const settled: SettledWrite[] = [];
  const failure = new Error("row fence lost");
  const { transfer } = recordingTransfer();
  const batch = openCorpusPackBatch({ scopedDb, transfer });
  batch.enqueue(entryFor(FIRST_DECISION_ID, "Rozsudek 0.", settled));
  batch.enqueue(
    entryFor(SECOND_DECISION_ID, "Rozsudek 1.", settled, async () => {
      await Promise.resolve();
      throw failure;
    }),
  );
  batch.enqueue(entryFor(THIRD_DECISION_ID, "Rozsudek 2.", settled));

  const outcomes = unwrapOutcomes(await batch.flush());

  expect(outcomes.get(FIRST_DECISION_ID)).toEqual({ type: "settled" });
  expect(outcomes.get(THIRD_DECISION_ID)).toEqual({ type: "settled" });
  expect(outcomes.get(SECOND_DECISION_ID)).toEqual({
    type: "failed",
    error: failure,
  });
  // Its members stay in the pack unreferenced; the reservation left behind is
  // what makes them reclaimable.
  expect(
    await db
      .select({
        decisionId: caseLawCorpusUploadIntents.decisionId,
        status: caseLawCorpusUploadIntents.status,
      })
      .from(caseLawCorpusUploadIntents)
      .where(eq(caseLawCorpusUploadIntents.decisionId, SECOND_DECISION_ID)),
  ).toEqual([
    {
      decisionId: SECOND_DECISION_ID,
      status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP,
    },
  ]);
});

/**
 * A settlement that records the pointer and its pack reference the way the
 * fenced one does, so the liveness question below has something to answer.
 */
const recordingSettle =
  (decisionId: SafeId<"caseLawDecision">): CorpusPackBatchEntry["settle"] =>
  async ({ intentId, written }) => {
    const textLocation = parseCorpusLocation(written?.textKey ?? "");
    await db
      .update(caseLawDecisions)
      .set({
        textS3Key: written?.textKey ?? null,
        normalizedS3Key: written?.sectionsKey ?? null,
        astS3Key: written?.astKey ?? null,
        contentHash: written?.contentHash ?? null,
      })
      .where(eq(caseLawDecisions.id, decisionId));
    if (textLocation.type === "packed") {
      await db.insert(caseLawCorpusPackRefs).values({
        decisionId,
        kind: "text",
        packKey: textLocation.packKey,
        location: written?.textKey ?? "",
      });
    }
    await db
      .delete(caseLawCorpusUploadIntents)
      .where(eq(caseLawCorpusUploadIntents.id, intentId));
    return { type: "settled" };
  };

test("a decision that fails after the transfer leaves its members discoverable", async () => {
  const settled: SettledWrite[] = [];
  const { transferred, transfer } = recordingTransfer();
  const batch = openCorpusPackBatch({ scopedDb, transfer });
  batch.enqueue(entryFor(FIRST_DECISION_ID, "Rozsudek 0.", settled));
  batch.enqueue(
    entryFor(SECOND_DECISION_ID, "Rozsudek 1.", settled, async () => {
      await Promise.resolve();
      throw new Error("row fence lost after the pack landed");
    }),
  );

  await batch.flush();

  const pack = transferred.at(0) ?? expect.unreachable();
  // The pack holds both decisions' payloads whatever became of the rows.
  const decoded = await decodePackFooter(pack.bytes);
  if (Result.isError(decoded)) {
    throw decoded.error;
  }
  expect(decoded.value.members).toHaveLength(6);
  const orphaned = (
    await db
      .select({
        status: caseLawCorpusUploadIntents.status,
        packKey: caseLawCorpusUploadIntents.packKey,
        textKey: caseLawCorpusUploadIntents.textS3Key,
      })
      .from(caseLawCorpusUploadIntents)
      .where(eq(caseLawCorpusUploadIntents.decisionId, SECOND_DECISION_ID))
  ).at(0);
  // Its row points nowhere, so the only record of the bytes it left behind
  // is the reservation: it names the pack and the exact addresses inside it.
  expect(orphaned?.status).toBe(CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.CLEANUP);
  expect(orphaned?.packKey).toBe(pack.packKey);
  expect(parseCorpusLocation(orphaned?.textKey ?? "")).toMatchObject({
    type: "packed",
    packKey: pack.packKey,
  });
});

test("a reclaimed reservation never releases a pack another row still reaches into", async () => {
  const settled: SettledWrite[] = [];
  const { transferred, transfer } = recordingTransfer();
  const first = openCorpusPackBatch({ scopedDb, transfer });
  first.enqueue({
    ...entryFor(FIRST_DECISION_ID, "Rozsudek 0.", settled),
    settle: recordingSettle(FIRST_DECISION_ID),
  });
  first.enqueue(
    entryFor(SECOND_DECISION_ID, "Rozsudek 1.", settled, async () => {
      await Promise.resolve();
      throw new Error("row fence lost after the pack landed");
    }),
  );
  unwrapOutcomes(await first.flush());
  const sharedPack = (transferred.at(0) ?? expect.unreachable()).packKey;

  // The abandoned reservation's lease runs out, which is what makes a later
  // batch free to take the decision over.
  await db
    .update(caseLawCorpusUploadIntents)
    .set({
      status: CASE_LAW_CORPUS_UPLOAD_INTENT_STATUS.ACTIVE,
      nextCleanupAt: null,
      leaseExpiresAt: new Date("2020-01-01T00:00:00.000Z"),
    })
    .where(eq(caseLawCorpusUploadIntents.decisionId, SECOND_DECISION_ID));

  const reclaimed: SettledWrite[] = [];
  const second = openCorpusPackBatch({
    scopedDb,
    transfer: recordingTransfer().transfer,
  });
  second.enqueue({
    ...entryFor(SECOND_DECISION_ID, "Rozsudek 1 v2.", reclaimed),
    settle: recordingSettle(SECOND_DECISION_ID),
  });

  expect(unwrapOutcomes(await second.flush()).get(SECOND_DECISION_ID)).toEqual({
    type: "settled",
  });

  // Cleanup now runs against the reservation the reclaim superseded. Its
  // addresses sit in the pack the first decision's row still reaches into,
  // so nothing about that pack may be released.
  const erased: string[] = [];
  const reconciled = await reconcileCaseLawCorpusUploadIntents({
    reclaim: async (options) =>
      await realReclaimCorpusUpload({
        ...options,
        deleteObject: async (key) => {
          erased.push(key);
          await Promise.resolve();
        },
      }),
    limit: 10,
    safeDb,
  });

  // The cleanup did claim it, so a vacuous run proves nothing here. Its row
  // goes — a reservation inside a pack other rows keep alive has nothing to
  // reclaim, and keeping it would retry it for ever — but the pack itself is
  // untouched.
  expect(reconciled.claimed).toBeGreaterThan(0);
  expect(reconciled.cleaned).toBeGreaterThan(0);
  expect(erased).toEqual([]);
  expect(
    await db
      .select({ location: caseLawCorpusTombstones.location })
      .from(caseLawCorpusTombstones),
  ).toEqual([]);
  expect(
    (
      await db
        .select({ packKey: caseLawCorpusPackRefs.packKey })
        .from(caseLawCorpusPackRefs)
        .where(eq(caseLawCorpusPackRefs.decisionId, FIRST_DECISION_ID))
    ).map(({ packKey }) => packKey),
  ).toEqual([sharedPack]);
});

test("a failed transfer is reclaimed without denying the addresses its retry reuses", async () => {
  const settled: SettledWrite[] = [];
  const failing = openCorpusPackBatch({
    scopedDb,
    transfer: {
      layout: "packs",
      putPacks: async () =>
        await Promise.resolve(
          Result.err(new CorpusPackError({ message: "bucket unreachable" })),
        ),
    },
  });
  failing.enqueue(entryFor(FIRST_DECISION_ID, "Rozsudek 0.", settled));
  failing.enqueue(entryFor(SECOND_DECISION_ID, "Rozsudek 1.", settled));
  unwrapOutcomes(await failing.flush());

  // Cleanup owns the reservations of a transfer that never landed.
  const released: string[] = [];
  await reconcileCaseLawCorpusUploadIntents({
    reclaim: async (options) =>
      await realReclaimCorpusUpload({
        ...options,
        deleteObject: async (key) => {
          released.push(key);
          await Promise.resolve();
        },
      }),
    limit: 10,
    safeDb,
  });

  // The page is retried: the same payloads derive the same addresses.
  const retried: SettledWrite[] = [];
  const { transferred, transfer } = recordingTransfer();
  const retry = openCorpusPackBatch({ scopedDb, transfer });
  retry.enqueue({
    ...entryFor(FIRST_DECISION_ID, "Rozsudek 0.", retried),
    settle: recordingSettle(FIRST_DECISION_ID),
  });
  retry.enqueue({
    ...entryFor(SECOND_DECISION_ID, "Rozsudek 1.", retried),
    settle: recordingSettle(SECOND_DECISION_ID),
  });

  const outcomes = unwrapOutcomes(await retry.flush());

  expect(outcomes.get(FIRST_DECISION_ID)).toEqual({ type: "settled" });
  expect(outcomes.get(SECOND_DECISION_ID)).toEqual({ type: "settled" });
  const pack = transferred.at(0) ?? expect.unreachable();

  // Nothing about the abandoned attempt may deny the retry: a reservation
  // whose PUT never landed owns no bytes any reader was ever told about, so
  // tombstoning its planned addresses would make the settled rows above
  // unreadable for good.
  expect(
    await db
      .select({ location: caseLawCorpusTombstones.location })
      .from(caseLawCorpusTombstones),
  ).toEqual([]);
  const readFromPack = async (
    storedKey: string,
    bytes: Uint8Array,
  ): Promise<number> => {
    const location = parseCorpusLocation(storedKey);
    if (location.type !== "packed") {
      throw new Error("the retry did not settle a packed address");
    }
    const read = await readCorpusBytesAt({
      location,
      maxBytes: CORPUS_TRANSFER_MAX_BYTES,
      signal: AbortSignal.timeout(1000),
      readRange: async ({ offset, length }) =>
        await Promise.resolve(bytes.subarray(offset, offset + length)),
      readTombstones: tombstonesFrom(db),
    });
    return read.byteLength;
  };
  const read = await Promise.all(
    retried.map(
      async ({ written }) =>
        await readFromPack(written?.textKey ?? "", pack.bytes),
    ),
  );
  // Every settled address serves its member: the digest in the address
  // matches the bytes, and no tombstone refuses them.
  expect(read).toEqual(
    retried.map(({ written }) => {
      const location = parseCorpusLocation(written?.textKey ?? "");
      return location.type === "packed" ? location.length : 0;
    }),
  );
  // The reclaim reaches object storage for the pack nothing references, and
  // leaves no denial behind.
  expect(released).not.toEqual([]);
});

test("the object layout writes one object per payload and settles the same rows", async () => {
  const settled: SettledWrite[] = [];
  const written: string[] = [];
  const batch = openCorpusPackBatch({
    scopedDb,
    transfer: {
      layout: "objects",
      writeObjects: async (input) => {
        const planned = planCorpusDocumentWrite(input);
        if (planned.type !== "put") {
          return planned;
        }
        written.push(planned.written.textKey);
        return await Promise.resolve({
          type: "written",
          written: planned.written,
        });
      },
    },
  });
  batch.enqueue(entryFor(FIRST_DECISION_ID, "Rozsudek 0.", settled));
  batch.enqueue(entryFor(SECOND_DECISION_ID, "Rozsudek 1.", settled));

  const outcomes = unwrapOutcomes(await batch.flush());

  // The deployment that has nowhere to put a pack's erasure debt keeps the
  // layout the corpus has always had, through the same batch, the same
  // reservations and the same settlement.
  expect([...outcomes.values()]).toEqual([
    { type: "settled" },
    { type: "settled" },
  ]);
  // Nothing is packed: an `objects` transfer carries no pack client at all,
  // so the pack path is unreachable rather than merely unused.
  expect(written).toHaveLength(2);
  for (const { written: addresses } of settled) {
    expect(parseCorpusLocation(addresses?.textKey ?? "").type).toBe("object");
  }
});

test("in the object layout one failed write costs only its own decision", async () => {
  const settled: SettledWrite[] = [];
  const failure = new Error("AccessDenied");
  const wroteFor = new Set<string>();
  const objectBatch = () =>
    openCorpusPackBatch({
      scopedDb,
      transfer: {
        layout: "objects",
        writeObjects: async (input) => {
          if (input.documentId === THIRD_DECISION_ID) {
            // Deterministic: the same decision fails on every attempt, which
            // is what a poisoned payload looks like to the page that carries
            // it.
            throw failure;
          }
          const planned = planCorpusDocumentWrite(input);
          if (planned.type !== "put") {
            return planned;
          }
          wroteFor.add(input.documentId);
          return await Promise.resolve({
            type: "written",
            written: planned.written,
          });
        },
      },
    });

  const batch = objectBatch();
  batch.enqueue({
    ...entryFor(FIRST_DECISION_ID, "Rozsudek 0.", settled),
    settle: recordingSettle(FIRST_DECISION_ID),
  });
  batch.enqueue({
    ...entryFor(SECOND_DECISION_ID, "Rozsudek 1.", settled),
    settle: recordingSettle(SECOND_DECISION_ID),
  });
  batch.enqueue({
    ...entryFor(THIRD_DECISION_ID, "Rozsudek 2.", settled),
    settle: recordingSettle(THIRD_DECISION_ID),
  });

  const outcomes = unwrapOutcomes(await batch.flush());

  // Standalone objects share nothing, so a write that fails is one
  // decision's failure. Failing its page-mates would reclaim objects that
  // already landed and leave a deterministic failure stalling the source.
  expect(outcomes.get(FIRST_DECISION_ID)).toEqual({ type: "settled" });
  expect(outcomes.get(SECOND_DECISION_ID)).toEqual({ type: "settled" });
  expect(outcomes.get(THIRD_DECISION_ID)).toEqual({
    type: "failed",
    error: failure,
  });
  const settledRows = await db
    .select({
      id: caseLawDecisions.id,
      textS3Key: caseLawDecisions.textS3Key,
    })
    .from(caseLawDecisions)
    .where(
      inArray(caseLawDecisions.id, [FIRST_DECISION_ID, SECOND_DECISION_ID]),
    );
  expect(settledRows.map(({ textS3Key }) => textS3Key !== null)).toEqual([
    true,
    true,
  ]);
  // Only the failed decision keeps a reservation for cleanup to reclaim.
  expect(
    (
      await db
        .select({ decisionId: caseLawCorpusUploadIntents.decisionId })
        .from(caseLawCorpusUploadIntents)
    ).map(({ decisionId }) => decisionId),
  ).toEqual([THIRD_DECISION_ID]);

  // The page is retried: the two settled decisions have nothing left to
  // write, and the third still reports its failure rather than the page.
  const retried: SettledWrite[] = [];
  wroteFor.clear();
  const retry = objectBatch();
  const rows = await db
    .select({
      id: caseLawDecisions.id,
      textS3Key: caseLawDecisions.textS3Key,
      normalizedS3Key: caseLawDecisions.normalizedS3Key,
      astS3Key: caseLawDecisions.astS3Key,
      contentHash: caseLawDecisions.contentHash,
    })
    .from(caseLawDecisions);
  for (const [decisionId, text] of [
    [FIRST_DECISION_ID, "Rozsudek 0."],
    [SECOND_DECISION_ID, "Rozsudek 1."],
    [THIRD_DECISION_ID, "Rozsudek 2."],
  ] as const) {
    // What the pipeline hands a retry: the write the row records, which for
    // the two settled decisions is this exact payload.
    const row = rows.find(({ id }) => id === decisionId);
    retry.enqueue({
      ...entryFor(decisionId, text, retried),
      stored: row === undefined ? null : storedCorpusWrite(row),
      settle: recordingSettle(decisionId),
    });
  }

  const retryOutcomes = unwrapOutcomes(await retry.flush());

  expect([...wroteFor]).toEqual([]);
  expect(retryOutcomes.get(FIRST_DECISION_ID)).toEqual({ type: "settled" });
  expect(retryOutcomes.get(THIRD_DECISION_ID)).toEqual({
    type: "failed",
    error: failure,
  });
});
