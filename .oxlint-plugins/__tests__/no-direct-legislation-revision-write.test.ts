import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { LEGISLATION_PARTIAL_WRITERS } from "../no-direct-legislation-revision-write.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-direct-legislation-revision-write";
const IMPORT =
  'import { legislationDocuments as versions } from "@/api/db/schema";';
const lint = async (
  statements: readonly string[],
  sourcePath = "apps/api/src/handlers/legislation/other.ts",
) =>
  await lintSingleRule(RULE, [IMPORT, ...statements, ""].join("\n"), {
    sourcePath,
  });

describe.serial("legislation revision write ownership", () => {
  test("rejects inserts, updates and deletes outside the ingestion owner", async () => {
    expect(
      await lint([
        "db.insert(versions).values({ fulltext: text });",
        "db.update(versions).set({ metadata });",
        'db["delete"](versions);',
      ]),
    ).toEqual([2, 3, 4]);
  });

  test("resolves namespaces and immutable table aliases without confusing shadowed locals", async () => {
    expect(
      await lint([
        'import * as schema from "@/api/db/schema/legislation";',
        "const table = schema.legislationDocuments;",
        "db.update(table).set({ fulltext: text });",
        'db.update(schema["legislationDocuments"]).set({ metadata });',
        "const unrelated = (versions) => db.update(versions).set({ fulltext: text });",
      ]),
    ).toEqual([4, 5]);
  });

  test("accepts ingestion and test fixture writes", async () => {
    const source = [
      "db.insert(versions).values({ fulltext: text, metadata });",
    ];
    expect(
      await lint(source, "apps/api/src/handlers/legislation/ingestion.ts"),
    ).toEqual([]);
    expect(
      await lint(
        source,
        "apps/api/src/handlers/legislation/ingestion.db.test.ts",
      ),
    ).toEqual([]);
    expect(
      await lint(source, "apps/api/src/tests/helpers/legislation-fixture.ts"),
    ).toEqual([]);
  });

  for (const [owner, fields] of Object.entries(LEGISLATION_PARTIAL_WRITERS)) {
    test(`confines ${owner} to its declared columns`, async () => {
      const allowed = fields
        .map((field) => `${String(field)}: value`)
        .join(", ");
      expect(
        await lint(
          [
            `db.update(versions).set({ ${allowed} });`,
            "db.update(versions).set({ fulltext: text });",
            "db.update(versions).set({ metadata });",
            "db.update(versions).set({ ...payload });",
            "db.update(versions).set(payload);",
            'db.update(versions).set({ ["projectionEpoch"]: value });',
            "db.insert(versions).values({ projectionEpoch: value });",
            "db.delete(versions);",
          ],
          owner,
        ),
      ).toEqual([3, 4, 5, 6, 7, 8, 9]);
    });
  }

  test("accepts the existing partial owners' production writes", async () => {
    const results = await Promise.all(
      Object.keys(LEGISLATION_PARTIAL_WRITERS).map(async (lintCase, index) => {
        const owner = lintCase;
        const source = readFileSync(
          path.resolve(import.meta.dir, "../..", owner),
          "utf-8",
        );

        return {
          label: `case ${index + 1}: ${JSON.stringify(lintCase)}`,
          result: await lintSingleRule(RULE, source, { sourcePath: owner }),
          expected: [],
        };
      }),
    );
    expect(results.map(({ label, result }) => ({ label, result }))).toEqual(
      results.map(({ label, expected }) => ({ label, result: expected })),
    );
  });
});

describe.serial("replay revision column plans", () => {
  const owner =
    "apps/api/src/lib/legal-search/corpus-index-projection-desired-state.ts";
  const declaration =
    'import {replayWrite as plan} from "@/api/lib/case-law/replay-write";';
  const update = "db.update(versions).set(write.set).where(write.setWhere);";
  test("allows the same explicit partial columns and implicit hooks as literal SETs", async () => {
    expect(
      await lint(
        [
          declaration,
          "const write = plan(versions, {projectionEpoch: value});",
          update,
        ],
        owner,
      ),
    ).toEqual([]);
  });
  test("forbidden revision fields and explicit timestamps stay forbidden through plans", async () => {
    await Promise.all(
      [
        "{fulltext: text}",
        "{metadata: value}",
        "{projectionEpoch: value, updatedAt: now}",
        "{projectionEpoch: value}, {modifiedAt: {column: versions.updatedAt, value}}",
      ].map(async (payload) => {
        expect(
          await lint(
            [declaration, `const write = plan(versions, ${payload});`, update],
            owner,
          ),
        ).toEqual([4]);
      }),
    );
  });
  test("SET object spreads never inherit a plan's partial-owner proof", async () => {
    await Promise.all(
      [
        "{...write.set}",
        "{...write.set,...{fulltext:text}}",
        "{...write.set,fulltext:text}",
        "{...opaque,...write.set}",
        "{...write.set,...opaque}",
      ].map(async (set) => {
        expect(
          await lint(
            [
              declaration,
              "const write = plan(versions,{projectionEpoch:value});",
              `db.update(versions).set(${set}).where(write.setWhere);`,
            ],
            owner,
          ),
        ).toEqual([4]);
      }),
    );
  });
  test("opaque, shadowed, escaped and mutated plans are rejected", async () => {
    await Promise.all(
      [
        "const write = plan(versions, {...payload});",
        "const write = plan(versions, payload);",
        "let write = plan(versions, {projectionEpoch: value});",
        "const write = plan(versions, {projectionEpoch: value}); write.set.fulltext = text;",
        "const write = plan(versions, {projectionEpoch: value}); Object.assign(write.set, payload);",
        "const write = plan(versions, {projectionEpoch: value}); write.setWhere.append(sql);",
        "const write = plan(versions, {projectionEpoch: value}); mutate(write);",
        "const write = unknown(versions, {projectionEpoch: value});",
      ].map(async (body) => {
        expect(await lint([declaration, body, update], owner)).toEqual([4]);
      }),
    );
    expect(
      await lint(
        [
          declaration,
          `function inner(plan) { const write = plan(versions, {projectionEpoch: value}); ${update} }`,
        ],
        owner,
      ),
    ).toEqual([3]);
    expect(
      await lint(
        [
          declaration,
          `const write = plan(versions, {projectionEpoch: value}); function inner(write) { ${update} }`,
        ],
        owner,
      ),
    ).toEqual([3]);
  });
});
