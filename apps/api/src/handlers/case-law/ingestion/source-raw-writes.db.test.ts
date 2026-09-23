import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { authRelationsPart } from "@/api/db/auth-schema";
import type { Transaction } from "@/api/db/root";
import type { ScopedDb } from "@/api/db/safe-db";
import { caseLawDecisions, caseLawSources, relations } from "@/api/db/schema";
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
import { startFakeS3 } from "@/api/tests/helpers/fake-s3";
import type { FakeS3 } from "@/api/tests/helpers/fake-s3";
import { createTestPglite } from "@/api/tests/pglite-test-db";

// What a re-observation of a decision costs in object storage. The bucket
// keeps every version it is written, so a PUT of bytes a key already holds is
// not a no-op: it is a second copy. The invariant is that an unchanged
// payload never produces a stored version, and a re-observation the row
// already records produces no request at all.

let fake: FakeS3;

beforeEach(() => {
  fake = startFakeS3();
});

afterEach(() => {
  fake.stop();
});

const connect = (client: Awaited<ReturnType<typeof createTestPglite>>) =>
  drizzle({ client, relations: { ...relations, ...authRelationsPart } });

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof connect>;

const scopedDb: ScopedDb = async (callback) =>
  // SAFETY: pglite stands in for the transaction the pipeline expects.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- the pglite handle is the test's transaction
  await callback(db as unknown as Transaction);

beforeAll(async () => {
  client = await createTestPglite();
  db = connect(client);
}, 120_000);

afterAll(async () => {
  await client.close();
});

const PDF = new TextEncoder().encode("%PDF-1.4 a decision the court serves");

const createSource = async (): Promise<SafeId<"caseLawSource">> => {
  const sourceId = createSafeId<"caseLawSource">();
  await db.insert(caseLawSources).values({
    id: sourceId,
    adapterKey: `source-raw-writes-${sourceId}`,
    name: "source raw writes fixture",
  });
  return sourceId;
};

type ObserveOptions = {
  sourceId: SafeId<"caseLawSource">;
  /** The listing part; changing it changes the envelope, not the file. */
  listing: string;
  order: bigint;
};

/** One observation of the same decision, as a crawl or a replay feeds it. */
const observe = async ({ sourceId, listing, order }: ObserveOptions) =>
  await processDecision({
    input: {
      caseNumber: "I. ÚS 1/2026",
      sourceDocumentId: "document-1",
      court: "Ústavný súd Slovenskej republiky",
      country: "SVK",
      language: "sk",
      fulltext: "Rozhodnutie o veci samej.",
      metadata: {},
      textFields: absentDecisionTextFields(TEXT_ABSENCE_REASON.NOT_PUBLISHED),
      rawHash: new Bun.CryptoHasher("sha256").update(listing).digest("hex"),
      documentAst: EMPTY_AST,
      sourceRaw: encodeSourceRawEnvelope({ listing }),
      sourceRawObjects: {
        "document-file": { bytes: PDF, contentType: "application/pdf" },
      },
      sourceRawContentType: SOURCE_RAW_ENVELOPE_CONTENT_TYPE,
    },
    sourceId,
    scopedDb,
    observedAt: new Date(),
    observationOrder: order,
    // Past the source-hash skip, the way a replay or a changed listing
    // reaches the raw write: the write itself must hold the invariant.
    refresh: DECISION_REFRESH.ALWAYS,
  });

const puts = () => fake.requests.filter(({ method }) => method === "PUT");

test("re-observing an unchanged decision with a publisher file writes nothing", async () => {
  const sourceId = await createSource();

  const first = await observe({ sourceId, listing: "{}", order: 1n });
  expect(first.status).toBe("complete");
  // The file and the envelope that names it; the fixture reaches the write.
  expect(puts()).toHaveLength(2);
  fake.requests.length = 0;

  const second = await observe({ sourceId, listing: "{}", order: 2n });

  expect(second.status).toBe("complete");
  expect(puts()).toEqual([]);
  expect([...fake.versions.values()]).toEqual([1, 1]);
});

test("a changed envelope over the same file adds no version of the file", async () => {
  const sourceId = await createSource();
  await observe({ sourceId, listing: '{"a":1}', order: 1n });
  const [before] = await db
    .select({ key: caseLawDecisions.sourceRawS3Key })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));

  const changed = await observe({ sourceId, listing: '{"a":2}', order: 2n });

  expect(changed.status).toBe("complete");
  const [after] = await db
    .select({ key: caseLawDecisions.sourceRawS3Key })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  // The envelope did change, so this observation did reach the write.
  expect(after?.key).not.toBe(before?.key);
  const fileVersions = [...fake.versions.entries()].filter(([id]) =>
    id.includes("/documents/"),
  );
  expect(fileVersions.map(([, count]) => count)).toEqual([1]);

  // Flipping back to an envelope stored before, which the row no longer
  // records, writes no version of that envelope either.
  fake.requests.length = 0;
  await observe({ sourceId, listing: '{"a":1}', order: 3n });
  const [back] = await db
    .select({ key: caseLawDecisions.sourceRawS3Key })
    .from(caseLawDecisions)
    .where(eq(caseLawDecisions.sourceId, sourceId));
  expect(back?.key).toBe(before?.key);
  expect(puts().map(({ ifNoneMatch }) => ifNoneMatch)).toEqual(["*", "*"]);
  expect(Math.max(...fake.versions.values())).toBe(1);
});
