import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { LEGISLATION_PARTIAL_WRITERS } from "../no-direct-legislation-revision-write.ts";
import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);
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
    for (const owner of Object.keys(LEGISLATION_PARTIAL_WRITERS)) {
      const source = readFileSync(
        path.resolve(import.meta.dir, "../..", owner),
        "utf-8",
      );
      expect(await lintSingleRule(RULE, source, { sourcePath: owner })).toEqual(
        [],
      );
    }
  });
});
