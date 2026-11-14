import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  chatWritingRoutinesOf,
  migrationWritesChatRows,
  sqlStatementsOf,
} from "@/api/tests/helpers/chat-data-migration-scan";

const SCAN = { tables: ["chat_threads", "chat_turns"] };

/** Whether `source`, with `earlier` migrations before it, writes chat rows. */
const writes = (source: string, earlier: readonly string[] = []) =>
  migrationWritesChatRows(source, {
    ...SCAN,
    known: chatWritingRoutinesOf([...earlier, source], SCAN),
  });

const WRITE =
  "UPDATE public.chat_threads SET title = 'x' WHERE id = NEW.thread_id;";
const routine = (name: string, body: string, tag = "$$") => `
CREATE OR REPLACE FUNCTION public.${name}() RETURNS trigger
LANGUAGE plpgsql AS ${tag}
BEGIN
  ${body}
  RETURN NEW;
END
${tag};`;

describe("statements", () => {
  test("a dollar-quoted body stays in its statement, whatever its tag", () => {
    for (const tag of ["$$", "$fn$", "$body_1$"]) {
      expect(
        sqlStatementsOf(`${routine("f", WRITE, tag)}\nSELECT 1; SELECT 2;`),
      ).toHaveLength(3);
    }
  });

  test("another tag, a quote and a comment inside a body do not end it", () => {
    const body = `EXECUTE $q$ SELECT ';' $q$; -- a comment; still inside
  PERFORM 'it''s; fine', "odd;name" FROM t; /* ; /* nested ; */ ; */`;
    const statements = sqlStatementsOf(
      `${routine("f", body, "$fn$")}\nSELECT 1;`,
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("$q$ SELECT ';' $q$");
    expect(statements[1]).toBe("SELECT 1");
  });

  test("a comment is not a statement, and a semicolon in one does not split", () => {
    expect(
      sqlStatementsOf(
        "-- UPDATE chat_turns SET x = 1;\nSELECT 1; /* DELETE FROM chat_turns; */ SELECT 2;--> statement-breakpoint",
      ),
    ).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("a body ends at its own tag even inside what looks like a comment", () => {
    // PostgreSQL reads no comments inside a dollar-quoted string.
    expect(
      sqlStatementsOf("DO $fn$ BEGIN NULL; -- $fn$; SELECT 1; SELECT 2;"),
    ).toEqual(["DO $fn$ BEGIN NULL; -- $fn$", "SELECT 1", "SELECT 2"]);
  });

  test("a positional parameter is not a dollar quote", () => {
    expect(sqlStatementsOf("SELECT $1; SELECT a$b$c; SELECT 3;")).toHaveLength(
      3,
    );
  });
});

describe("a migration writes chat rows", () => {
  test("not when it only defines a routine that would", () => {
    for (const tag of ["$$", "$fn$"]) {
      expect(writes(routine("touch_thread", WRITE, tag))).toBe(false);
    }
    // Defined, armed as a trigger and its privileges set: still only stored.
    expect(
      writes(`${routine("touch_thread", WRITE, "$fn$")}
REVOKE ALL ON FUNCTION public.touch_thread() FROM PUBLIC;
COMMENT ON FUNCTION public.touch_thread() IS 'touches the thread';
CREATE TRIGGER touch BEFORE INSERT ON public.chat_turns
  FOR EACH ROW EXECUTE FUNCTION public.touch_thread();`),
    ).toBe(false);
  });

  test("when the same statement runs in a DO block", () => {
    for (const tag of ["$$", "$do$"]) {
      expect(writes(`DO ${tag} BEGIN ${WRITE} END ${tag};`)).toBe(true);
    }
    expect(
      writes("DO $$ BEGIN EXECUTE 'DELETE FROM chat_turns'; END $$;"),
    ).toBe(true);
  });

  test("when a statement after a routine definition writes them", () => {
    expect(
      writes(`${routine("f", "NULL;", "$fn$")}
UPDATE "chat_turns" SET status = 'cancelled';`),
    ).toBe(true);
    expect(writes("ALTER TABLE chat_turns ADD COLUMN x integer;")).toBe(false);
  });

  test("when it defines a chat-writing routine and calls it", () => {
    const definition = routine("touch_thread", WRITE, "$fn$");
    for (const call of [
      "SELECT public.touch_thread();",
      'SELECT "touch_thread" ();',
      "DO $$ BEGIN PERFORM touch_thread(); END $$;",
      "ALTER TABLE notes ADD COLUMN x integer DEFAULT touch_thread();",
    ]) {
      expect(writes(`${definition}\n${call}`), call).toBe(true);
    }
  });

  test("when it calls a routine that calls a chat-writing one", () => {
    expect(
      writes(`${routine("touch_thread", WRITE, "$a$")}
${routine("outer_touch", "PERFORM touch_thread();", "$b$")}
SELECT outer_touch();`),
    ).toBe(true);
  });

  test("when it writes a table whose trigger runs a chat-writing routine", () => {
    expect(
      writes(`${routine("touch_thread", WRITE, "$fn$")}
CREATE TRIGGER touch AFTER UPDATE ON public.notes
  FOR EACH ROW EXECUTE FUNCTION public.touch_thread();
UPDATE notes SET body = body;`),
    ).toBe(true);
  });

  test("when it calls or fires a chat-writing routine an earlier migration defined", () => {
    const earlier = [
      `${routine("touch_thread", WRITE, "$fn$")}
CREATE TRIGGER touch AFTER UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION touch_thread();`,
    ];
    expect(writes("SELECT touch_thread();", earlier)).toBe(true);
    expect(writes("UPDATE notes SET body = body;", earlier)).toBe(true);
    expect(writes("UPDATE other SET body = body;", earlier)).toBe(false);
  });

  test("not when it calls a routine that writes no chat row", () => {
    expect(
      writes(`${routine("touch_note", "UPDATE notes SET body = body;")}
SELECT touch_note();`),
    ).toBe(false);
  });
});

test("the turn position migration defines its trigger and writes no chat row", () => {
  const source = readFileSync(
    path.resolve(
      import.meta.dir,
      "../../../drizzle/20261114200000_chat_turn_ordinals/migration.sql",
    ),
    "utf-8",
  );
  const known = chatWritingRoutinesOf([source], SCAN);
  expect([...known.routines]).toEqual(["assign_chat_turn_ordinal"]);
  expect(migrationWritesChatRows(source, { ...SCAN, known })).toBe(false);
  // The same migration with a backfill appended would count.
  expect(
    migrationWritesChatRows(
      `${source};\nUPDATE chat_turns SET ordinal = 1 WHERE ordinal IS NULL;`,
      { ...SCAN, known },
    ),
  ).toBe(true);
});
