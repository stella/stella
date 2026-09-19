import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { caseLawCorpusTombstones } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { executedRows } from "@/api/lib/db/executed-rows";
import { formatCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import type { PackedCorpusLocation } from "@/api/lib/legal-search/corpus-location";
import {
  corpusTombstoneReaderForTx,
  CORPUS_TOMBSTONE_PRIME_MAX_AGE_MS,
  prefetchCorpusTombstones,
} from "@/api/lib/legal-search/corpus-tombstones";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * A denial only works if the role that serves the read can see it. That role
 * is not the one that writes tombstones, so the grant and the policy are the
 * whole of the guarantee: without them an erased member would keep being
 * served, and nothing else in the read path would notice.
 */

const DECISION_ID = toSafeId<"caseLawDecision">(
  "0198e331-e578-7000-8000-0000000004a1",
);
const PACK_KEY = "legal-corpus/packs/jurisdiction=CZE/deadbeef.stlpack";
const erased: PackedCorpusLocation = {
  type: "packed",
  packKey: PACK_KEY,
  offset: 0,
  length: 64,
  sha256: "a".repeat(64),
};
const surviving: PackedCorpusLocation = {
  type: "packed",
  packKey: PACK_KEY,
  offset: 64,
  length: 64,
  sha256: "b".repeat(64),
};

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
});

afterAll(async () => {
  await client.close();
});

afterEach(() => {
  setSystemTime();
});

beforeEach(async () => {
  await db.delete(caseLawCorpusTombstones).where(sql`true`);
  await db.insert(caseLawCorpusTombstones).values({
    location: formatCorpusLocation(erased),
    packKey: PACK_KEY,
    decisionId: DECISION_ID,
    reason: "redaction",
  });
});

test("the public reader role sees the denial it has to honour", async () => {
  const visible = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE stella_public_law_reader`);
    const read = corpusTombstoneReaderForTx(asTestRaw(tx));
    return await read([
      formatCorpusLocation(erased),
      formatCorpusLocation(surviving),
    ]);
  });

  // The erased member is refused and its pack-mate is not: the denial is per
  // address, not per object.
  expect([...visible]).toEqual([formatCorpusLocation(erased)]);
});

test("the reader role may read the denial and may not write one", async () => {
  const refusal = await db
    .transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_public_law_reader`);
      await tx.execute(
        sql`INSERT INTO case_law_corpus_tombstones
              (location, pack_key, decision_id, reason)
            VALUES ('pack:x@0+1#deadbeef', ${PACK_KEY}, ${DECISION_ID}, 'redaction')`,
      );
      return null;
    })
    .then(
      () => null,
      (error: unknown) => error,
    );

  // Refusing to serve is a read; recording the refusal is not something the
  // serving role may do.
  expect(refusal).not.toBeNull();
});

test("a hydration asks once for every address it is about to read", async () => {
  const asked: string[][] = [];
  const reader = await prefetchCorpusTombstones(
    [formatCorpusLocation(erased), formatCorpusLocation(surviving)],
    async (locations) => {
      asked.push([...locations]);
      return await db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE stella_public_law_reader`);
        const rows = executedRows(
          await tx.execute(
            sql`SELECT location FROM case_law_corpus_tombstones
                WHERE location IN ${locations}`,
          ),
        );
        return new Set(
          rows.map((row) => (isRecord(row) ? String(row["location"]) : "")),
        );
      });
    },
  );

  const first = await reader([formatCorpusLocation(erased)]);
  const second = await reader([formatCorpusLocation(surviving)]);

  // One question for the whole hydration, however many members it then reads.
  expect(asked).toHaveLength(1);
  expect([...first]).toEqual([formatCorpusLocation(erased)]);
  expect([...second]).toEqual([]);
});

test("a primed answer stops being served once it has aged out", async () => {
  // A holder that outlives a request — a batch, a replay, a long report —
  // would otherwise keep serving a member erased while it ran, because the
  // denial it primed was fetched before the erasure committed.
  const asked: string[][] = [];
  const read = async (locations: readonly string[]) => {
    asked.push([...locations]);
    return await db.transaction(async (tx) =>
      corpusTombstoneReaderForTx(asTestRaw(tx))(locations),
    );
  };
  const address = formatCorpusLocation(surviving);
  const startedAt = new Date("2026-09-19T08:00:00.000Z");
  setSystemTime(startedAt);
  const reader = await prefetchCorpusTombstones([address], read);

  expect([...(await reader([address]))]).toEqual([]);

  // The erasure commits while the holder is still reading.
  await db.insert(caseLawCorpusTombstones).values({
    location: address,
    packKey: PACK_KEY,
    decisionId: DECISION_ID,
    reason: "redaction",
  });
  setSystemTime(
    new Date(startedAt.getTime() + CORPUS_TOMBSTONE_PRIME_MAX_AGE_MS),
  );

  expect([...(await reader([address]))]).toEqual([address]);
  // Two queries: the prime, then the re-ask the age forced. The read in
  // between answered from the prime.
  expect(asked).toEqual([[address], [address]]);
});

test("an address the hydration never primed is asked about, not assumed", async () => {
  const later: PackedCorpusLocation = {
    type: "packed",
    packKey: PACK_KEY,
    offset: 128,
    length: 64,
    sha256: "c".repeat(64),
  };
  await db.insert(caseLawCorpusTombstones).values({
    location: formatCorpusLocation(later),
    packKey: PACK_KEY,
    decisionId: DECISION_ID,
    reason: "redaction",
  });
  const asked: string[][] = [];
  const read = async (locations: readonly string[]) => {
    asked.push([...locations]);
    return await db.transaction(async (tx) =>
      corpusTombstoneReaderForTx(asTestRaw(tx))(locations),
    );
  };

  const reader = await prefetchCorpusTombstones(
    [formatCorpusLocation(surviving)],
    read,
  );
  const unprimed = await reader([formatCorpusLocation(later)]);

  // A read can be repointed between the prefetch and the fetch: the
  // authoritative pointer reread hands back an address this hydration never
  // saw. Answering "not denied" for it would serve erased bytes, so the
  // reader asks rather than assumes.
  expect(asked).toHaveLength(2);
  expect(asked.at(1)).toEqual([formatCorpusLocation(later)]);
  expect([...unprimed]).toEqual([formatCorpusLocation(later)]);
});
