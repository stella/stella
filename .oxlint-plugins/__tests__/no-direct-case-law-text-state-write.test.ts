import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { lintSingleRule } from "./lint-single-rule.ts";

const RULE = "no-direct-case-law-text-state-write";
const IMPORT =
  'import { caseLawDecisions as decisions } from "@/api/db/schema/case-law";';
const lint = async (
  lines: readonly string[],
  sourcePath = "apps/api/src/lib/other.ts",
) =>
  await lintSingleRule(RULE, [IMPORT, ...lines, ""].join("\n"), { sourcePath });

describe.serial("case-law text state ownership", () => {
  test("rejects direct, aliased, spread, array and conflict mutations", async () => {
    expect(
      await lint([
        "db.update(decisions).set({textState: state});",
        "const payload = { textState: state };",
        "db.insert(decisions).values(payload);",
        "db.update(decisions).set({...payload});",
        "db.insert(decisions).values([{textState: state}]);",
        "db.insert(decisions).values({id}).onConflictDoUpdate({target: decisions.id,set:{textState:state}});",
        "const query = db.update(decisions);",
        'query.set({["textState"]:state});',
      ]),
    ).toEqual([2, 4, 5, 6, 7, 9]);
  });
  test("resolves namespace/table aliases and avoids shadowed tables and projections", async () => {
    expect(
      await lint([
        'import * as schema from "@/api/db/schema";',
        "const table = schema.caseLawDecisions;",
        "db.update(table).set({textState:state});",
        "const other = (decisions) => db.update(decisions).set({textState:state});",
        "db.update(decisions).set({fulltext:text});",
        "const projection = {textState:state};",
        "db.select({textState:decisions.textState}).from(decisions);",
      ]),
    ).toEqual([4]);
  });
  test("detects raw SQL, quoted names, interpolated table and column, and insert conflicts", async () => {
    expect(
      await lint(
        [
          `db.execute(sql\`UPDATE case_law_decisions SET text_state=\${state}\`);`,
          `db.execute(sql\`UPDATE public."case_law_decisions" SET "text_state"=\${state}\`);`,
          `db.execute(sql\`UPDATE \${decisions} SET \${decisions.textState}=\${state}\`);`,
          'db.execute("INSERT INTO case_law_decisions(id,text_state) VALUES ($1,$2)");',
          'db.execute("INSERT INTO case_law_decisions(id) VALUES ($1) ON CONFLICT(id) DO UPDATE SET text_state=$2");',
          'db.execute("SELECT text_state FROM case_law_decisions");',
          'db.execute("UPDATE case_law_decisions SET fulltext=$1");',
        ],
        "scripts/repair.ts",
      ),
    ).toEqual([2, 3, 4, 5, 6]);
  });
  test("only the state owner and test files are exempt", async () => {
    const source = ["db.update(decisions).set({textState:state});"];
    expect(
      await lint(source, "apps/api/src/lib/case-law/fulltext-state-store.ts"),
    ).toEqual([]);
    expect(await lint(source, "apps/api/src/lib/other.test.ts")).toEqual([]);
    expect(await lint(source, "apps/api/src/tests/helpers/seed.ts")).toEqual(
      [],
    );
  });
  test("the registered fixture reaches the reporting boundary", async () => {
    const fixturePath =
      ".oxlint-plugins/__fixtures__/no-direct-case-law-text-state-write.fixture.ts";
    const fixture = readFileSync(
      new URL(
        "../__fixtures__/no-direct-case-law-text-state-write.fixture.ts",
        import.meta.url,
      ),
      "utf-8",
    );
    const unsuppressed = fixture.replaceAll(
      /^[ \t]*\/\/ oxlint-disable-next-line no-direct-case-law-text-state-write\/no-direct-case-law-text-state-write --[^\n]*\n/gmu,
      "",
    );
    expect(unsuppressed).not.toBe(fixture);
    expect(
      await lintSingleRule(RULE, fixture, { sourcePath: fixturePath }),
    ).toEqual([]);
    expect(
      await lintSingleRule(RULE, unsuppressed, { sourcePath: fixturePath }),
    ).toEqual([13, 16, 19]);
  });
  test("actual application and script source has no state writer outside its owner", async () => {
    const root = path.resolve(import.meta.dir, "../..");
    const candidates = [
      ...new Bun.Glob("{apps,scripts}/**/*.{ts,tsx}").scanSync({ cwd: root }),
    ]
      .filter(
        (filename) =>
          !filename.includes("/node_modules/") && !filename.includes("/dist/"),
      )
      .map((filename) => ({
        filename,
        source: readFileSync(path.join(root, filename), "utf-8"),
      }))
      .filter(({ source }) => /textState|text_state/u.test(source));
    expect(candidates.length).toBeGreaterThan(0);
    const results = await Promise.all(
      candidates.map(async ({ filename, source }) => ({
        filename,
        diagnostics: await lintSingleRule(RULE, source, {
          sourcePath: filename,
        }),
      })),
    );
    expect(results.filter(({ diagnostics }) => diagnostics.length > 0)).toEqual(
      [],
    );
  });
});
