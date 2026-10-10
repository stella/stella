import { panic, Result } from "better-result";
import type { TransactionSQL } from "bun";
import { describe, expect, test } from "bun:test";
import { getColumns, getTableName } from "drizzle-orm";
import fc from "fast-check";

import { assertProperty, propertyTestTimeout } from "@stll/property-testing";

import {
  caseLawCitations,
  caseLawDecisionIdentifiers,
  caseLawDecisionJudges,
  caseLawDecisions,
  caseLawDecisionSupplements,
  caseLawJudges,
  caseLawProvisionCitations,
  caseLawSearchDocumentPreviewPassages,
  caseLawSearchDocuments,
  legislationDocuments,
  legislationSearchDocuments,
  legislationWorkNames,
} from "@/api/db/schema";
import {
  composedMetadataUrlSchema,
  METADATA_URL_SCHEMAS,
} from "@/api/handlers/case-law/ingestion/metadata-url-schemas";
import { toPlainTextMetadataObject } from "@/api/lib/case-law/plain-text";
import {
  containsTagLikeMarkup,
  TAG_LIKE_MARKUP_SOURCE,
} from "@/api/lib/case-law/plain-text-markup";
import { metadataUrlAddresses } from "@/api/lib/legal-search/metadata-urls";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

const MIGRATION = new URL(
  "../../../drizzle/20261003123100_plain_text_markup_guard/migration.sql",
  import.meta.url,
);
const migration = await Bun.file(MIGRATION).text();
const tables = [
  caseLawDecisions,
  caseLawDecisionSupplements,
  caseLawDecisionIdentifiers,
  caseLawDecisionJudges,
  caseLawJudges,
  caseLawCitations,
  caseLawProvisionCitations,
  legislationDocuments,
  legislationWorkNames,
  caseLawSearchDocuments,
  legislationSearchDocuments,
];
const bodyColumns = [
  { table: caseLawDecisions, column: caseLawDecisions.fulltext },
  {
    table: caseLawDecisionSupplements,
    column: caseLawDecisionSupplements.fulltext,
  },
  { table: legislationDocuments, column: legislationDocuments.fulltext },
  {
    table: caseLawSearchDocuments,
    column: caseLawSearchDocuments.searchableText,
  },
  {
    table: legislationSearchDocuments,
    column: legislationSearchDocuments.searchableText,
  },
  {
    table: caseLawSearchDocumentPreviewPassages,
    column: caseLawSearchDocumentPreviewPassages.content,
  },
  {
    table: caseLawProvisionCitations,
    column: caseLawProvisionCitations.sentenceText,
  },
];
// Derive the test matrix from the migration's actual column-scoped triggers.
// Bind every entry to the owning schema before constructing fixture tables.
const guards = [
  ...migration.matchAll(
    /BEFORE INSERT OR UPDATE OF ([a-z_, ]+) ON ([a-z_]+)/gu,
  ),
].map((match) => {
  const tableName = match[2] ?? panic("trigger has no table");
  const table =
    tables.find((candidate) => getTableName(candidate) === tableName) ??
    panic(`unknown guard table ${tableName}`);
  const columns = Object.values(getColumns(table));
  const names = (match[1] ?? panic("trigger has no columns")).split(", ");
  return {
    tableName,
    columns: names
      .filter((name) => name !== "source_id")
      .map((name) => {
        const column =
          columns.find((candidate) => candidate.name === name) ??
          panic(`unknown guarded column ${tableName}.${name}`);
        return { name, sqlType: String(column.getSQLType()) };
      }),
  };
});

const BLOCK = [
  "https://example.test/?q=<p>",
  "<br/>",
  '<span title="a > b">x</span>',
  "<span title='a < b'>",
  "<p>x</p>",
  '<span class="a">',
  "<!-- c -->",
  "<![CDATA[x]]>",
  "<?xml version='1.0'?>",
  "<BR/>",
  "</SPAN>",
  "<custom-tag>",
  "<span\tclass=x>",
  "<span\nclass=x>",
  "<span\fclass=x>",
  "<span\rclass=x>",
];
const ALLOW = [
  "a < b",
  "§ 5 < 3",
  "x<y",
  "<-",
  "1 <= 2",
  ">",
  "",
  "i<5 and j>2",
  "<span\u00a0class=x>",
  "<span\ufeffclass=x>",
  "<span\vclass=x>",
  "Příliš žluťoučký kůň",
  "Najvyšší súd",
  "Sąd Najwyższy",
  "Magyar bíróság",
  "Supreme Court",
  "Bundesverfassungsgericht",
];

const databaseUrlContracts = Object.fromEntries(
  Object.entries(METADATA_URL_SCHEMAS).map(([adapter, schema]) => [
    adapter,
    { base: schema ?? {}, composed: composedMetadataUrlSchema(schema) },
  ]),
);

// Each address comes from schema introspection; array positions are explicit.
const metadataAtAddress = (
  address: string,
  value: unknown,
): Record<string, unknown> => {
  const keys = address.replaceAll("[*]", ".*").split(".");
  let nested = value;
  for (const key of keys.toReversed()) {
    nested = key === "*" ? [nested] : { [key]: nested };
  }
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
    return panic("URL address must have an object root");
  }
  return Object.fromEntries(Object.entries(nested));
};

const databaseUrl = process.env["DATABASE_URL"];
const runPostgresTests = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

// A fresh schema per test contains production-named, schema-typed guarded
// columns, without unrelated FKs/RLS. Install the unmodified shipped migration
// after seeding legacy markup; all objects are removed before commit.
const withFixture = async (fn: (client: TransactionSQL) => Promise<void>) => {
  if (!databaseUrl) {
    panic("DATABASE_URL required");
  }
  await withGatedTestClients(databaseUrl, async ({ openClient }) => {
    const client = openClient({ max: 1 }).sql;
    await client.begin(async (tx) => {
      const namespace = `plaintext_guard_${Bun.randomUUIDv7().replaceAll("-", "")}`;
      await tx.unsafe(`CREATE SCHEMA "${namespace}"`);
      await tx.unsafe(`SET LOCAL search_path TO "${namespace}", public`);
      await tx.unsafe(
        "CREATE TABLE case_law_sources (id uuid PRIMARY KEY, adapter_key text NOT NULL)",
      );
      for (const { tableName, columns } of guards) {
        const definitions = columns.map(
          ({ name, sqlType }) => `"${name}" ${sqlType}`,
        );
        await tx.unsafe(
          `CREATE TABLE "${tableName}" (fixture_id integer PRIMARY KEY, unrelated integer DEFAULT 0, ${definitions.join(", ")})`,
        );
        const values = columns.map(({ name }) =>
          name === "metadata" ? `'"<br/>"'::jsonb` : "'<br/>'",
        );
        await tx.unsafe(
          `INSERT INTO "${tableName}" (fixture_id, ${columns.map(({ name }) => `"${name}"`).join(", ")}) VALUES (1, ${values.join(", ")})`,
        );
      }
      for (const tableName of [
        "case_law_decisions",
        "case_law_decision_supplements",
      ]) {
        await tx.unsafe(`ALTER TABLE "${tableName}" ADD COLUMN source_id uuid`);
      }
      for (const { table, column } of bodyColumns) {
        const tableName = getTableName(table);
        if (!guards.some((guard) => guard.tableName === tableName)) {
          await tx.unsafe(
            `CREATE TABLE "${tableName}" (fixture_id integer PRIMARY KEY)`,
          );
        }
        await tx.unsafe(
          `ALTER TABLE "${tableName}" ADD COLUMN "${column.name}" ${column.getSQLType()}`,
        );
      }
      const fileNodesBefore =
        await tx`SELECT relname, relfilenode FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' ORDER BY relname`;
      await tx.unsafe(migration);
      const fileNodesAfter =
        await tx`SELECT relname, relfilenode FROM pg_class WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r' ORDER BY relname`;
      expect(fileNodesAfter).toEqual(fileNodesBefore);
      await fn(tx);
      await tx.unsafe(`DROP SCHEMA "${namespace}" CASCADE`);
    });
  });
};

// The SQLSTATE plus structured constraint/column identify a parser defect,
// rather than a timeout or a broken fixture. Savepoints preserve the test's
// transaction after each expected statement failure.
type MarkupFailureOptions = {
  client: TransactionSQL;
  statement: string;
  column: string;
  value: string;
};
const expectMarkupFailure = async ({
  client,
  statement,
  column,
  value,
}: MarkupFailureOptions) => {
  const result = await Result.tryPromise(async () =>
    client.savepoint(async (tx) => {
      await tx.unsafe(
        column === "metadata"
          ? statement.replace("$1", "$1::text::jsonb")
          : statement,
        [value],
      );
    }),
  );
  expect(result.isErr()).toBe(true);
  if (result.isOk()) {
    panic("markup write succeeded");
  }
  expect(result.error.cause).toMatchObject({
    errno: "23514",
    message: "plain_text_markup_rejected",
    constraint: "plain_text_no_markup",
    column,
  });
};

if (!runPostgresTests || !databaseUrl) {
  describe.skip("plain-text database guard on real Postgres", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("plain-text database guard on real Postgres", () => {
    test("installs on schema-owned columns without rewriting legacy rows", async () => {
      expect(guards.map(({ tableName }) => tableName).toSorted()).toEqual(
        tables.map(getTableName).toSorted(),
      );
      await withFixture(async (client) => {
        const versions =
          await client`SELECT current_setting('server_version_num')::integer AS version`;
        expect(versions.at(0)?.version).toBeGreaterThanOrEqual(180_000);
        const triggers =
          await client`SELECT count(*)::integer AS count FROM pg_trigger WHERE tgname LIKE '%_plain_text_guard' AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = current_schema()::regnamespace)`;
        expect(triggers.at(0)?.count).toBe(guards.length);
        for (const { tableName } of guards) {
          const rows = await client.unsafe(
            `SELECT fixture_id FROM "${tableName}"`,
          );
          expect(rows).toHaveLength(1);
        }
      });
    });

    test(
      "blocks INSERT and changed-column UPDATE on every guarded text column",
      async () => {
        await withFixture(async (client) => {
          for (const { tableName, columns } of guards) {
            for (const column of columns.filter(
              ({ name }) => name !== "metadata",
            )) {
              const { name } = column;
              const limit = Number(
                /varchar\((\d+)\)/u.exec(column.sqlType)?.[1] ?? Infinity,
              );
              for (const value of BLOCK.filter(
                (candidate) => candidate.length <= limit,
              )) {
                await expectMarkupFailure({
                  client,
                  statement: `INSERT INTO "${tableName}" (fixture_id, "${name}") VALUES (2, $1)`,
                  column: name,
                  value,
                });
                await expectMarkupFailure({
                  client,
                  statement: `UPDATE "${tableName}" SET "${name}" = $1 WHERE fixture_id = 1`,
                  column: name,
                  value: value === "<br/>" ? "<br>" : value,
                });
              }
            }
          }
        });
      },
      propertyTestTimeout(30_000),
    );

    test(
      "allows comparisons, nullable text, and multilingual values on insert and update",
      async () => {
        await withFixture(async (client) => {
          for (const { tableName, columns } of guards) {
            // Repair legacy values first so updates may check only their target.
            await client.unsafe(
              `UPDATE "${tableName}" SET ${columns.map(({ name }) => `"${name}" = NULL`).join(", ")} WHERE fixture_id = 1`,
            );
            for (const column of columns.filter(
              ({ name }) => name !== "metadata",
            )) {
              const { name } = column;
              const limit = Number(
                /varchar\((\d+)\)/u.exec(column.sqlType)?.[1] ?? Infinity,
              );
              for (const value of [
                ...ALLOW.filter((candidate) => candidate.length <= limit),
                null,
              ]) {
                await client.unsafe(
                  `INSERT INTO "${tableName}" (fixture_id, "${name}") VALUES (2, $1)`,
                  [value],
                );
                await client.unsafe(
                  `UPDATE "${tableName}" SET "${name}" = $1 WHERE fixture_id = 1`,
                  [value],
                );
                const rows = await client.unsafe(
                  `SELECT "${name}" AS value FROM "${tableName}" WHERE fixture_id = 1`,
                );
                expect(rows.at(0)?.value).toBe(value);
                await client.unsafe(
                  `DELETE FROM "${tableName}" WHERE fixture_id = 2`,
                );
              }
            }
          }
        });
      },
      propertyTestTimeout(30_000),
    );

    test("permits unrelated and unchanged legacy updates, rejects new markup, and permits repair", async () => {
      await withFixture(async (client) => {
        for (const { tableName, columns } of guards) {
          await client.unsafe(
            `UPDATE "${tableName}" SET unrelated = 9 WHERE fixture_id = 1`,
          );
          for (const { name } of columns) {
            await client.unsafe(
              `UPDATE "${tableName}" SET "${name}" = "${name}" WHERE fixture_id = 1`,
            );
            const value =
              name === "metadata"
                ? JSON.stringify({ nested: ["<span>bad</span>"] })
                : "<p>";
            await expectMarkupFailure({
              client,
              statement: `UPDATE "${tableName}" SET "${name}" = $1 WHERE fixture_id = 1`,
              column: name,
              value,
            });
            await client.unsafe(
              `UPDATE "${tableName}" SET "${name}" = ${name === "metadata" ? "$1::text::jsonb" : "$1"} WHERE fixture_id = 1`,
              [
                name === "metadata"
                  ? JSON.stringify({ nested: ["§ 5 < 3"] })
                  : "§ 5 < 3",
              ],
            );
          }
          const rows = await client.unsafe(
            `SELECT unrelated FROM "${tableName}" WHERE fixture_id = 1`,
          );
          expect(rows.at(0)?.unrelated).toBe(9);
        }
      });
    });

    test("checks metadata string leaves including nested arrays without interpreting keys or JSON escapes", async () => {
      await withFixture(async (client) => {
        for (const { tableName } of guards.filter(({ columns }) =>
          columns.some(({ name }) => name === "metadata"),
        )) {
          for (const value of BLOCK) {
            const metadata = JSON.stringify({ nested: [{ value }] });
            await expectMarkupFailure({
              client,
              statement: `INSERT INTO "${tableName}" (fixture_id, metadata) VALUES (2, $1)`,
              column: "metadata",
              value: metadata,
            });
            await expectMarkupFailure({
              client,
              statement: `UPDATE "${tableName}" SET metadata = $1 WHERE fixture_id = 1`,
              column: "metadata",
              value: metadata,
            });
          }
          for (const value of [
            null,
            {},
            [],
            1,
            false,
            ...ALLOW,
            { "<br/>": ALLOW },
            { nested: [1, false, null, { value: "a < b" }] },
          ]) {
            const metadata = JSON.stringify(value);
            await client.unsafe(
              `INSERT INTO "${tableName}" (fixture_id, metadata) VALUES (2, $1::text::jsonb)`,
              [metadata],
            );
            await client.unsafe(
              `UPDATE "${tableName}" SET metadata = $1::text::jsonb WHERE fixture_id = 1`,
              [metadata],
            );
            await client.unsafe(
              `DELETE FROM "${tableName}" WHERE fixture_id = 2`,
            );
          }
        }
      });
    });

    test(
      "exempts every declared source URL leaf while guarding siblings and unexpected shapes",
      async () => {
        await withFixture(async (client) => {
          const unclassifiedSourceId = Bun.randomUUIDv7();
          await client`INSERT INTO case_law_sources (id, adapter_key) VALUES (${unclassifiedSourceId}::uuid, 'unclassified-fixture')`;
          for (const [adapter, contracts] of Object.entries(
            databaseUrlContracts,
          )) {
            const sourceId = Bun.randomUUIDv7();
            await client`INSERT INTO case_law_sources (id, adapter_key) VALUES (${sourceId}::uuid, ${adapter})`;
            for (const [tableName, schema] of [
              ["case_law_decisions", contracts.composed],
              ["case_law_decision_supplements", contracts.base],
            ] as const) {
              for (const address of metadataUrlAddresses(schema)) {
                const url = "https://example.test/document?q=<p>";
                const metadata = metadataAtAddress(address, url);
                const projected = toPlainTextMetadataObject(
                  metadata,
                  schema,
                ).unwrap();
                expect(Bun.deepEquals(projected, metadata)).toBe(true);
                await client.unsafe(
                  `INSERT INTO "${tableName}" (fixture_id, source_id, metadata) VALUES (2, $1::uuid, $2::text::jsonb)`,
                  [sourceId, JSON.stringify(projected)],
                );
                const rows = await client.unsafe(
                  `SELECT metadata FROM "${tableName}" WHERE fixture_id = 2`,
                );
                expect(rows.at(0)?.metadata).toEqual(metadata);
                await client.unsafe(
                  `UPDATE "${tableName}" SET metadata = $1::text::jsonb WHERE fixture_id = 2`,
                  [JSON.stringify(metadataAtAddress(address, `${url}<br/>`))],
                );
                for (const rejected of [
                  { ...metadata, undeclaredLabel: url },
                  metadataAtAddress(address, { label: "<p>" }),
                  metadataAtAddress(address, ["<p>"]),
                  ...(address.includes("[*]")
                    ? [
                        metadataAtAddress(
                          address.replaceAll("[*]", ".items"),
                          url,
                        ),
                      ]
                    : []),
                ]) {
                  await expectMarkupFailure({
                    client,
                    statement: `UPDATE "${tableName}" SET metadata = $1 WHERE fixture_id = 2`,
                    column: "metadata",
                    value: JSON.stringify(rejected),
                  });
                }
                const switched = await Result.tryPromise(async () =>
                  client.savepoint(async (tx) => {
                    await tx.unsafe(
                      `UPDATE "${tableName}" SET source_id = $1::uuid WHERE fixture_id = 2`,
                      [unclassifiedSourceId],
                    );
                  }),
                );
                expect(switched.isErr()).toBe(true);
                if (switched.isErr()) {
                  expect(switched.error.cause).toMatchObject({
                    errno: "23514",
                    column: "metadata",
                  });
                }
                await client.unsafe(
                  `DELETE FROM "${tableName}" WHERE fixture_id = 2`,
                );
              }
            }
          }
        });
      },
      propertyTestTimeout(30_000),
    );

    test("preserves literal angle-bracket prose in every body projection", async () => {
      await withFixture(async (client) => {
        for (const { table, column } of bodyColumns) {
          const tableName = getTableName(table);
          expect(
            guards
              .find((guard) => guard.tableName === tableName)
              ?.columns.some((guarded) => guarded.name === column.name) ??
              false,
          ).toBe(false);
          const value = "Before <quoted> after";
          await client.unsafe(
            `INSERT INTO "${tableName}" (fixture_id, "${column.name}") VALUES (2, $1)`,
            [value],
          );
          await client.unsafe(
            `UPDATE "${tableName}" SET "${column.name}" = $1 WHERE fixture_id = 2`,
            [value],
          );
          const rows = await client.unsafe(
            `SELECT "${column.name}" AS value FROM "${tableName}" WHERE fixture_id = 2`,
          );
          expect(rows.at(0)?.value).toBe(value);
          await client.unsafe(
            `DELETE FROM "${tableName}" WHERE fixture_id = 2`,
          );
        }
      });
    });

    test(
      "SQL predicate and sanitizer agree on generated text, HTML whitespace, and long legal text",
      async () => {
        await withFixture(async (client) => {
          const assertParity = async (values: string[]) => {
            const rows =
              await client`SELECT value, plain_text_has_markup(value) AS guarded, value ~ ${TAG_LIKE_MARKUP_SOURCE} AS contract FROM jsonb_array_elements_text(${JSON.stringify(values)}::text::jsonb) AS input(value)`;
            expect(rows).toHaveLength(values.length);
            for (const row of rows) {
              expect(row.guarded).toBe(containsTagLikeMarkup(row.value));
              expect(row.contract).toBe(row.guarded);
            }
          };
          await assertParity([
            ...BLOCK,
            ...ALLOW,
            `${"§ 5 právo. ".repeat(20_000)}<br/>`,
            `${"§ 5 právo. ".repeat(20_000)}a < b`,
          ]);
          const whitespace = fc.constantFrom(
            " ",
            "\t",
            "\n",
            "\r",
            "\f",
            "\v",
            "\u00a0",
            "\ufeff",
            "\u2003",
          );
          const text = fc.oneof(
            fc.string().filter((value) => !value.includes("\0")),
            fc
              .tuple(
                fc.constantFrom("<span", "</p", "<custom-tag"),
                whitespace,
                fc.constantFrom("class=x>", "/>", ">"),
              )
              .map(
                ([prefix, separator, suffix]) =>
                  `${prefix}${separator}${suffix}`,
              ),
            fc
              .array(
                fc.constantFrom(
                  "<",
                  ">",
                  "/",
                  "!",
                  "?",
                  "[",
                  "]",
                  "a",
                  "Z",
                  "-",
                  ":",
                  " ",
                  "\n",
                  "č",
                  '"',
                  "'",
                ),
                { maxLength: 150 },
              )
              .map((characters) => characters.join("")),
          );
          await assertProperty(
            "SQL predicate and sanitizer agree on generated text, HTML whitespace, and long legal text",
            fc.asyncProperty(
              fc.array(text, { minLength: 1, maxLength: 40 }),
              assertParity,
            ),
            { numRuns: 100, seed: 20_261_001 },
          );
        });
      },
      propertyTestTimeout(30_000),
    );
  });
}
