import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { pushSchema } from "drizzle-kit/api-postgres";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import * as authSchema from "@/api/db/auth-schema";
import * as rlsExports from "@/api/db/rls";
import type { ScopedDb } from "@/api/db/safe-db";
import * as schema from "@/api/db/schema";
import { caseLawSources, legislationSources } from "@/api/db/schema";
import { createSafeId } from "@/api/lib/branded-types";
import {
  advanceCorpusIngestionCheckpoint,
  CORPUS_SOURCE_TYPE,
  INGESTION_CHECKPOINT_STATUS,
} from "@/api/lib/corpus-ingestion-checkpoint";
import {
  createSchemaPglite,
  installPgliteSchemaPrerequisites,
} from "@/api/tests/pglite-schema";

const allSchema = { ...schema, ...authSchema, ...rlsExports };

let client: Awaited<ReturnType<typeof createSchemaPglite>> | undefined;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;

const caseLawSourceId = createSafeId<"caseLawSource">();
const legislationSourceId = createSafeId<"legislationSource">();

beforeAll(
  async () => {
    client = await createSchemaPglite();
    db = drizzle({ client });
    await db.execute(sql.raw("CREATE ROLE stella NOLOGIN"));
    await db.execute(sql.raw("CREATE ROLE stella_ingestion NOLOGIN"));
    await installPgliteSchemaPrerequisites(db);
    const { sqlStatements } = await pushSchema(allSchema, db);
    for (const statement of sqlStatements) {
      // oxlint-disable-next-line no-await-in-loop -- sequential DDL: schema statements must apply in emitted order
      await db.execute(sql.raw(statement));
    }

    await db.insert(caseLawSources).values({
      id: caseLawSourceId,
      adapterKey: "checkpoint-case-law",
      name: "Checkpoint case-law source",
    });
    await db.insert(legislationSources).values({
      id: legislationSourceId,
      adapterKey: "checkpoint-legislation",
      name: "Checkpoint legislation source",
    });

    // eslint-disable-next-line typescript/no-unsafe-type-assertion -- pglite test transaction is structurally compatible with the production transaction used by ScopedDb
    scopedDb = (async (callback: (tx: unknown) => Promise<unknown>) =>
      await db.transaction(
        // oxlint-disable-next-line node/callback-return -- the expression body returns the awaited callback result
        async (tx) => await callback(tx),
      )) as unknown as ScopedDb;
  },
  { timeout: 30_000 },
);

beforeEach(async () => {
  await db
    .update(caseLawSources)
    .set({ syncCursor: null })
    .where(eq(caseLawSources.id, caseLawSourceId));
  await db
    .update(legislationSources)
    .set({ syncCursor: null })
    .where(eq(legislationSources.id, legislationSourceId));
});

afterAll(async () => {
  if (client !== undefined) {
    await client.close();
  }
});

describe("advanceCorpusIngestionCheckpoint", () => {
  test("advances both supported corpus source types", async () => {
    const caseLaw = await advanceCorpusIngestionCheckpoint({
      expectedCursor: null,
      nextCursor: "case-page-2",
      scopedDb,
      source: {
        id: caseLawSourceId,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });
    const legislation = await advanceCorpusIngestionCheckpoint({
      expectedCursor: null,
      nextCursor: "legislation-page-2",
      scopedDb,
      source: {
        id: legislationSourceId,
        type: CORPUS_SOURCE_TYPE.LEGISLATION,
      },
    });

    expect(caseLaw).toEqual({
      cursor: "case-page-2",
      status: INGESTION_CHECKPOINT_STATUS.ADVANCED,
    });
    expect(legislation).toEqual({
      cursor: "legislation-page-2",
      status: INGESTION_CHECKPOINT_STATUS.ADVANCED,
    });
  });

  test("recognizes an exact checkpoint replay", async () => {
    const transition = {
      expectedCursor: null,
      nextCursor: "page-2",
      scopedDb,
      source: {
        id: caseLawSourceId,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    };

    await advanceCorpusIngestionCheckpoint(transition);
    const replay = await advanceCorpusIngestionCheckpoint(transition);

    expect(replay).toEqual({
      cursor: "page-2",
      status: INGESTION_CHECKPOINT_STATUS.ALREADY_CURRENT,
    });
  });

  test("allows only one divergent writer from the same cursor", async () => {
    const transitions = await Promise.all([
      advanceCorpusIngestionCheckpoint({
        expectedCursor: null,
        nextCursor: "winner-a",
        scopedDb,
        source: {
          id: caseLawSourceId,
          type: CORPUS_SOURCE_TYPE.CASE_LAW,
        },
      }),
      advanceCorpusIngestionCheckpoint({
        expectedCursor: null,
        nextCursor: "winner-b",
        scopedDb,
        source: {
          id: caseLawSourceId,
          type: CORPUS_SOURCE_TYPE.CASE_LAW,
        },
      }),
    ]);
    const [stored] = await db
      .select({ cursor: caseLawSources.syncCursor })
      .from(caseLawSources)
      .where(eq(caseLawSources.id, caseLawSourceId));
    if (!stored) {
      throw new Error("checkpoint source unexpectedly missing");
    }

    expect(
      transitions.filter(
        ({ status }) => status === INGESTION_CHECKPOINT_STATUS.ADVANCED,
      ),
    ).toHaveLength(1);
    for (const result of transitions) {
      if (result.status === INGESTION_CHECKPOINT_STATUS.MISSING) {
        throw new Error("checkpoint source unexpectedly missing");
      }
      expect(result.cursor).toBe(stored.cursor);
    }
  });

  test("does not let a stale writer move the cursor backward", async () => {
    await advanceCorpusIngestionCheckpoint({
      expectedCursor: null,
      nextCursor: "page-3",
      scopedDb,
      source: {
        id: caseLawSourceId,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });

    const stale = await advanceCorpusIngestionCheckpoint({
      expectedCursor: null,
      nextCursor: "page-2",
      scopedDb,
      source: {
        id: caseLawSourceId,
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });

    expect(stale).toEqual({
      cursor: "page-3",
      status: INGESTION_CHECKPOINT_STATUS.SUPERSEDED,
    });
  });

  test("reports a missing source", async () => {
    const result = await advanceCorpusIngestionCheckpoint({
      expectedCursor: null,
      nextCursor: "page-2",
      scopedDb,
      source: {
        id: createSafeId<"caseLawSource">(),
        type: CORPUS_SOURCE_TYPE.CASE_LAW,
      },
    });

    expect(result).toEqual({
      status: INGESTION_CHECKPOINT_STATUS.MISSING,
    });
  });
});
