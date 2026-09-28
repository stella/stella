import { panic } from "better-result";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync } from "node:fs";

import {
  LEGISLATION_EXPRESSION_KINDS,
  LEGISLATION_WINDOW_DISPOSITION_BASES,
  LEGISLATION_WINDOW_DISPOSITIONS,
} from "@stll/api-contract/legislation-expression";

import { legislationDocuments, legislationSources } from "@/api/db/schema";
import { toSafeId } from "@/api/lib/branded-types";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Migration `20260928180000_legislation_expression_identity`: the typed
 * columns, their value CHECKs, and the triggers that keep a publisher
 * expression id set once and under its source's namespace. The test database
 * is built from the Drizzle schema; the CHECK parity test below re-applies the
 * migration's own constraint statements and holds them equal to the schema's.
 */

const MIGRATION_SQL = readFileSync(
  new URL(
    "../../drizzle/20260928180000_legislation_expression_identity/migration.sql",
    import.meta.url,
  ),
  "utf-8",
);

const SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000e01",
);
const BARE_SOURCE_ID = toSafeId<"legislationSource">(
  "0198e331-e578-7000-8000-000000000e02",
);
const DOCUMENT_ID = toSafeId<"legislationDocument">(
  "0198e331-e578-7000-8000-000000000e03",
);

const IRI = "https://example.test/eli/cz/sb/2012/89/2025-07-01";

let client: Awaited<ReturnType<typeof createTestPglite>>;
let db: ReturnType<typeof drizzle>;

const rejection = async (write: Promise<unknown>): Promise<string> =>
  await write.then(
    () => panic("expected the database to refuse the write"),
    (error: unknown) => {
      const cause: unknown =
        error instanceof Error && error.cause !== undefined
          ? error.cause
          : error;
      return cause instanceof Error ? cause.message : String(cause);
    },
  );

const baseRow = {
  sourceId: SOURCE_ID,
  eli: "eli/cz/sb/2012/89",
  title: "Občanský zákoník",
  country: "CZE",
  language: "cs",
  versionValidFrom: "2025-07-01",
} as const satisfies typeof legislationDocuments.$inferInsert;

beforeAll(async () => {
  client = await createTestPglite();
  db = drizzle({ client });
  await db.insert(legislationSources).values([
    {
      id: SOURCE_ID,
      adapterKey: "expression-identity-test",
      name: "Expression identity test",
      expressionNamespace: "esel",
    },
    {
      id: BARE_SOURCE_ID,
      adapterKey: "expression-identity-bare",
      name: "Source with no namespace yet",
    },
  ]);
  await db.insert(legislationDocuments).values({ ...baseRow, id: DOCUMENT_ID });
});

afterAll(async () => {
  await client.close();
});

describe("legislation expression identity columns", () => {
  test("an existing row reads as an effective consolidation with no id", async () => {
    const [row] = await db
      .select({
        id: legislationDocuments.publisherExpressionId,
        kind: legislationDocuments.expressionKind,
        disposition: legislationDocuments.windowDisposition,
        basis: legislationDocuments.windowDispositionBasis,
      })
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, DOCUMENT_ID));
    expect(row).toEqual({
      id: null,
      kind: "consolidation",
      disposition: "effective",
      basis: null,
    });
  });

  test("the value CHECKs admit every declared value and pairing", async () => {
    for (const kind of LEGISLATION_EXPRESSION_KINDS) {
      await db.execute(sql`
        UPDATE legislation_documents SET expression_kind = ${kind}
        WHERE id = ${DOCUMENT_ID}
      `);
    }
    for (const disposition of LEGISLATION_WINDOW_DISPOSITIONS) {
      for (const basis of LEGISLATION_WINDOW_DISPOSITION_BASES[disposition]) {
        await db.execute(sql`
          UPDATE legislation_documents
          SET window_disposition = ${disposition},
              window_disposition_basis = ${basis}
          WHERE id = ${DOCUMENT_ID}
        `);
      }
    }
    await db.execute(sql`
      UPDATE legislation_documents
      SET expression_kind = 'consolidation',
          window_disposition = 'effective',
          window_disposition_basis = NULL
      WHERE id = ${DOCUMENT_ID}
    `);
  });

  test.each([
    ["an unknown kind", sql`expression_kind = 'draft'`],
    ["an unknown disposition", sql`window_disposition = 'expired'`],
    [
      "an effective row with another disposition's basis",
      sql`window_disposition_basis = 'reversed'`,
    ],
    [
      "a never-in-force row with no basis",
      sql`window_disposition = 'never-in-force'`,
    ],
    [
      "a withdrawn row with an invalid-window basis",
      sql`window_disposition = 'withdrawn', window_disposition_basis = 'missing-start'`,
    ],
  ])("the value CHECKs refuse %s", async (_label, assignment) => {
    const message = await rejection(
      db.execute(
        sql`UPDATE legislation_documents SET ${assignment} WHERE id = ${DOCUMENT_ID}`,
      ),
    );
    expect(message).toContain("violates check constraint");
  });

  test("the migration's CHECKs are the schema's CHECKs", async () => {
    const constraintNames = [
      "legislation_documents_expression_kind_values",
      "legislation_documents_window_disposition_values",
      "legislation_documents_window_disposition_basis_pairing",
      "legislation_sources_expression_namespace_shape",
    ];
    const definitions = async () =>
      Object.fromEntries(
        (
          await db.execute<{ name: string; definition: string }>(sql`
            SELECT conname AS name, pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
            WHERE conname IN (${sql.join(
              constraintNames.map((name) => sql`${name}`),
              sql`, `,
            )})
          `)
        ).rows.map(({ name, definition }) => [name, definition]),
      );
    const fromSchema = await definitions();

    const constraintStatements = MIGRATION_SQL.split("--> statement-breakpoint")
      .map((statement) =>
        statement
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter((statement) =>
        /^ALTER TABLE "legislation_(documents|sources)"\s+(DROP CONSTRAINT IF EXISTS|ADD CONSTRAINT|VALIDATE CONSTRAINT)/u.test(
          statement,
        ),
      );
    expect(constraintStatements).toHaveLength(constraintNames.length * 2 + 3);
    for (const statement of constraintStatements) {
      await db.execute(sql.raw(statement));
    }

    expect(Object.keys(fromSchema).toSorted()).toEqual(
      constraintNames.toSorted(),
    );
    expect(await definitions()).toEqual(fromSchema);
  });

  test("the migration adds no window or presence CHECK", () => {
    expect(MIGRATION_SQL).not.toMatch(/CHECK\s*\([^;]*version_valid_/u);
    expect(MIGRATION_SQL).not.toMatch(
      /CHECK\s*\([^;]*publisher_expression_id\s+IS\s+NOT\s+NULL/iu,
    );
  });
});

describe("legislation publisher expression id", () => {
  const setId = (id: string | null) =>
    db
      .update(legislationDocuments)
      .set({ publisherExpressionId: id })
      .where(eq(legislationDocuments.id, DOCUMENT_ID));

  test.each([
    ["another namespace", `slovlex:${IRI}`],
    ["no namespace", IRI],
    ["the namespace alone", "esel:"],
  ])("an id under %s is refused", async (_label, id) => {
    expect(await rejection(setId(id))).toContain(
      "does not carry its source namespace",
    );
  });

  test("a source with no namespace accepts no id", async () => {
    const message = await rejection(
      db.insert(legislationDocuments).values({
        ...baseRow,
        sourceId: BARE_SOURCE_ID,
        publisherExpressionId: `esel:${IRI}`,
      }),
    );
    expect(message).toContain("declares no expression namespace");
  });

  test("an id is set once from null and never changed or cleared", async () => {
    await setId(`esel:${IRI}`);
    // Re-assigning the same value is not a change.
    await setId(`esel:${IRI}`);

    expect(await rejection(setId(`esel:${IRI}/other`))).toContain(
      "publisher expression id is set once",
    );
    expect(await rejection(setId(null))).toContain(
      "publisher expression id is set once",
    );
    const message = await rejection(
      db
        .update(legislationDocuments)
        .set({ sourceId: BARE_SOURCE_ID })
        .where(eq(legislationDocuments.id, DOCUMENT_ID)),
    );
    expect(message).toContain("declares no expression namespace");

    const [row] = await db
      .select({ id: legislationDocuments.publisherExpressionId })
      .from(legislationDocuments)
      .where(eq(legislationDocuments.id, DOCUMENT_ID));
    expect(row?.id).toBe(`esel:${IRI}`);
  });

  test("other columns of a row with an id stay writable", async () => {
    await db
      .update(legislationDocuments)
      .set({
        title: "Občanský zákoník (opraveno)",
        windowDisposition: "withdrawn",
        windowDispositionBasis: "publisher-unlisted",
      })
      .where(eq(legislationDocuments.id, DOCUMENT_ID));
    await db
      .update(legislationDocuments)
      .set({ windowDisposition: "effective", windowDispositionBasis: null })
      .where(eq(legislationDocuments.id, DOCUMENT_ID));
  });
});

describe("legislation source expression namespace", () => {
  const setNamespace = (namespace: string | null) =>
    db
      .update(legislationSources)
      .set({ expressionNamespace: namespace })
      .where(eq(legislationSources.id, BARE_SOURCE_ID));

  test.each([["ESEL"], ["esel:cz"], ["1esel"]])(
    "a namespace shaped %s is refused",
    async (namespace) => {
      expect(await rejection(setNamespace(namespace))).toContain(
        "violates check constraint",
      );
    },
  );

  test("a namespace is set once and never changed", async () => {
    await setNamespace("slovlex");
    expect(await rejection(setNamespace("slov-lex"))).toContain(
      "expression namespace is set once",
    );
    expect(await rejection(setNamespace(null))).toContain(
      "expression namespace is set once",
    );
  });
});
