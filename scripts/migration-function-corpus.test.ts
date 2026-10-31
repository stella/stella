import { describe, expect, test } from "bun:test";

import { isColumnReferenced } from "./check-dead-columns";
import { currentMigrationFunctionCorpus } from "./migration-function-corpus";

const references = (migrations: string[]) =>
  isColumnReferenced({
    corpus: currentMigrationFunctionCorpus(migrations),
    tsKey: "transactionId",
    sqlName: "transaction_id",
  });

const original = `CREATE FUNCTION proof(p_id text DEFAULT 'x') RETURNS bigint LANGUAGE sql AS $body$
  SELECT "transaction_id" FROM public.proofs WHERE id = p_id;
$body$;`;

describe("current migration function column references", () => {
  test("quoted type names do not acquire keyword aliases", () => {
    const definition = `CREATE FUNCTION proof(p "integer") RETURNS bigint LANGUAGE sql AS $$ SELECT transaction_id FROM proofs; $$;`;
    expect(references([definition, "DROP FUNCTION proof(integer);"])).toBe(
      true,
    );
    expect(references([definition, `DROP FUNCTION proof("integer");`])).toBe(
      false,
    );
  });

  test("declared array bounds retain the array identity", () => {
    const definition = `CREATE FUNCTION proof(p text[2]) RETURNS bigint LANGUAGE sql AS $$ SELECT transaction_id FROM proofs; $$;`;
    expect(references([definition, "DROP FUNCTION proof(text);"])).toBe(true);
    expect(references([definition, "DROP FUNCTION proof(text[]);"])).toBe(
      false,
    );
  });

  test("preserves punctuation inside quoted parameter type identities", () => {
    const definition = `CREATE FUNCTION proof(p "Matter . State") RETURNS bigint LANGUAGE sql AS $$ SELECT transaction_id FROM proofs; $$;`;
    expect(
      references([definition, `DROP FUNCTION proof("Matter.State");`]),
    ).toBe(true);
    expect(
      references([definition, `DROP FUNCTION proof("Matter . State");`]),
    ).toBe(false);
  });

  test("quoted brackets in a type name are distinct from array dimensions", () => {
    const definition = `CREATE FUNCTION proof(p "Matter[]") RETURNS bigint LANGUAGE sql AS $$ SELECT transaction_id FROM proofs; $$;`;
    expect(references([definition, `DROP FUNCTION proof("Matter[]"[]);`])).toBe(
      true,
    );
    expect(references([definition, `DROP FUNCTION proof("Matter"[]);`])).toBe(
      true,
    );
    expect(references([definition, `DROP FUNCTION proof("Matter[]");`])).toBe(
      false,
    );
  });

  test("counts an SQL-only column in the current function body", () => {
    expect(references([original])).toBe(true);
    expect(references([`CREATE TABLE proofs(transaction_id bigint);`])).toBe(
      false,
    );
  });

  test("ignores literals, comments and function parameters that do not read a column", () => {
    expect(
      references([
        `CREATE FUNCTION proof(transaction_id text) RETURNS text LANGUAGE sql AS $$
      -- SELECT transaction_id FROM proofs;
      SELECT 'transaction_id';
    $$;`,
      ]),
    ).toBe(false);
    expect(
      references([
        `-- ${original}\nSELECT 'CREATE FUNCTION fake() RETURNS bigint AS invalid';`,
      ]),
    ).toBe(false);
  });

  test("replacement removes the previous body independently of parameter names and defaults", () => {
    expect(
      references([
        original,
        `CREATE OR REPLACE FUNCTION public.proof(renamed text DEFAULT 'new')
      RETURNS bigint LANGUAGE sql AS $$ SELECT 1; $$;`,
      ]),
    ).toBe(false);
  });

  test("drop removes only its exact overload, and recreation restores a reference", () => {
    const overload = `CREATE FUNCTION proof(p_id integer) RETURNS bigint LANGUAGE sql AS $$ SELECT 1; $$;`;
    expect(
      references([original, overload, "DROP FUNCTION proof(integer);"]),
    ).toBe(true);
    expect(references([original, overload, "DROP FUNCTION proof(text);"])).toBe(
      false,
    );
    expect(
      references([
        original,
        "DROP FUNCTION IF EXISTS public.proof(text);",
        original,
      ]),
    ).toBe(true);
  });

  test("drop normalizes input modes and type aliases but preserves other overloads", () => {
    const definition = `CREATE FUNCTION proof(IN p_id integer, OUT value bigint) LANGUAGE sql AS $$ SELECT transaction_id FROM proofs; $$;`;
    expect(references([definition, "DROP FUNCTION proof(int4);"])).toBe(false);
    expect(
      references([
        original,
        definition,
        "DROP FUNCTION proof(int4), proof(text);",
      ]),
    ).toBe(false);
  });

  test("a dropped quoted function no longer keeps a column alive", () => {
    expect(
      references([
        `CREATE FUNCTION "Odd Name"(p text[]) RETURNS bigint LANGUAGE sql AS $$ SELECT transaction_id FROM proofs; $$;`,
        `DROP FUNCTION "Odd Name"(text[]);`,
      ]),
    ).toBe(false);
  });

  test("reads SQL-standard bodies", () => {
    expect(
      references([
        `CREATE FUNCTION proof() RETURNS bigint LANGUAGE sql RETURN (SELECT transaction_id FROM proofs);`,
      ]),
    ).toBe(true);
    expect(
      references([
        `CREATE FUNCTION proof() RETURNS bigint LANGUAGE sql RETURN (SELECT transaction_id FROM proofs);`,
        "DROP FUNCTION proof();",
      ]),
    ).toBe(false);
  });

  test("array defaults do not create spurious overloads", () => {
    expect(
      references([
        `CREATE FUNCTION proof(p text[] DEFAULT ARRAY['a','b']) RETURNS bigint LANGUAGE sql AS $$ SELECT transaction_id FROM proofs; $$;`,
        `DROP FUNCTION proof("text"[]);`,
      ]),
    ).toBe(false);
  });

  test("a function renamed before it is dropped no longer supplies references", () => {
    expect(
      references([
        original,
        `ALTER FUNCTION proof(text) RENAME TO renamed;`,
        `DROP FUNCTION renamed(text);`,
      ]),
    ).toBe(false);
  });

  test("array dimensions share one PostgreSQL function identity", () => {
    expect(
      references([
        `CREATE FUNCTION proof(p text[][]) RETURNS bigint LANGUAGE sql AS $$ SELECT transaction_id FROM proofs; $$;`,
        `DROP FUNCTION proof(text[]);`,
      ]),
    ).toBe(false);
  });

  test("moving a function schema preserves its identity until the later drop", () => {
    expect(
      references([
        original,
        `ALTER FUNCTION proof(text) SET SCHEMA archive;`,
        `DROP FUNCTION archive.proof(text);`,
      ]),
    ).toBe(false);
  });
});
