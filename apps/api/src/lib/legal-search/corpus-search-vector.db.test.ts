import { Result } from "better-result";
import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";

import { corpusSearchVector } from "@/api/lib/legal-search/corpus-search-vector";
import { getPgErrorCode, PG_ERROR } from "@/api/lib/pg-error";
import { createTestPglite } from "@/api/tests/pglite-test-db";

/**
 * Sizes the fixture past Postgres' ceiling on a tsvector's lexeme buffer.
 * Nothing is asserted from this number: the test asserts the engine rejects
 * the unbounded text before asserting the bounded expression indexes it.
 */
const TSVECTOR_MAX_LEXEME_BYTES = 1_048_575;

const WORD_LENGTH = 5;

/** The `index`-th five-letter word, so every token in a text is distinct. */
const word = (index: number): string => {
  let remaining = index;
  let letters = "";
  for (let position = 0; position < WORD_LENGTH; position += 1) {
    letters = String.fromCodePoint(97 + (remaining % 26)) + letters;
    remaining = Math.floor(remaining / 26);
  }
  return letters;
};

/**
 * A document long enough that its lexemes overrun the buffer. Distinct words
 * throughout: natural prose repeats, and repeats collapse into one lexeme, so
 * a text of repeated words never reaches the ceiling however long it is.
 */
const overflowingWords = (): string[] => {
  const count = Math.ceil(TSVECTOR_MAX_LEXEME_BYTES / WORD_LENGTH) + 1;
  return Array.from({ length: count }, (_, index) => word(index));
};

test("a document whose lexemes overrun the tsvector buffer still indexes", async () => {
  const client = await createTestPglite();
  const db = drizzle({ client });

  const words = overflowingWords();
  const text = words.join(" ");
  const first = word(0);
  const last = word(words.length - 1);

  // The fixture only guards anything if it reaches the fault: unbounded, this
  // text is a statement Postgres refuses outright.
  const unbounded = await Result.tryPromise(
    async () => await db.execute(sql`SELECT to_tsvector('simple', ${text})`),
  );
  expect(
    getPgErrorCode(Result.isError(unbounded) ? unbounded.error : null),
  ).toBe(PG_ERROR.PROGRAM_LIMIT_EXCEEDED);

  const tsv = corpusSearchVector({
    regconfig: "simple",
    searchableText: text,
    title: "Overrunning corpus document",
    useUnaccent: false,
  });
  const { rows } = await db.execute<{ head: boolean; tail: boolean }>(sql`
    SELECT ${tsv} @@ plainto_tsquery('simple', ${first}) AS head,
           ${tsv} @@ plainto_tsquery('simple', ${last}) AS tail
  `);

  // The row lands with the leading text indexed; the tail beyond the bound is
  // what the document trades for being indexed at all.
  expect(rows.at(0)).toEqual({ head: true, tail: false });

  await client.close();
});
