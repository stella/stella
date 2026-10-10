import { PGlite } from "@electric-sql/pglite";
import { describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { PgDialect, PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { existsSync } from "node:fs";
import path from "node:path";

import * as authSchema from "@/api/db/auth-schema";
import * as schema from "@/api/db/schema";

import {
  NON_CONTENT_TABLES,
  checkSeal,
  classifySealTable,
  isSeal,
  readTableDigests,
} from "./seed-seal";
import type { Seal } from "./seed-seal";

const baseline = {
  content: { "public.entities": "1:seed", "public.usage_events": "0:empty" },
  nonContent: Object.fromEntries(
    Object.keys(NON_CONTENT_TABLES).map((table) => [table, "0:empty"]),
  ),
} satisfies Seal;

const check = (current: Seal) =>
  checkSeal({ fresh: false, sealed: baseline, current });

describe("seeded content seal", () => {
  test("fresh takes precedence over absent or changed baselines", () => {
    for (const sealed of [null, baseline]) {
      expect(checkSeal({ fresh: true, sealed, current: baseline })).toEqual({
        status: "fresh",
      });
    }
  });

  test("a seeded database without a baseline is unsealed", () => {
    expect(
      checkSeal({ fresh: false, sealed: null, current: baseline }),
    ).toEqual({
      status: "unsealed",
    });
  });

  test("unchanged content and classified tables are pristine", () => {
    expect(check(baseline)).toEqual({ status: "pristine", changes: [] });
  });

  test("every declared exemption reports its kind without modifying content", () => {
    for (const [table, classification] of Object.entries(NON_CONTENT_TABLES)) {
      expect(
        check({
          content: baseline.content,
          nonContent: { ...baseline.nonContent, [table]: "1:changed" },
        }),
      ).toEqual({
        status: "pristine",
        changes: [{ table, ...classification }],
      });
    }
  });

  test("added, removed, and changed content tables block capture alongside derivations", () => {
    for (const content of [
      { ...baseline.content, "public.entities": "2:changed" },
      { "public.usage_events": "0:empty" },
      { ...baseline.content, "public.new_content": "1:new" },
    ]) {
      const result = check({
        content,
        nonContent: {
          ...baseline.nonContent,
          "public.document_review_parties": "1:derived",
        },
      });
      expect(result.status).toBe("modified");
      expect(result.changes).toContainEqual({
        table: "public.document_review_parties",
        ...NON_CONTENT_TABLES["public.document_review_parties"],
      });
      expect(result.tables).toHaveLength(1);
    }
  });

  test("new tables and chat content default to fingerprinted content", () => {
    for (const table of [
      "public.new_content",
      "public.chat_threads",
      "public.template_chat_threads",
    ]) {
      expect(classifySealTable(table)).toEqual({ kind: "content" });
    }
  });

  test("unclassified exemption digests fail closed", () => {
    expect(() =>
      check({
        content: baseline.content,
        nonContent: { ...baseline.nonContent, "public.unknown": "1:changed" },
      }),
    ).toThrow("Unclassified non-content table");
  });

  test("old or malformed baselines cannot become trusted classified seals", () => {
    expect(isSeal(baseline)).toBe(true);
    for (const value of [
      null,
      [],
      { "public.entities": "1:seed" },
      { content: {}, nonContent: { table: 1 } },
    ]) {
      expect(isSeal(value)).toBe(false);
    }
  });

  test("declared exemptions name existing tables and derivations name existing handlers", () => {
    const tableNames = new Set(
      Object.values({ ...schema, ...authSchema })
        .filter((value) => is(value, PgTable))
        .map((table) => {
          const config = getTableConfig(table);
          return `${config.schema ?? "public"}.${config.name}`;
        }),
    );
    for (const [table, classification] of Object.entries(NON_CONTENT_TABLES)) {
      expect(tableNames.has(table)).toBe(true);
      if (classification.kind !== "derived-on-read") {
        continue;
      }
      expect(
        existsSync(
          path.resolve(import.meta.dir, "../../..", classification.owner),
        ),
      ).toBe(true);
      expect(classification.reason.length).toBeGreaterThan(0);
    }
  });

  test("SQL fingerprints exempt only party-detection usage while protecting other actions and input", async () => {
    const pg = new PGlite();
    const dialect = new PgDialect();
    const db = {
      execute: async <Row extends Record<string, unknown>>(
        query: Parameters<typeof dialect.sqlToQuery>[0],
      ) => {
        const { sql, params } = dialect.sqlToQuery(query);
        return (await pg.query<Row>(sql, params)).rows;
      },
    };
    try {
      await pg.exec(`
        CREATE TABLE entities (id integer, content text);
        CREATE TABLE document_review_parties (id integer, parties text);
        CREATE TABLE usage_events (id integer, action_kind text);
        CREATE TABLE session (id integer);
        CREATE TABLE chat_threads (id integer, title text);
        CREATE TABLE template_chat_threads (id integer, chat_thread_id integer);
        INSERT INTO entities VALUES (1, 'seed');
      `);
      const sealed = await readTableDigests(db);
      await pg.exec(`
        INSERT INTO document_review_parties VALUES (1, 'derived');
        INSERT INTO usage_events VALUES (1, 'document-reviews.parties');
        INSERT INTO session VALUES (1);
      `);
      const derived = checkSeal({
        fresh: false,
        sealed,
        current: await readTableDigests(db),
      });
      expect(derived.status).toBe("pristine");
      expect(
        derived.changes?.map(({ table, kind }) => ({ table, kind })),
      ).toEqual([
        { table: "public.document_review_parties", kind: "derived-on-read" },
        { table: "public.session", kind: "operational" },
        { table: "public.usage_events", kind: "derived-on-read" },
      ]);
      for (const actionKind of ["chat", null]) {
        await pg.query("INSERT INTO usage_events VALUES (2, $1)", [actionKind]);
        const usageOnly = checkSeal({
          fresh: false,
          sealed,
          current: await readTableDigests(db),
        });
        expect(usageOnly.status).toBe("modified");
        expect(usageOnly.tables).toEqual(["public.usage_events"]);
        await pg.exec("DELETE FROM usage_events WHERE id = 2");
      }
      await pg.exec(`
        INSERT INTO usage_events VALUES (2, 'chat'), (3, NULL);
        INSERT INTO chat_threads VALUES (1, 'entered');
        INSERT INTO template_chat_threads VALUES (1, 1);
        UPDATE entities SET content = 'entered';
      `);
      const modified = checkSeal({
        fresh: false,
        sealed,
        current: await readTableDigests(db),
      });
      expect(modified.status).toBe("modified");
      expect(modified.tables).toEqual([
        "public.chat_threads",
        "public.entities",
        "public.template_chat_threads",
        "public.usage_events",
      ]);
      await pg.exec(
        `DELETE FROM usage_events WHERE action_kind IS DISTINCT FROM 'document-reviews.parties';`,
      );
      const restoredUsage = await readTableDigests(db);
      expect(restoredUsage.content["public.usage_events"]).toBe(
        sealed.content["public.usage_events"],
      );
      expect(restoredUsage.nonContent["public.usage_events"]).not.toBe(
        sealed.nonContent["public.usage_events"],
      );
    } finally {
      await pg.close();
    }
  });
});
