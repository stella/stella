import { expect, test } from "bun:test";
import path from "node:path";

const SOURCE_ROOT = path.resolve(import.meta.dir, "../..");
// Insert-only owners may leave this list; new mutation owners must demonstrate
// their refusal through the real handler or materialisation path.
const INSERT_ONLY_OWNERS = [
  "handlers/properties/batch/create.ts",
  "handlers/properties/create.ts",
  "handlers/workspaces/create.ts",
  "handlers/workspaces/duplicate.ts",
  "lib/views/template-properties.ts",
];
const GUARDED_OWNERS = [
  "handlers/properties/update.ts",
  "lib/workflow/materialize-playbook-run.ts",
];

const classifyWriters = (source: string) => {
  const aliases = [...source.matchAll(/\bproperties\s+as\s+(\w+)/gu)]
    .map((match) => match[1])
    .filter((alias) => alias !== undefined);
  const tableNames = ["(?:\\w+\\.)?properties", ...aliases].join("|");
  const writes = [
    ...source.matchAll(
      new RegExp(
        `\\.(insert|update)\\(\\s*(?:${tableNames})\\s*\\)[\\s\\S]*?;`,
        "gu",
      ),
    ),
  ];
  return writes.map((write) => {
    const statement = write[0];
    if (write[1] === "insert" && !statement.includes("onConflictDoUpdate")) {
      return "insert-only";
    }
    if (
      /\.set\(\{\s*(?:status|role):\s*(?:"[^"]*"|'[^']*'|null)\s*,?\s*\}\)/u.test(
        statement,
      )
    ) {
      return "metadata-only";
    }
    const prefix = source.slice(0, write.index);
    const guards = [
      ...prefix.matchAll(
        /if\s*\([^{};]*isFileProperty\([^)]*\)\s*!==\s*isFileProperty\([^)]*\)[^{};]*\)\s*\{([\s\S]*?)\n\s*\}/gu,
      ),
    ];
    const importsPolicy =
      /import\s*\{[^}]*\bisFileProperty\b[^}]*\}\s*from\s*["']@stll\/api-contract\/property-policy["']/u.test(
        source,
      );
    const refusesTransition = guards.some(
      (guard) =>
        /return\b/u.test(guard[1] ?? "") &&
        /\bcode:\s*FILE_PROPERTY_TYPE_IMMUTABLE_CODE\b/u.test(guard[1] ?? "") &&
        /\bretryable:\s*false\b/u.test(guard[1] ?? ""),
    );
    return importsPolicy && refusesTransition ? "guarded" : "unprotected";
  });
};

test("every property content writer is insert-only or refuses file type transitions", async () => {
  const inserts: string[] = [];
  const guarded: string[] = [];
  const unprotected: string[] = [];
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: SOURCE_ROOT })) {
    if (file.includes(".test.") || file.startsWith("tests/")) {
      continue;
    }
    const classes = classifyWriters(
      await Bun.file(path.join(SOURCE_ROOT, file)).text(),
    );
    if (classes.includes("insert-only")) {
      inserts.push(file);
    }
    if (classes.includes("guarded")) {
      guarded.push(file);
    }
    if (classes.includes("unprotected")) {
      unprotected.push(file);
    }
  }
  expect(unprotected.toSorted()).toEqual([]);
  expect(inserts.toSorted()).toEqual(INSERT_ONLY_OWNERS);
  expect(guarded.toSorted()).toEqual(GUARDED_OWNERS);
});

test("a predicate call elsewhere does not authorize a content write", () => {
  const wrong = `
    import { isFileProperty } from "@stll/api-contract/property-policy";
    if (isFileProperty(content)) validateTool(tool);
    await tx.update(properties).set({ content }).where(eq(properties.id, id));
  `;
  expect(classifyWriters(wrong)).toEqual(["unprotected"]);
  expect(
    classifyWriters(
      wrong.replace("set({ content })", 'set({ status: "fresh", content })'),
    ),
  ).toEqual(["unprotected"]);
  expect(
    classifyWriters(
      wrong.replace("update(properties)", "update(schema.properties)"),
    ),
  ).toEqual(["unprotected"]);
  expect(
    classifyWriters(
      wrong
        .replace(
          "import { isFileProperty }",
          'import { properties as columns } from "@/api/db/schema"; import { isFileProperty }',
        )
        .replace("update(properties)", "update(columns)"),
    ),
  ).toEqual(["unprotected"]);
  expect(
    classifyWriters(
      wrong.replace(
        "update(properties).set({ content })",
        "insert(properties).values({ content }).onConflictDoUpdate({ set: { content } })",
      ),
    ),
  ).toEqual(["unprotected"]);
});
