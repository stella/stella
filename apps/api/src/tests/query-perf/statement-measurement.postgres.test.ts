import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";

import { runWithQueryCounter } from "@/api/lib/db-query-counter";
import { executedRows } from "@/api/lib/db/executed-rows";
import { openGatedTestDatabase } from "@/api/tests/gated-test-database";

import { measureJobStatements } from "./statement-measurement";

const fixture = pgTable("measurement_writer_fixture", {
  id: integer().generatedAlwaysAsIdentity(),
  label: text().notNull(),
});

const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

describe.skipIf(!enabled)(
  "measure-in-place scheduled statements (postgres)",
  () => {
    const { db } = openGatedTestDatabase(
      process.env["DATABASE_URL"] ?? panic("PostgreSQL URL required"),
      { max: 1 },
    );

    test("a two-transaction identity writer sees only real insert and delete results", async () => {
      await db.execute(
        sql`CREATE TEMP TABLE measurement_writer_fixture (id integer GENERATED ALWAYS AS IDENTITY, label text NOT NULL)`,
      );
      const measured = await measureJobStatements({
        database: db,
        run: async (database) =>
          await runWithQueryCounter(async (counter) => {
            const inserted = await database.transaction(async (tx) => {
              const rows = await tx
                .insert(fixture)
                .values({ label: "real" })
                .returning();
              expect(rows).toEqual([{ id: 2, label: "real" }]);
              const [stored, count] = await Promise.all([
                tx.select().from(fixture),
                tx.execute(
                  sql`SELECT count(*)::int AS total FROM measurement_writer_fixture`,
                ),
              ]);
              expect(stored).toEqual(rows);
              expect(executedRows(count)).toEqual([{ total: 1 }]);
              return rows;
            });
            const deleted = await database.transaction(async (tx) => {
              const rows = await tx
                .delete(fixture)
                .where(eq(fixture.label, "real"))
                .returning();
              expect(rows).toEqual(inserted);
              await tx.execute(sql`SET TRANSACTION READ ONLY`);
              expect(
                executedRows(
                  await tx.execute(
                    sql`SELECT id, label FROM measurement_writer_fixture`,
                  ),
                ),
              ).toEqual([]);
              return rows;
            });
            expect(
              executedRows(
                await database.execute(
                  sql`SELECT id, label FROM measurement_writer_fixture`,
                ),
              ),
            ).toEqual([]);
            expect(counter.count).toBe(7);
            expect(counter.transactions).toBe(4);
            return { inserted, deleted };
          }),
      });
      expect(measured.value.inserted).toEqual(measured.value.deleted);
      expect(measured.executed).toEqual(measured.issued);
      expect(
        measured.issued.map(({ text: statement }) =>
          statement.trim().split(" ").at(0)?.toUpperCase(),
        ),
      ).toEqual([
        "INSERT",
        "SELECT",
        "SELECT",
        "DELETE",
        "SET",
        "SELECT",
        "SELECT",
      ]);
      expect(measured.statements.map(({ query }) => query)).toEqual(
        measured.issued.filter(
          ({ text: statement }) => !statement.startsWith("SET TRANSACTION"),
        ),
      );
      expect(
        executedRows(
          await db.execute(
            sql`SELECT id, label FROM measurement_writer_fixture`,
          ),
        ),
      ).toEqual([]);
    });
  },
);
