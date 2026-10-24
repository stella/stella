import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { LEGISLATION_IDENTITY_MODES } from "@stll/api-contract/legislation-expression";

import type { ScopedDb } from "@/api/db/safe-db";
import {
  legislationDocuments,
  legislationSources,
  legislationWorkIdentifiers,
} from "@/api/db/schema";
import { resolveStatuteWorkVersion } from "@/api/handlers/legislation/by-eli";
import { processLegislationDocument } from "@/api/handlers/legislation/ingestion";
import type { LegislationCorpusDependencies } from "@/api/handlers/legislation/ingestion";
import { planCorpusDocumentWrite } from "@/api/lib/legal-search/corpus-storage";
import type { LegislationDocumentInput } from "@/api/lib/legal-search/legislation-ingestion-types";
import type { LegislationReadDb } from "@/api/lib/legislation-public-read-db";
import { isRecord } from "@/api/lib/type-guards";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createTestPglite } from "@/api/tests/pglite-test-db";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;
let scopedDb: ScopedDb;
let legislationDb: LegislationReadDb;
let sourceSequence = 0;

const corpus = {
  mode: "off",
  write: async (input) => {
    const plan = planCorpusDocumentWrite(input);
    return await Promise.resolve(
      plan.type === "put"
        ? { type: "written" as const, written: plan.written }
        : plan,
    );
  },
} satisfies LegislationCorpusDependencies;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  scopedDb = async (callback) =>
    await db.transaction(async (tx) => await callback(asTestRaw(tx)));
  legislationDb = async (callback) => await callback(asTestRaw(db));
});

afterAll(async () => {
  await client.close();
});

const source = async (
  identityMode: (typeof legislationSources.$inferInsert)["identityMode"] = LEGISLATION_IDENTITY_MODES.publisher,
) => {
  sourceSequence += 1;
  const [row] = await db
    .insert(legislationSources)
    .values({
      adapterKey: `publisher-identity-${sourceSequence}`,
      name: "Publisher identity test",
      expressionNamespace: "cellar",
      identityMode,
    })
    .returning({ id: legislationSources.id });
  if (row === undefined) {
    return panic("source fixture was not inserted");
  }
  return row.id;
};

type DocumentOptions = {
  sourceId: LegislationDocumentInput["sourceId"];
  expressionId: string;
  eli?: string;
  language?: string;
  kind?: "consolidation" | "promulgated";
};

const document = ({
  sourceId,
  expressionId,
  eli = "http://data.europa.eu/eli/reg/2020/1/oj",
  language = "en",
  kind = "consolidation",
}: DocumentOptions): LegislationDocumentInput => ({
  sourceId,
  eli,
  title: "Regulation 2020/1",
  country: "EU",
  language,
  version: {
    type: "consolidation",
    validFrom: "2020-01-01",
    end: { type: "open" },
  },
  expression: { publisherId: `cellar:${expressionId}`, kind },
  fulltext: "Article 1. Scope.",
  rawHash: "unchanged-publisher-response",
});

const store = async (input: LegislationDocumentInput) => {
  const result = await processLegislationDocument(input, scopedDb, { corpus });
  if (result.type !== "stored") {
    return panic(`expected stored legislation, got ${result.type}`);
  }
  return result;
};

const rowsOf = async (sourceId: LegislationDocumentInput["sourceId"]) =>
  await db
    .select({
      id: legislationDocuments.id,
      publisherId: legislationDocuments.publisherExpressionId,
      identityMode: legislationDocuments.identityMode,
      validFrom: legislationDocuments.versionValidFrom,
      kind: legislationDocuments.expressionKind,
      sourceHash: legislationDocuments.sourceHash,
      metadata: legislationDocuments.metadata,
    })
    .from(legislationDocuments)
    .where(eq(legislationDocuments.sourceId, sourceId));

const rejectionOf = async (write: Promise<unknown>): Promise<Error> =>
  await write.then(
    () => panic("expected the database to reject the write"),
    (error: unknown) =>
      error instanceof Error
        ? error
        : panic("expected the write to reject with an Error", error),
  );

const sqlState = async (write: Promise<unknown>) => {
  const failure = await rejectionOf(write);
  let cause: unknown = failure;
  while (isRecord(cause) && typeof cause["code"] !== "string") {
    cause = cause["cause"];
  }
  return isRecord(cause) ? cause["code"] : failure;
};

describe("publisher legislation identity", () => {
  test("same-day publisher expressions retain their own UUID through replay and corrected dates", async () => {
    const sourceId = await source();
    const inputs = [
      document({ sourceId, expressionId: "consolidation" }),
      document({ sourceId, expressionId: "promulgated", kind: "promulgated" }),
    ];
    const saved = [];
    for (const input of inputs) {
      const result = await store(input);
      saved.push({ input, id: result.id });
    }
    expect(new Set(saved.map(({ id }) => id)).size).toBe(inputs.length);
    for (const { input, id } of saved.toReversed()) {
      const replay = await store(input);
      expect(replay).toMatchObject({
        id,
        skipped: true,
      });
      const correction = await store({
        ...input,
        version: {
          type: "consolidation",
          validFrom: "2020-01-02",
          end: { type: "open" },
        },
      });
      expect(correction.id).toBe(replay.id);
    }
    const rows = await rowsOf(sourceId);
    expect(rows).toHaveLength(inputs.length);
    expect(rows.every(({ validFrom }) => validFrom === "2020-01-02")).toBe(
      true,
    );
    expect(
      rows.every(
        ({ identityMode }) =>
          identityMode === LEGISLATION_IDENTITY_MODES.publisher,
      ),
    ).toBe(true);
  });

  test("publisher identity distinguishes missing-start expressions and languages", async () => {
    const sourceId = await source();
    const ids = new Set<string>();
    for (const language of ["en", "cs"]) {
      for (const expressionId of ["missing-a", "missing-b"]) {
        const result = await store({
          ...document({ sourceId, expressionId, language }),
          version: {
            type: "invalid-window",
            validFrom: null,
            end: { type: "open" },
            basis: "missing-start",
          },
        });
        ids.add(result.id);
      }
    }
    expect(ids.size).toBe(4);
    expect(await rowsOf(sourceId)).toHaveLength(4);
  });

  test("a date-only writer cannot dedup-skip or overwrite a publisher expression", async () => {
    const sourceId = await source();
    const input = document({ sourceId, expressionId: "protected" });
    await store(input);
    const before = await rowsOf(sourceId);
    expect(
      (await rejectionOf(store({ ...input, expression: undefined }))).message,
    ).toMatch(/publisher|identity|expression/iu);
    expect(await rowsOf(sourceId)).toEqual(before);
  });

  test("the database refuses an old writer even when it supplies an expression ID", async () => {
    const sourceId = await source();
    const input = document({ sourceId, expressionId: "protected" });
    const saved = await store(input);
    const before = await rowsOf(sourceId);
    const outcome = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('stella.legislation_writer_contract', 'expression-v1', true)`,
      );
      await tx
        .update(legislationDocuments)
        .set({ title: "Wrong wording", sourceHash: "old-writer" })
        .where(eq(legislationDocuments.id, saved.id));
    });
    expect(await sqlState(outcome)).toBe("23514");
    expect(await rowsOf(sourceId)).toEqual(before);
  });

  test("an old writer cannot move a publisher expression into a legacy source", async () => {
    const sourceId = await source();
    const legacySourceId = await source(LEGISLATION_IDENTITY_MODES.legacy);
    const saved = await store(
      document({ sourceId, expressionId: "cannot-move" }),
    );
    const [before] = await db
      .select()
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, saved.id));
    if (before === undefined) {
      panic("publisher source move fixture was not stored");
    }
    const move = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('stella.legislation_writer_contract', 'expression-v1', true)`,
      );
      await tx
        .update(legislationDocuments)
        .set({
          sourceId: legacySourceId,
          sourceHash: "old-writer-source-move",
          fulltext: "A different wording",
        })
        .where(eq(legislationDocuments.id, saved.id));
    });
    expect(await sqlState(move)).toBe("23514");
    const [after] = await db
      .select()
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, saved.id));
    expect(after).toEqual(before);
    expect(await rowsOf(legacySourceId)).toEqual([]);
  });

  test("publisher uniqueness and source-derived mode are enforced outside the application writer", async () => {
    const sourceId = await source();
    await store(document({ sourceId, expressionId: "unique" }));
    const before = await rowsOf(sourceId);
    const duplicate = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('stella.legislation_writer_contract', 'expression-v2', true)`,
      );
      await tx.insert(legislationDocuments).values({
        sourceId,
        eli: "http://data.europa.eu/eli/reg/2020/1/oj",
        title: "Duplicate publisher expression",
        country: "EU",
        language: "en",
        versionValidFrom: "2020-02-01",
        publisherExpressionId: "cellar:unique",
        identityMode: LEGISLATION_IDENTITY_MODES.legacy,
      });
    });
    expect(await sqlState(duplicate)).toBe("23505");
    expect(await rowsOf(sourceId)).toEqual(before);
    const missingIdentity = db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('stella.legislation_writer_contract', 'expression-v2', true)`,
      );
      await tx.insert(legislationDocuments).values({
        sourceId,
        eli: "http://data.europa.eu/eli/reg/2020/2/oj",
        title: "Date-only direct write",
        country: "EU",
        language: "en",
        identityMode: LEGISLATION_IDENTITY_MODES.legacy,
      });
    });
    expect(await sqlState(missingIdentity)).toBe("23514");
    expect(await rowsOf(sourceId)).toEqual(before);
  });

  test("a source cannot change identity mode after its first document", async () => {
    for (const mode of [
      LEGISLATION_IDENTITY_MODES.legacy,
      LEGISLATION_IDENTITY_MODES.publisher,
    ]) {
      const sourceId = await source(mode);
      await store(document({ sourceId, expressionId: "mode-locked" }));
      const next =
        mode === LEGISLATION_IDENTITY_MODES.legacy
          ? LEGISLATION_IDENTITY_MODES.publisher
          : LEGISLATION_IDENTITY_MODES.legacy;
      expect(
        await sqlState(
          db
            .update(legislationSources)
            .set({ identityMode: next })
            .where(eq(legislationSources.id, sourceId)),
        ),
      ).toBe("23514");
      const [row] = await db
        .select({ mode: legislationSources.identityMode })
        .from(legislationSources)
        .where(eq(legislationSources.id, sourceId));
      expect(row?.mode).toBe(mode);
    }
  });

  test("legacy sources retain date uniqueness when publisher IDs differ", async () => {
    const sourceId = await source(LEGISLATION_IDENTITY_MODES.legacy);
    const first = await store(document({ sourceId, expressionId: "legacy-a" }));
    expect(
      await sqlState(store(document({ sourceId, expressionId: "legacy-b" }))),
    ).toBe("23505");
    const rows = await rowsOf(sourceId);
    expect(rows).toHaveLength(1);
    expect(rows.at(0)?.id).toBe(first.id);
  });

  test("legacy sources reject noncanonical aliases before creating or updating a document", async () => {
    const sourceId = await source(LEGISLATION_IDENTITY_MODES.legacy);
    const input = document({ sourceId, expressionId: "legacy-alias" });
    const rejected = {
      ...input,
      identifiers: ["publisher-alias:legacy"],
    };
    expect((await rejectionOf(store(rejected))).message).toMatch(
      /legacy|publisher|identity|identifier/iu,
    );
    expect(await rowsOf(sourceId)).toEqual([]);
    const original = await store(input);
    const before = await rowsOf(sourceId);
    expect(
      (
        await rejectionOf(
          store({ ...rejected, title: "A revision that must not commit" }),
        )
      ).message,
    ).toMatch(/legacy|publisher|identity|identifier/iu);
    expect(await rowsOf(sourceId)).toEqual(before);
    expect((await store(input)).id).toBe(original.id);
    const aliases = await db
      .select({ identifier: legislationWorkIdentifiers.identifier })
      .from(legislationWorkIdentifiers)
      .where(
        and(
          eq(legislationWorkIdentifiers.sourceId, sourceId),
          eq(legislationWorkIdentifiers.identifier, "publisher-alias:legacy"),
        ),
      );
    expect(aliases).toEqual([]);
  });

  test("publisher aliases remain Work-scoped across languages and conflict rolls back the new revision", async () => {
    const sourceId = await source();
    const identifier = "32020R0001";
    const input = {
      ...document({ sourceId, expressionId: "english" }),
      identifiers: [identifier],
    };
    const original = await store(
      document({ sourceId, expressionId: "english" }),
    );
    const aliased = await store(input);
    expect(aliased.id).toBe(original.id);
    await store({
      ...document({ sourceId, expressionId: "czech", language: "cs" }),
      identifiers: [identifier],
    });
    const aliases = await db
      .select({ eli: legislationWorkIdentifiers.eli })
      .from(legislationWorkIdentifiers)
      .where(
        and(
          eq(legislationWorkIdentifiers.sourceId, sourceId),
          eq(legislationWorkIdentifiers.identifier, identifier),
        ),
      );
    expect(aliases).toEqual([{ eli: input.eli }]);
    const before = await rowsOf(sourceId);
    const beforeAliases = await db
      .select({ identifier: legislationWorkIdentifiers.identifier })
      .from(legislationWorkIdentifiers)
      .where(eq(legislationWorkIdentifiers.sourceId, sourceId))
      .orderBy(legislationWorkIdentifiers.identifier);
    expect(
      (
        await rejectionOf(
          store({
            ...document({
              sourceId,
              expressionId: "conflicting",
              eli: "http://data.europa.eu/eli/reg/2020/2/oj",
            }),
            identifiers: [identifier, "32020R0002"],
          }),
        )
      ).message,
    ).toMatch(/identifier|alias|work/iu);
    expect(await rowsOf(sourceId)).toEqual(before);
    const afterAliases = await db
      .select({ identifier: legislationWorkIdentifiers.identifier })
      .from(legislationWorkIdentifiers)
      .where(eq(legislationWorkIdentifiers.sourceId, sourceId))
      .orderBy(legislationWorkIdentifiers.identifier);
    expect(afterAliases).toEqual(beforeAliases);
  });

  test("aliases resolve only the publishing source and respect jurisdiction admission", async () => {
    const sourceId = await source();
    const unrelatedSourceId = await source();
    const alias = `publisher-alias:${sourceId}`;
    const input = {
      ...document({ sourceId, expressionId: "published" }),
      country: "CZE",
      identifiers: [alias],
    };
    const published = await store(input);
    await store({
      ...document({ sourceId: unrelatedSourceId, expressionId: "unrelated" }),
      country: "CZE",
    });
    for (const surface of ["pages", "search"] as const) {
      expect(
        await resolveStatuteWorkVersion({ eli: alias }, legislationDb, surface),
      ).toEqual({
        type: "expression",
        id: published.id,
      });
    }
    await db
      .update(legislationSources)
      .set({
        descriptor: {
          license: "restricted",
          attribution: null,
          allowsRedistribution: false,
          allowsDerivedAi: false,
        },
      })
      .where(eq(legislationSources.id, sourceId));
    for (const surface of ["pages", "search"] as const) {
      expect(
        await resolveStatuteWorkVersion({ eli: alias }, legislationDb, surface),
      ).toEqual({ type: "unknown-work" });
    }
    await db
      .update(legislationSources)
      .set({ descriptor: null })
      .where(eq(legislationSources.id, sourceId));
    expect(
      await resolveStatuteWorkVersion({ eli: alias }, legislationDb, "search"),
    ).toEqual({ type: "expression", id: published.id });

    const euSourceId = await source();
    const euAlias = `publisher-alias:${euSourceId}`;
    await store({
      ...document({ sourceId: euSourceId, expressionId: "withheld-eu" }),
      identifiers: [euAlias],
    });
    for (const surface of ["pages", "search"] as const) {
      expect(
        await resolveStatuteWorkVersion(
          { eli: euAlias },
          legislationDb,
          surface,
        ),
      ).toEqual({ type: "unknown-work" });
    }
  });

  test("publisher date roles survive storage and evidence changes update the same expression fingerprint", async () => {
    const sourceId = await source();
    const input = {
      ...document({ sourceId, expressionId: "evidence" }),
      metadata: {
        publisherEvidence: {
          inForce: {
            status: "stated",
            value: true,
            locator: "cdm:resource_legal_in-force",
          },
          dates: [
            {
              meaning: { type: "entry-into-force" },
              lexicalValue: "2021-12-29",
              normalizedDate: "2021-12-29",
              scope: { type: "work" },
              locator: "cdm:date_entry-into-force/EV",
            },
            {
              meaning: { type: "applicability" },
              lexicalValue: "2022-01-01",
              normalizedDate: "2022-01-01",
              scope: { type: "provision", rawLocator: "Article 3" },
              locator: "cdm:date_entry-into-force/MA",
              annotation: "MA; Article 3",
            },
          ],
        },
      },
    } satisfies LegislationDocumentInput;
    const original = await store(input);
    const before = (await rowsOf(sourceId)).at(0);
    if (before === undefined) {
      panic("publisher evidence fixture was not stored");
    }
    expect(before.metadata).toEqual(input.metadata);
    expect(await store(input)).toMatchObject({
      id: original.id,
      skipped: true,
    });
    const corrected = {
      ...input,
      metadata: {
        publisherEvidence: {
          ...input.metadata.publisherEvidence,
          inForce: {
            status: "stated",
            value: false,
            locator: "cdm:resource_legal_in-force",
          },
        },
      },
    } satisfies LegislationDocumentInput;
    expect(await store(corrected)).toMatchObject({
      id: original.id,
      skipped: false,
    });
    const after = (await rowsOf(sourceId)).at(0);
    expect(after?.metadata).toEqual(corrected.metadata);
    expect(after?.sourceHash).not.toBe(before.sourceHash);
  });
});
