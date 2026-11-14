import { Glob } from "bun";
import { describe, expect, test } from "bun:test";

const SOURCE_ROOT = new URL("../", import.meta.url).pathname;
const EXCLUDED_CREATORS = new Map([
  [
    "handlers/entities/create.ts",
    "creates an empty metadata document with no file source",
  ],
  ["handlers/entities/clip.ts", "creates a link, not a document"],
  [
    "lib/entity-versions/insert-entity-version.ts",
    "low-level row primitive; callers own extraction",
  ],
  [
    "lib/entity-versions/write-file-version.ts",
    "version transaction primitive; callers own extraction",
  ],
  ["lib/tasks/create-task-entity.ts", "creates a task, not a document"],
]);

const isProductionSource = (relativePath: string): boolean =>
  !relativePath.endsWith(".test.ts") &&
  !relativePath.startsWith("tests/") &&
  !relativePath.startsWith("__fixtures__/") &&
  !relativePath.includes("/__fixtures__/");

describe("document extraction source census", () => {
  test.each([
    ["tests/read-scaling/entity-fixture.ts", false],
    ["tests/security/rls-helpers.ts", false],
    ["lib/example.test.ts", false],
    ["handlers/example/__fixtures__/creator.ts", false],
    ["__fixtures__/creator.ts", false],
    ["handlers/entities/upload.ts", true],
    ["lib/contests/creator.ts", true],
    ["handlers/tests-controller.ts", true],
  ] as const)("classifies source boundary %s", (file, production) => {
    expect(isProductionSource(file)).toBe(production);
  });

  test("every production entity-version creator reaches the extraction owner", async () => {
    const uncovered: string[] = [];
    const glob = new Glob("**/*.ts");
    for await (const relativePath of glob.scan({ cwd: SOURCE_ROOT })) {
      if (!isProductionSource(relativePath)) {
        continue;
      }
      const source = await Bun.file(`${SOURCE_ROOT}/${relativePath}`).text();
      if (!/insert\(entityVersions\)|insertEntityVersion\(/u.test(source)) {
        continue;
      }
      if (EXCLUDED_CREATORS.has(relativePath)) {
        continue;
      }
      if (
        !/requestNativeExtractionRun\s*\(/u.test(source) &&
        !/processExtraction\s*\(/u.test(source) &&
        !/writeFileVersion\s*\(/u.test(source) &&
        !relativePath.endsWith("insert-entity-version.ts")
      ) {
        const line = source
          .slice(
            0,
            source.search(/insert\(entityVersions\)|insertEntityVersion\(/u),
          )
          .split("\n").length;
        uncovered.push(`${relativePath}:${line}`);
      }
    }
    expect(uncovered, uncovered.join("\n")).toEqual([]);
  });
});
