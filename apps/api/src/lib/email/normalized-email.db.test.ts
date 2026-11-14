import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import fc from "fast-check";

import { assertProperty } from "@stll/property-testing";

import {
  emailColumnMatches,
  normalizeEmail,
} from "@/api/lib/email/normalized-email";
import { withGatedTestClients } from "@/api/tests/gated-test-database";

/**
 * JavaScript and PostgreSQL agree on email addresses.
 *
 * The key is folded once, in JavaScript; SQL folds only the stored column
 * (`emailColumnMatches`). These properties verify the configured database's
 * collation compatibility, rather than a list of expected mappings: every key
 * is a fixed point of its `lower()`, it lowercases every ASCII address the way
 * `normalizeEmail` does (Better Auth accepts only those; see
 * normalized-email.test.ts), and the owner's predicate selects exactly the
 * rows whose keys are equal. PGlite runs everywhere; the configured server
 * runs under STELLA_RUN_POSTGRES_TESTS.
 */

type Query = (
  text: string,
  params: readonly unknown[],
) => Promise<readonly Record<string, unknown>[]>;

// Turkish dotted and dotless i, long s, Kelvin sign, Greek sigma and its
// final form, sharp s and its capital, accented letters.
const NAMED_CHARACTERS = [
  "\u0130",
  "\u0131",
  "\u017f",
  "\u212a",
  "\u03a3",
  "\u03c2",
  "\u00df",
  "\u1e9e",
  "\u00c9",
] as const;
const ASCII_CHARACTERS = [
  "a",
  "A",
  "i",
  "I",
  "s",
  "S",
  "k",
  "K",
  "z",
  "Z",
  "0",
  "9",
  ".",
  "_",
  "+",
  "-",
] as const;

const part = (characters: readonly string[]) =>
  fc.string({
    unit: fc.constantFrom(...characters),
    minLength: 1,
    maxLength: 10,
  });
const addressOf = (characters: readonly string[]) =>
  fc
    .tuple(part(characters), part(characters))
    .map(([local, domain]) => `${local}@${domain}.Test`);

const asciiAddress = addressOf(ASCII_CHARACTERS);
const namedAddress = addressOf([...ASCII_CHARACTERS, ...NAMED_CHARACTERS]);
// PostgreSQL text cannot hold NUL; every other well-formed string can.
const anyText = fc
  .string({ unit: "grapheme", maxLength: 24 })
  .filter((text) => !text.includes("\u0000"));

const dialect = new PgDialect();

const fixedPointProperty = (query: Query) =>
  fc.asyncProperty(
    fc.array(fc.oneof(namedAddress, anyText), { minLength: 1, maxLength: 40 }),
    async (raws) => {
      const keys = raws.map(normalizeEmail);
      const rows = await query(
        "SELECT lower(key) AS folded FROM unnest($1::text[]) WITH ORDINALITY AS input(key, position) ORDER BY position",
        [keys],
      );
      expect(rows.map((row) => row["folded"])).toEqual(keys);
    },
  );

const asciiFoldProperty = (query: Query) =>
  fc.asyncProperty(
    fc.array(asciiAddress, { minLength: 1, maxLength: 40 }),
    async (raws) => {
      const rows = await query(
        "SELECT lower(raw) AS folded FROM unnest($1::text[]) WITH ORDINALITY AS input(raw, position) ORDER BY position",
        [raws],
      );
      expect(rows.map((row) => row["folded"])).toEqual(
        raws.map(normalizeEmail),
      );
    },
  );

const matchingKeysProperty = (query: Query) =>
  fc.asyncProperty(
    fc.uniqueArray(namedAddress, {
      minLength: 1,
      maxLength: 12,
      selector: normalizeEmail,
    }),
    // An empty probe looks up a stored address; pattern characters compare literally.
    fc.oneof(namedAddress, fc.constantFrom("", "%", "_%@%")),
    async (stored, probe) => {
      await query("DELETE FROM stored_address", []);
      await query(
        "INSERT INTO stored_address (email) SELECT unnest($1::text[])",
        [stored.map(normalizeEmail)],
      );
      const lookup = probe === "" ? (stored[0] ?? "") : probe;
      const key = normalizeEmail(lookup);
      const predicate = dialect.sqlToQuery(
        emailColumnMatches(sql.identifier("email"), key),
      );
      const rows = await query(
        `SELECT email FROM stored_address WHERE ${predicate.sql}`,
        predicate.params,
      );
      expect(rows.map((row) => row["email"])).toEqual(
        stored.map(normalizeEmail).filter((email) => email === key),
      );
    },
  );

const withPgliteQuery = async (run: (query: Query) => Promise<void>) => {
  const database = new PGlite();
  try {
    await run(async (text, params) => {
      const result = await database.query<Record<string, unknown>>(text, [
        ...params,
      ]);
      return result.rows;
    });
  } finally {
    await database.close();
  }
};

describe("normalized email in PGlite", () => {
  test("pglite: every normalized key is a fixed point of lower()", async () => {
    await withPgliteQuery(async (query) => {
      await assertProperty(
        "pglite: every normalized key is a fixed point of lower()",
        fixedPointProperty(query),
        { numRuns: 60 },
      );
    });
  });

  test("pglite: lower() folds ASCII addresses like normalizeEmail", async () => {
    await withPgliteQuery(async (query) => {
      await assertProperty(
        "pglite: lower() folds ASCII addresses like normalizeEmail",
        asciiFoldProperty(query),
        { numRuns: 60 },
      );
    });
  });

  test("pglite: emailColumnMatches selects exactly the equal keys", async () => {
    await withPgliteQuery(async (query) => {
      await query("CREATE TEMP TABLE stored_address (email text NOT NULL)", []);
      await assertProperty(
        "pglite: emailColumnMatches selects exactly the equal keys",
        matchingKeysProperty(query),
        { numRuns: 60 },
      );
    });
  });
});

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("normalized email in PostgreSQL", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS and DATABASE_URL", () => {
      expect(Boolean(databaseUrl) && enabled).toBe(false);
    });
  });
} else {
  const withPostgresQuery = async (run: (query: Query) => Promise<void>) => {
    await withGatedTestClients(databaseUrl, async ({ openClient }) => {
      // One connection, so the temporary table stays in the session.
      const { sql: client } = openClient({ max: 1 });
      await run(
        async (text, params) =>
          await client.unsafe<Record<string, unknown>[]>(text, [...params]),
      );
    });
  };

  describe("normalized email in PostgreSQL", () => {
    test("postgres: every normalized key is a fixed point of lower()", async () => {
      await withPostgresQuery(async (query) => {
        await assertProperty(
          "postgres: every normalized key is a fixed point of lower()",
          fixedPointProperty(query),
          { numRuns: 60 },
        );
      });
    });

    test("postgres: lower() folds ASCII addresses like normalizeEmail", async () => {
      await withPostgresQuery(async (query) => {
        await assertProperty(
          "postgres: lower() folds ASCII addresses like normalizeEmail",
          asciiFoldProperty(query),
          { numRuns: 60 },
        );
      });
    });

    test("postgres: emailColumnMatches selects exactly the equal keys", async () => {
      await withPostgresQuery(async (query) => {
        await query(
          "CREATE TEMP TABLE stored_address (email text NOT NULL)",
          [],
        );
        await assertProperty(
          "postgres: emailColumnMatches selects exactly the equal keys",
          matchingKeysProperty(query),
          { numRuns: 60 },
        );
      });
    });
  });
}
