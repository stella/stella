import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { asc, eq, isNotNull, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";

import type { DocumentAst } from "@stll/legal-ast/document-ast";

import {
  legislationDocuments,
  legislationSources,
  legislationWorkChanges,
} from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * `payload_revision` is owned by the database and `legislation_work_changes`
 * is filled by triggers. Each input column declares a change below; the
 * structural test holds that declaration equal to the columns the triggers
 * read, so an input added to one side and not the other fails here.
 */

const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000c01",
);
const OTHER_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000c02",
);
const DOCUMENT_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000000c03",
);
const UPSERT_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000000c04",
);

const EPOCH_GUARD_MIGRATION_URL = new URL(
  "../../drizzle/20260825142000_corpus_index_projection_intents/migration.sql",
  import.meta.url,
);
const EPOCH_GUARD_STATEMENTS = [
  'CREATE FUNCTION "guard_corpus_projection_epoch"',
  'CREATE TRIGGER "legislation_documents_projection_epoch_monotonic"',
] as const;

const astWith = (text: string) =>
  ({
    version: 1,
    source: { system: "test", documentId: "test", webUrl: "", printUrl: "" },
    metadata: {
      caseNumber: null,
      ecli: null,
      court: null,
      decisionDate: null,
      decisionType: null,
      keywords: [],
      statutes: [],
    },
    blocks: [
      {
        id: "p1",
        anchorId: "par_1",
        type: "paragraph",
        inlines: [{ type: "text", text }],
        plainText: text,
      },
    ],
  }) as const satisfies DocumentAst;

const BASE_ROW = {
  id: DOCUMENT_ID,
  sourceId: SOURCE_ID,
  eli: "eli/cz/sb/2012/89",
  title: "Občanský zákoník",
  country: "CZE",
  language: "cs",
  versionValidFrom: "2024-01-01",
  versionValidTo: "2024-12-31",
  documentAst: astWith("§ 1 Předmět úpravy"),
  astS3Key: "legislation/cze/2012/89/ast-a.zst",
  textS3Key: null,
  contentHash: "a".repeat(64),
} as const satisfies typeof legislationDocuments.$inferInsert;

/**
 * One change per payload input, keyed by SQL column name. Changes cover
 * value to value, value to null and null to value, so the comparison is
 * proven null-safe.
 */
const PAYLOAD_INPUT_CHANGES = {
  document_ast: { documentAst: astWith("§ 1 Předmět a rozsah úpravy") },
  ast_s3_key: { astS3Key: "legislation/cze/2012/89/ast-b.zst" },
  content_hash: { contentHash: "b".repeat(64) },
  text_s3_key: { textS3Key: "legislation/cze/2012/89/text-b.zst" },
  source_id: { sourceId: OTHER_SOURCE_ID },
  language: { language: "en" },
  eli: { eli: "eli/cz/sb/2012/90" },
  version_valid_from: { versionValidFrom: "2023-06-01" },
  version_valid_to: { versionValidTo: null },
  country: { country: "SVK" },
} as const satisfies Record<
  string,
  Partial<typeof legislationDocuments.$inferInsert>
>;
type PayloadInput = keyof typeof PAYLOAD_INPUT_CHANGES;
const PAYLOAD_INPUTS = Object.keys(PAYLOAD_INPUT_CHANGES).filter(
  (column): column is PayloadInput => column in PAYLOAD_INPUT_CHANGES,
);
const SCALAR_INPUTS = PAYLOAD_INPUTS.filter(
  (column) => column !== "document_ast",
);

/** Columns outside the payload that writers routinely update. */
const UNRELATED_CHANGES = {
  title: { title: "Zákon č. 89/2012 Sb., občanský zákoník" },
  fulltext: { fulltext: "§ 1 Předmět úpravy" },
  status: { status: "repealed" },
  projection_epoch: { projectionEpoch: 3n },
  citation_count: { citationCount: 12 },
  updated_at: { updatedAt: new Date("2026-01-01T00:00:00Z") },
} as const satisfies Record<
  string,
  Partial<typeof legislationDocuments.$inferInsert>
>;

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const errorMessageChain = (error: unknown): string => {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join(" | ");
};

const rejectionMessage = async (run: Promise<unknown>): Promise<string> =>
  await run.then(
    () => "no rejection",
    (error: unknown) => errorMessageChain(error),
  );

const REFUSAL = "legislation payload revision is maintained by the database";

const revisionOf = async (id: typeof DOCUMENT_ID) => {
  const [row] = await db
    .select({ revision: legislationDocuments.payloadRevision })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.id, id));
  return row?.revision;
};

const workChanges = async () =>
  await db
    .select({
      country: legislationWorkChanges.country,
      eli: legislationWorkChanges.eli,
    })
    .from(legislationWorkChanges)
    .orderBy(asc(legislationWorkChanges.id));

const clearWorkChanges = async () => {
  await db.delete(legislationWorkChanges).where(sql`true`);
};

const insertBaseRow = async () => {
  await db.insert(legislationDocuments).values(BASE_ROW);
  await clearWorkChanges();
};

const BASE_KEY = { country: BASE_ROW.country, eli: BASE_ROW.eli };

/** The keys an update from the base row to `next` must record, in order. */
const expectedKeys = (
  next: Partial<typeof legislationDocuments.$inferInsert>,
) => {
  const nextKey = {
    country: next.country ?? BASE_KEY.country,
    eli: next.eli ?? BASE_KEY.eli,
  };
  return nextKey.country === BASE_KEY.country && nextKey.eli === BASE_KEY.eli
    ? [BASE_KEY]
    : [BASE_KEY, nextKey];
};

beforeAll(
  async () => {
    client = await createTestPglite();
    db = drizzle({ client });

    const migration = await Bun.file(EPOCH_GUARD_MIGRATION_URL).text();
    for (const statement of migration.split("--> statement-breakpoint")) {
      const ddl = statement.trim();
      if (EPOCH_GUARD_STATEMENTS.some((prefix) => ddl.startsWith(prefix))) {
        await db.execute(sql.raw(ddl));
      }
    }

    await db.insert(legislationSources).values([
      { id: SOURCE_ID, adapterKey: "payload-revision-a", name: "Source A" },
      {
        id: OTHER_SOURCE_ID,
        adapterKey: "payload-revision-b",
        name: "Source B",
      },
    ]);
  },
  { timeout: 120_000 },
);

beforeEach(async () => {
  await db.delete(legislationDocuments).where(sql`true`);
  await clearWorkChanges();
});

afterAll(async () => {
  await client.close();
});

describe("trigger definitions", () => {
  test("the revision triggers read exactly the declared payload inputs, and the change trigger keys on the revision", async () => {
    const functionSource = await db.execute<{ prosrc: string }>(sql`
      SELECT prosrc FROM pg_proc
      WHERE proname = 'advance_legislation_payload_revision'
    `);
    const source = functionSource.rows.at(0)?.prosrc ?? "";
    const comparedByRowPath = new Set(
      [...source.matchAll(/OLD\."(?<column>[a-z0-9_]+)"/gu)]
        .map((match) => match.groups?.["column"] ?? "")
        .filter((column) => column !== "payload_revision"),
    );
    const astTriggerColumns = await db.execute<{ attname: string }>(sql`
      SELECT attribute.attname
      FROM pg_trigger trigger_row
      JOIN pg_attribute attribute
        ON attribute.attrelid = trigger_row.tgrelid
       AND attribute.attnum = ANY (trigger_row.tgattr)
      WHERE trigger_row.tgname = 'legislation_documents_payload_revision_ast'
    `);
    const triggerInputs = new Set([
      ...comparedByRowPath,
      ...astTriggerColumns.rows.map(({ attname }) => attname),
    ]);

    expect(comparedByRowPath.has("document_ast")).toBe(false);
    expect([...triggerInputs].toSorted()).toEqual(PAYLOAD_INPUTS.toSorted());

    const changeTrigger = await db.execute<{ definition: string }>(sql`
      SELECT pg_get_triggerdef(oid) AS definition FROM pg_trigger
      WHERE tgname = 'legislation_documents_work_change_update'
    `);
    expect(changeTrigger.rows.at(0)?.definition).toContain(
      "WHEN ((old.payload_revision IS DISTINCT FROM new.payload_revision))",
    );
  });

  test("the row path fires before the AST path, and both before the epoch guard", async () => {
    const triggers = await db.execute<{ tgname: string }>(sql`
      SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'legislation_documents'::regclass
        AND NOT tgisinternal
        AND tgtype & 2 = 2
        AND tgtype & 16 = 16
      ORDER BY tgname COLLATE "C"
    `);
    expect(triggers.rows.map(({ tgname }) => tgname)).toEqual([
      "legislation_documents_payload_revision",
      "legislation_documents_payload_revision_ast",
      "legislation_documents_projection_epoch_monotonic",
    ]);
  });
});

describe("payload revision", () => {
  test("an insert starts at 1 and records the new work", async () => {
    await db.insert(legislationDocuments).values(BASE_ROW);

    expect(await revisionOf(DOCUMENT_ID)).toBe(1n);
    expect(await workChanges()).toEqual([BASE_KEY]);
  });

  test("an insert cannot supply its own revision", async () => {
    expect(
      await rejectionMessage(
        db
          .insert(legislationDocuments)
          .values({ ...BASE_ROW, payloadRevision: 7n }),
      ),
    ).toContain(REFUSAL);
  });

  test.each(PAYLOAD_INPUTS)(
    "changing %s alone advances the revision once and records the work",
    async (column) => {
      await insertBaseRow();
      const change = PAYLOAD_INPUT_CHANGES[column];

      await db
        .update(legislationDocuments)
        .set(change)
        .where(eq(legislationDocuments.id, DOCUMENT_ID));

      expect(await revisionOf(DOCUMENT_ID)).toBe(2n);
      expect(await workChanges()).toEqual(expectedKeys(change));
    },
  );

  test.each(SCALAR_INPUTS)(
    "changing document_ast with %s in one statement advances the revision once",
    async (column) => {
      await insertBaseRow();
      const change = {
        ...PAYLOAD_INPUT_CHANGES.document_ast,
        ...PAYLOAD_INPUT_CHANGES[column],
      };

      await db
        .update(legislationDocuments)
        .set(change)
        .where(eq(legislationDocuments.id, DOCUMENT_ID));

      expect(await revisionOf(DOCUMENT_ID)).toBe(2n);
      expect(await workChanges()).toEqual(expectedKeys(change));
    },
  );

  test("changing every input in one statement advances the revision once", async () => {
    await insertBaseRow();
    const change: Partial<typeof legislationDocuments.$inferInsert> = {};
    for (const inputChange of Object.values(PAYLOAD_INPUT_CHANGES)) {
      Object.assign(change, inputChange);
    }

    await db
      .update(legislationDocuments)
      .set(change)
      .where(eq(legislationDocuments.id, DOCUMENT_ID));

    expect(await revisionOf(DOCUMENT_ID)).toBe(2n);
    expect(await workChanges()).toEqual([
      BASE_KEY,
      {
        country: PAYLOAD_INPUT_CHANGES.country.country,
        eli: PAYLOAD_INPUT_CHANGES.eli.eli,
      },
    ]);
  });

  test("successive changes keep advancing", async () => {
    await insertBaseRow();
    await db
      .update(legislationDocuments)
      .set(PAYLOAD_INPUT_CHANGES.content_hash)
      .where(eq(legislationDocuments.id, DOCUMENT_ID));
    await db
      .update(legislationDocuments)
      .set(PAYLOAD_INPUT_CHANGES.document_ast)
      .where(eq(legislationDocuments.id, DOCUMENT_ID));

    expect(await revisionOf(DOCUMENT_ID)).toBe(3n);
  });

  test("assigning every input its current value changes nothing", async () => {
    await insertBaseRow();
    const { id: _id, title: _title, ...inputs } = BASE_ROW;
    expect(Object.keys(inputs).length).toBe(PAYLOAD_INPUTS.length);

    await db
      .update(legislationDocuments)
      .set(inputs)
      .where(eq(legislationDocuments.id, DOCUMENT_ID));

    expect(await revisionOf(DOCUMENT_ID)).toBe(1n);
    expect(await workChanges()).toEqual([]);
  });

  test.each(Object.entries(UNRELATED_CHANGES))(
    "changing %s leaves the revision and the work alone",
    async (_column, change) => {
      await insertBaseRow();

      await db
        .update(legislationDocuments)
        .set(change)
        .where(eq(legislationDocuments.id, DOCUMENT_ID));

      expect(await revisionOf(DOCUMENT_ID)).toBe(1n);
      expect(await workChanges()).toEqual([]);
    },
  );

  test("a client cannot set or reset the revision, with or without the AST", async () => {
    await insertBaseRow();
    await db
      .update(legislationDocuments)
      .set(PAYLOAD_INPUT_CHANGES.content_hash)
      .where(eq(legislationDocuments.id, DOCUMENT_ID));

    for (const change of [
      { payloadRevision: 1n },
      { payloadRevision: 3n },
      { payloadRevision: 3n, ...PAYLOAD_INPUT_CHANGES.document_ast },
      { payloadRevision: 3n, ...PAYLOAD_INPUT_CHANGES.ast_s3_key },
    ]) {
      expect(
        await rejectionMessage(
          db
            .update(legislationDocuments)
            .set(change)
            .where(eq(legislationDocuments.id, DOCUMENT_ID)),
        ),
      ).toContain(REFUSAL);
    }
    expect(await revisionOf(DOCUMENT_ID)).toBe(2n);

    // Restating the current value is not a conflict.
    await db
      .update(legislationDocuments)
      .set({ payloadRevision: 2n, title: "Restated" })
      .where(eq(legislationDocuments.id, DOCUMENT_ID));
    expect(await revisionOf(DOCUMENT_ID)).toBe(2n);
  });
});

describe("upsert", () => {
  const upsert = (
    values: typeof legislationDocuments.$inferInsert,
    set: PgUpdateSetSource<typeof legislationDocuments>,
  ) =>
    db
      .insert(legislationDocuments)
      .values(values)
      .onConflictDoUpdate({
        target: [
          legislationDocuments.sourceId,
          legislationDocuments.eli,
          legislationDocuments.versionValidFrom,
          legislationDocuments.language,
        ],
        targetWhere: isNotNull(legislationDocuments.versionValidFrom),
        set,
      });

  test("a conflicting upsert with a changed payload advances the revision once", async () => {
    await insertBaseRow();

    await upsert(
      { ...BASE_ROW, ...PAYLOAD_INPUT_CHANGES.document_ast, id: UPSERT_ID },
      {
        documentAst: sql`excluded.document_ast`,
        contentHash: sql`excluded.content_hash`,
      },
    );

    expect(await revisionOf(DOCUMENT_ID)).toBe(2n);
    expect(await workChanges()).toEqual([BASE_KEY]);
  });

  test("a conflicting upsert with the same payload changes nothing", async () => {
    await insertBaseRow();

    await upsert(
      { ...BASE_ROW, id: UPSERT_ID },
      {
        documentAst: sql`excluded.document_ast`,
        contentHash: sql`excluded.content_hash`,
        title: sql`excluded.title`,
      },
    );

    expect(await revisionOf(DOCUMENT_ID)).toBe(1n);
    expect(await workChanges()).toEqual([]);
  });

  test("a conflicting upsert cannot copy the proposed row's revision over", async () => {
    await insertBaseRow();
    await db
      .update(legislationDocuments)
      .set(PAYLOAD_INPUT_CHANGES.content_hash)
      .where(eq(legislationDocuments.id, DOCUMENT_ID));

    expect(
      await rejectionMessage(
        upsert(
          { ...BASE_ROW, id: UPSERT_ID },
          { payloadRevision: sql`excluded.payload_revision` },
        ),
      ),
    ).toContain(REFUSAL);
  });

  test("an upsert that inserts starts at 1 and records the new work", async () => {
    await upsert(BASE_ROW, { documentAst: sql`excluded.document_ast` });

    expect(await revisionOf(DOCUMENT_ID)).toBe(1n);
    expect(await workChanges()).toEqual([BASE_KEY]);
  });
});

describe("work changes", () => {
  test("a delete records the old work", async () => {
    await insertBaseRow();

    await db
      .delete(legislationDocuments)
      .where(eq(legislationDocuments.id, DOCUMENT_ID));

    expect(await workChanges()).toEqual([BASE_KEY]);
  });

  test("a delete cascading from the source records the old work", async () => {
    await db.insert(legislationDocuments).values({
      ...BASE_ROW,
      sourceId: OTHER_SOURCE_ID,
    });
    await clearWorkChanges();

    await db
      .delete(legislationSources)
      .where(eq(legislationSources.id, OTHER_SOURCE_ID));
    await db.insert(legislationSources).values({
      id: OTHER_SOURCE_ID,
      adapterKey: "payload-revision-b",
      name: "Source B",
    });

    expect(await workChanges()).toEqual([BASE_KEY]);
  });

  test("the legislation writer role records changes it cannot read back", async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
      await tx.insert(legislationDocuments).values(BASE_ROW);
      await tx
        .update(legislationDocuments)
        .set(PAYLOAD_INPUT_CHANGES.eli)
        .where(eq(legislationDocuments.id, DOCUMENT_ID));
      await tx
        .delete(legislationDocuments)
        .where(eq(legislationDocuments.id, DOCUMENT_ID));
    });

    const nextKey = { ...BASE_KEY, eli: PAYLOAD_INPUT_CHANGES.eli.eli };
    expect(await workChanges()).toEqual([BASE_KEY, BASE_KEY, nextKey, nextKey]);
    expect(
      await rejectionMessage(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella_ingestion`);
          await tx.select().from(legislationWorkChanges);
        }),
      ),
    ).toContain("permission denied");
    expect(
      await rejectionMessage(
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL ROLE stella`);
          await tx.select().from(legislationWorkChanges);
        }),
      ),
    ).toContain("permission denied");
  });
});
