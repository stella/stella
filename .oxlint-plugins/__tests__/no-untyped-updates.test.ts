import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects broad unknown and any records at typed update sinks", async () => {
  expect(
    await lintSingleRule(
      "no-untyped-updates",
      'import type { Transaction } from "@/api/db/root";\ndeclare const db: Transaction;\nconst updates: Record<string, unknown> = {};\ndb.update(table).set(updates);\nconst anyUpdates: Record<string, any> = {};\ndb.update(table).set(anyUpdates);',
    ),
  ).toEqual([4, 6]);
});

test("follows type aliases stable value aliases and object spreads", async () => {
  expect(
    await lintSingleRule(
      "no-untyped-updates",
      'import type { Transaction } from "@/api/db/root";\ndeclare const db: Transaction;\ntype Updates = Record<string, unknown>;\nconst updates: Updates = {};\nconst alias = updates;\ndb.update(table).set(alias);\nconst spreadUpdates: Updates = {};\ndb.update(table).set({ ...spreadUpdates, title });',
    ),
  ).toEqual([6, 8]);
});

test("follows typed parameters and helper return values", async () => {
  expect(
    await lintSingleRule(
      "no-untyped-updates",
      'import type { Transaction } from "@/api/db/root";\ndeclare const db: Transaction;\nconst load = (): Record<string, unknown> => ({});\nfunction write(updates: Record<string, unknown>) { db.update(table).set(updates); }\ndb.update(table).set(load());',
    ),
  ).toEqual([4, 5]);
});

test("accepts closed update types and unrelated broad metadata", async () => {
  expect(
    await lintSingleRule(
      "no-untyped-updates",
      'import type { Transaction } from "@/api/db/root";\ndeclare const db: Transaction;\nconst update: { title?: string } = {};\ndb.update(table).set(update);\nconst metadata: Record<string, unknown> = {};\nnew Map().set("metadata", metadata);',
    ),
  ).toEqual([]);
});

test("does not infer a Drizzle sink from fluent names alone", async () => {
  expect(
    await lintSingleRule(
      "no-untyped-updates",
      'declare const cache: { update: (key: unknown) => { set: (value: unknown) => unknown } };\nconst metadata: Record<string, unknown> = {};\ncache.update("metadata").set(metadata);',
    ),
  ).toEqual([]);
});

test("rejects broad updates through canonical imported schema tables", async () => {
  expect(
    await lintSingleRule(
      "no-untyped-updates",
      'import { files as table } from "@/api/db/schema";\nconst updates: Record<string, unknown> = {};\ndb.update(table).set(updates);',
    ),
  ).toEqual([3]);
  expect(
    await lintSingleRule(
      "no-untyped-updates",
      'import { files as table } from "other-schema";\nconst updates: Record<string, unknown> = {};\ndb.update(table).set(updates);',
    ),
  ).toEqual([]);
});
