/**
 * Census: every production write of `entities.name` goes through
 * `normalizeEntityName`, directly or through the branded insert owner.
 *
 * `entities.name` stays a plain text column because fixtures write it freely,
 * so the compiler alone cannot hold a new writer to the owner. A writer this
 * census has not seen fails until it is listed here, and a listed writer that
 * stops calling the owner fails too.
 */

import { describe, expect, test } from "bun:test";
import path from "node:path";

const API_SRC = path.resolve(import.meta.dir, "../..");

const OWNER_CALL = "normalizeEntityName(";

/** Writers whose values are typed `NamedEntityInsert`, so the brand decides. */
const BRANDED_INSERTERS = new Set([
  "lib/entities/sibling-name-insert.ts",
  "lib/entity-versions/insert-entity-batch.ts",
]);

const NORMALIZING_WRITERS = new Set([
  "handlers/entities/clip.ts",
  "handlers/entities/create.ts",
  "handlers/entities/rename-operation.ts",
  "lib/infosoud/agenda-import.ts",
  "lib/tasks/create-task-entity.ts",
  "lib/tasks/update-task.ts",
]);

/** `.set(entitySet)` here is built from task fields and never holds `name`. */
const UPDATES_WITHOUT_NAME = new Set(["handlers/work-obligations/update.ts"]);

const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//gu;
const INSERT_RE = /\.insert\(entities\)/u;
const UPDATE_SET_RE = /\.update\(entities\)\s*\.set\(/gu;
const WRITES_NAME_RE = /\bname\b|\.\.\./u;

const setArgument = (source: string, openParenEnd: number): string => {
  let depth = 1;
  let index = openParenEnd;
  while (depth > 0 && index < source.length) {
    const character = source.charAt(index);
    if (character === "(") {
      depth += 1;
    }
    if (character === ")") {
      depth -= 1;
    }
    index += 1;
  }
  return source.slice(openParenEnd, index - 1);
};

const updatesName = (source: string): boolean =>
  [...source.matchAll(UPDATE_SET_RE)].some((match) => {
    const argument = setArgument(source, match.index + match[0].length);
    // A bare identifier can hold anything, so it counts until listed.
    return (
      WRITES_NAME_RE.test(argument) || !argument.trimStart().startsWith("{")
    );
  });

const readProductionSources = async (): Promise<Map<string, string>> => {
  const sources = new Map<string, string>();
  for await (const relativePath of new Bun.Glob("**/*.ts").scan(API_SRC)) {
    if (
      relativePath.endsWith(".test.ts") ||
      relativePath.startsWith("tests/")
    ) {
      continue;
    }
    const source = await Bun.file(path.join(API_SRC, relativePath)).text();
    sources.set(relativePath, source.replaceAll(BLOCK_COMMENT_RE, ""));
  }
  return sources;
};

describe("entities.name writers", () => {
  test("are exactly the listed files, each using the owner", async () => {
    const sources = await readProductionSources();
    const writers = [...sources]
      .filter(
        ([relativePath, source]) =>
          INSERT_RE.test(source) ||
          (updatesName(source) && !UPDATES_WITHOUT_NAME.has(relativePath)),
      )
      .map(([relativePath]) => relativePath)
      .toSorted();

    expect(writers).toEqual(
      [...BRANDED_INSERTERS, ...NORMALIZING_WRITERS].toSorted(),
    );

    expect(
      [...NORMALIZING_WRITERS].filter(
        (relativePath) => !sources.get(relativePath)?.includes(OWNER_CALL),
      ),
    ).toEqual([]);
  });

  test("the update exemptions still match a write", async () => {
    const sources = await readProductionSources();
    for (const relativePath of UPDATES_WITHOUT_NAME) {
      expect(updatesName(sources.get(relativePath) ?? "")).toBe(true);
    }
  });

  test("the scan reaches a production-shaped multi-line update", () => {
    const source = `await tx
      .update(entities)
      .set({ name: body.name, updatedAt: new Date() })`;
    expect(updatesName(source)).toBe(true);
    expect(
      updatesName(`tx.update(entities).set({ currentVersionId: fn(a) })`),
    ).toBe(false);
  });
});
