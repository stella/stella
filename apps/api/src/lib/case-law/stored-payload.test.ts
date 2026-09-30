import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  publicRowHoldsDocument,
  rowHoldsDocument,
} from "@/api/lib/case-law/stored-payload";
import { EMPTY_CORPUS_CONTENT_HASHES } from "@/api/lib/legal-search/corpus-storage";

const client = new PGlite();
beforeAll(async () => await client.waitReady);
afterAll(async () => await client.close());

const empty = {
  text: null,
  ast: "{}",
  sections: "[]",
  hash: null,
  textKey: null,
  astKey: null,
  normalizedKey: null,
};
const complete = {
  ...empty,
  hash: "a".repeat(64),
  textKey: "text",
  astKey: "ast",
  normalizedKey: "sections",
};
const fixtures = [
  { name: "textless", row: empty, expected: false },
  { name: "empty text", row: { ...empty, text: "" }, expected: false },
  { name: "inline text", row: { ...empty, text: "Document" }, expected: true },
  {
    name: "inline AST",
    row: { ...empty, ast: '{"blocks":[{}]}' },
    expected: true,
  },
  {
    name: "inline sections",
    row: { ...empty, sections: "[{}]" },
    expected: true,
  },
  { name: "trimmed complete corpus", row: complete, expected: true },
  ...EMPTY_CORPUS_CONTENT_HASHES.map((hash) => ({
    name: `canonical empty ${hash}`,
    row: { ...complete, hash },
    expected: false,
  })),
  {
    name: "normalized key alone",
    row: { ...empty, hash: complete.hash, normalizedKey: "sections" },
    expected: false,
  },
  {
    name: "text key alone",
    row: { ...empty, hash: complete.hash, textKey: "text" },
    expected: false,
  },
  {
    name: "unconfirmed corpus",
    row: { ...complete, hash: null },
    expected: false,
  },
];

for (const { name, row, expected } of fixtures) {
  test(`public and full document predicates agree for ${name}`, async () => {
    const query = new PgDialect().sqlToQuery(sql`
      select ${rowHoldsDocument} as "full", ${publicRowHoldsDocument} as "public"
      from (values (
        ${row.text}::text, ${row.ast}::text::jsonb, ${row.sections}::text::jsonb, ${row.hash}::text,
        ${row.textKey}::text, ${row.normalizedKey}::text, ${row.astKey}::text
      )) as case_law_decisions (
        fulltext, document_ast, sections, content_hash,
        text_s3_key, normalized_s3_key, ast_s3_key
      )
    `);
    const result = await client.query(query.sql, query.params);
    expect(result.rows.at(0)).toEqual({ full: expected, public: expected });
  });
}
