import { panic } from "better-result";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import fc from "fast-check";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript6";

import { compareCodeUnit } from "@stll/collation";
import { assertProperty } from "@stll/property-testing";

import { formattedLikeRepository } from "./generated-artifacts";
import {
  breakingApiChanges,
  checkPackageApi,
  generateApiReport,
  printCanonicalDeclaration,
} from "./package-api-report";

// timeout: each case type-checks fixture packages and their published
// declarations, 5 to 12 seconds on a loaded CI runner.
setDefaultTimeout(30_000);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const git = (root: string, args: string[]): void => {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
};

const fixture = async (version = "1.0.0"): Promise<string> => {
  const root = mkdtempSync(path.join(tmpdir(), "package-api-"));
  roots.push(root);
  mkdirSync(path.join(root, "packages/fixture/src"), { recursive: true });
  mkdirSync(path.join(root, ".changeset"));
  writeFileSync(
    path.join(root, "packages/fixture/package.json"),
    JSON.stringify({
      name: "@stll/fixture",
      version,
      private: false,
      publishConfig: { access: "public" },
      exports: {
        ".": "./src/index.ts",
        "./model": "./src/model.ts",
        "./theme.css": "./src/theme.css",
      },
    }),
  );
  writeFileSync(
    path.join(root, "packages/fixture/src/index.ts"),
    'export { convert } from "./model";\nexport type { Input } from "./model";\n',
  );
  writeFileSync(
    path.join(root, "packages/fixture/src/model.ts"),
    "export type Input = string | number;\nexport const convert = (input: Input): string => String(input);\n",
  );
  writeFileSync(
    path.join(root, "packages/fixture/src/theme.css"),
    ":root {}\n",
  );
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  // The temporary repository has no project hooks or signing identity.
  await write(root);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture baseline"]);
  git(root, ["branch", "baseline"]);
  return root;
};

const BASE_SCRIPT = path.join(import.meta.dir, "package-api-base.sh");
const PRELOAD = path.join(import.meta.dir, "offline-network-preload.ts");

/** The fixture's Git base, materialised as the CI step does. */
const baseDir = (root: string): string => {
  const directory = mkdtempSync(path.join(tmpdir(), "package-api-base-"));
  roots.push(directory);
  const result = Bun.spawnSync(["bash", BASE_SCRIPT, "baseline", directory], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  return directory;
};

const run = (root: string) =>
  checkPackageApi({
    root,
    baseDir: baseDir(root),
    packageDirs: ["packages/fixture"],
  });
const write = async (root: string): Promise<void> => {
  writeFileSync(
    path.join(root, "packages/fixture/api-report.json"),
    await formattedLikeRepository(
      JSON.stringify(
        generateApiReport(path.join(root, "packages/fixture")),
        null,
        2,
      ),
      "json",
    ),
  );
};

const replace = (root: string, file: string, content: string): void => {
  writeFileSync(path.join(root, `packages/fixture/${file}`), content);
};

test("a removed re-export still fails after committing the regenerated report", async () => {
  const root = await fixture();
  replace(root, "src/index.ts", 'export type { Input } from "./model";\n');
  await write(root);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "remove export"]);
  const errors = run(root).join("\n");
  expect(errors).toContain(".#convert: removed export");
  expect(errors).toContain("consumers outside this repository");
});

test("additions require regeneration and then pass without a major changeset", async () => {
  const root = await fixture();
  replace(
    root,
    "src/index.ts",
    'export { convert } from "./model";\nexport type { Input } from "./model";\nexport const added = 1;\n',
  );
  expect(run(root).join("\n")).toContain("bun run update:package-api");
  await write(root);
  expect(run(root)).toEqual([]);
  const packageDir = path.join(root, "packages/fixture");
  const report = generateApiReport(packageDir);
  expect(report.entrypoints["."]).toMatchObject({
    exports: [
      { name: "Input", kind: "type" },
      { name: "added", kind: "variable" },
      { name: "convert", kind: "variable" },
    ],
  });
  expect(
    await formattedLikeRepository(JSON.stringify(report, null, 2), "json"),
  ).toBe(readFileSync(path.join(packageDir, "api-report.json"), "utf-8"));
});

test("only a package-specific major changeset introduced by this PR authorizes breakage", async () => {
  const root = await fixture();
  writeFileSync(
    path.join(root, ".changeset/preexisting.md"),
    '---\n"@stll/fixture": major\n---\nExisting release.\n',
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "pending release"]);
  git(root, ["branch", "-f", "baseline"]);
  replace(root, "src/index.ts", "export {};\n");
  await write(root);
  expect(run(root).join("\n")).toContain("removed export");
  writeFileSync(
    path.join(root, ".changeset/current.md"),
    '---\n"@stll/other": major\n"@stll/fixture": minor\n---\nRelease.\n',
  );
  git(root, ["add", "."]);
  expect(run(root).join("\n")).toContain("removed export");
  writeFileSync(
    path.join(root, ".changeset/current.md"),
    '---\n"@stll/fixture": major\n---\nRemove exports from `@stll/fixture`.\n',
  );
  expect(run(root)).toEqual([]);
  replace(root, "src/index.ts", "export const extra = 1;\n");
  expect(run(root).join("\n")).toContain("stale");
});

test.each(["0.57.0", "1.0.0"])(
  "entrypoint removals require a named declaration and a breaking release type for %s",
  async (version) => {
    const root = await fixture(version);
    replace(
      root,
      "package.json",
      JSON.stringify({
        name: "@stll/fixture",
        version,
        exports: { ".": "./src/index.ts", "./theme.css": "./src/theme.css" },
      }),
    );
    await write(root);
    for (const type of ["patch", "minor", "major"]) {
      for (const entrypoint of [
        "./model",
        "@stll/fixture/model",
        "./model-other",
        "@stll/fixture/model/child",
        "",
      ]) {
        writeFileSync(
          path.join(root, ".changeset/removal.md"),
          `---\n"@stll/fixture": ${type}\n---\nRemove the \`${entrypoint}\` entrypoint.\n`,
        );
        git(root, ["add", "."]);
        const authorized =
          (type === "major" ||
            (version.startsWith("0.") && type === "minor")) &&
          (entrypoint === "./model" || entrypoint === "@stll/fixture/model");
        expect(
          run(root).some((error) =>
            error.includes("./model: removed entrypoint"),
          ),
        ).toBe(!authorized);
      }
    }
    rmSync(path.join(root, ".changeset/removal.md"));
    git(root, ["add", "."]);
    expect(run(root).join("\n")).toContain("./model: removed entrypoint");
  },
);

test("an existing declaration cannot authorize a later removal", async () => {
  const root = await fixture("0.57.0");
  const file = path.join(root, ".changeset/existing.md");
  writeFileSync(file, '---\n"@stll/fixture": minor\n---\nRemove `./model`.\n');
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "existing declaration"]);
  git(root, ["branch", "-f", "baseline"]);
  replace(
    root,
    "package.json",
    JSON.stringify({
      name: "@stll/fixture",
      version: "0.57.0",
      exports: { ".": "./src/index.ts", "./theme.css": "./src/theme.css" },
    }),
  );
  await write(root);
  writeFileSync(
    file,
    '---\n"@stll/fixture": minor\n---\nRemove `./model`. More detail.\n',
  );
  expect(run(root).join("\n")).toContain("./model: removed entrypoint");
  writeFileSync(
    path.join(root, ".changeset/new.md"),
    '---\n"@stll/other": major\n---\nRemove `./model`.\n',
  );
  git(root, ["add", "."]);
  expect(run(root).join("\n")).toContain("./model: removed entrypoint");
});

test("narrowing a referenced parameter type fails, while widening a parameter passes", async () => {
  const root = await fixture();
  replace(
    root,
    "src/model.ts",
    "export type Input = string;\nexport const convert = (input: Input): string => input;\n",
  );
  await write(root);
  const errors = run(root).join("\n");
  expect(errors).toContain("convert: incompatible value signature");
  expect(errors).toContain("Input: incompatible type signature");
  const packageDir = path.join(root, "packages/fixture");
  const before = generateApiReport(packageDir);
  replace(
    root,
    "src/model.ts",
    "export type Input = string;\nexport const convert = (input: string | number): string => String(input);\n",
  );
  const after = generateApiReport(packageDir);
  expect(breakingApiChanges({ before, after, packageDir })).toEqual([]);
});

test("entrypoint removals, overload removals and asset removals are visible", async () => {
  const root = await fixture();
  replace(
    root,
    "src/model.ts",
    "export type Input = string | number;\nexport function convert(input: string): string;\nexport function convert(input: number): number;\nexport function convert(input: Input): Input { return input; }\n",
  );
  await write(root);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "overloaded baseline"]);
  git(root, ["branch", "-f", "baseline"]);
  replace(
    root,
    "src/model.ts",
    "export type Input = string | number;\nexport function convert(input: string): string { return input; }\n",
  );
  await write(root);
  expect(run(root).join("\n")).toContain(
    "convert: incompatible value signature",
  );
  replace(
    root,
    "package.json",
    JSON.stringify({
      name: "@stll/fixture",
      exports: { ".": "./src/index.ts" },
    }),
  );
  await write(root);
  const removals = run(root).join("\n");
  expect(removals).toContain("./model: removed entrypoint");
  expect(removals).toContain("./theme.css: removed entrypoint");
});

test("runtime exports cannot silently become type-only, including export stars", async () => {
  const root = await fixture();
  replace(
    root,
    "src/model.ts",
    "export class Input {}\nexport const convert = 1;\n",
  );
  replace(root, "src/index.ts", 'export * from "./model";\n');
  await write(root);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "runtime baseline"]);
  git(root, ["branch", "-f", "baseline"]);
  for (const statement of [
    'export type { Input } from "./model";',
    'export type * from "./model";',
  ]) {
    replace(root, "src/index.ts", `${statement}\n`);
    await write(root);
    expect(run(root).join("\n")).toContain("Input: removed runtime export");
  }
});

test("removing a namespace type export is a breaking API change", async () => {
  const root = await fixture();
  replace(
    root,
    "src/index.ts",
    "export namespace Model { export type Input = string; export const value = 1; }\n",
  );
  await write(root);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "namespace baseline"]);
  git(root, ["branch", "-f", "baseline"]);
  replace(
    root,
    "src/index.ts",
    "export namespace Model { export const value = 1; }\n",
  );
  await write(root);
  expect(run(root).join("\n")).toContain("Model.Input: removed export");
});

test("unsupported JavaScript exports and unresolved declaration imports fail visibly", async () => {
  const root = await fixture();
  replace(root, "src/index.ts", 'export type { Missing } from "./missing";\n');
  expect(() => generateApiReport(path.join(root, "packages/fixture"))).toThrow(
    "Cannot classify exported symbol unknown",
  );
  replace(root, "src/index.js", "export const value = 1;\n");
  replace(
    root,
    "package.json",
    JSON.stringify({
      name: "@stll/fixture",
      exports: { ".": "./src/index.js" },
    }),
  );
  expect(() => generateApiReport(path.join(root, "packages/fixture"))).toThrow(
    "must target TypeScript declarations",
  );
});

test("wildcard asset entrypoints stay in the report and cannot lose a match", async () => {
  const root = await fixture();
  mkdirSync(path.join(root, "packages/fixture/capabilities"));
  replace(root, "capabilities/first.json", "{}\n");
  replace(root, "capabilities/second.json", "{}\n");
  replace(
    root,
    "package.json",
    JSON.stringify({
      name: "@stll/fixture",
      exports: { "./capabilities/*.json": "./capabilities/*.json" },
    }),
  );
  await write(root);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "asset baseline"]);
  git(root, ["branch", "-f", "baseline"]);
  const packageDir = path.join(root, "packages/fixture");
  expect(
    generateApiReport(packageDir).entrypoints["./capabilities/*.json"],
  ).toMatchObject({
    type: "asset",
    files: ["./capabilities/first.json", "./capabilities/second.json"],
  });
  rmSync(path.join(packageDir, "capabilities/first.json"));
  await write(root);
  expect(run(root).join("\n")).toContain(
    "removed asset ./capabilities/first.json",
  );
});

test("the check spawns nothing: it runs to its verdict under the offline preload", async () => {
  const root = await fixture();
  replace(root, "src/index.ts", 'export type { Input } from "./model";\n');
  await write(root);
  const base = baseDir(root);
  // The preload arms on `--check` and fails the process on any spawn attempt,
  // even a caught one; the exit code is read before the probe proves it armed.
  const script = `
    import { checkPackageApi } from ${JSON.stringify(path.join(import.meta.dir, "package-api-report"))};
    const errors = checkPackageApi({
      root: ${JSON.stringify(root)},
      baseDir: ${JSON.stringify(base)},
      packageDirs: ["packages/fixture"],
    });
    const exitCode = process.exitCode ?? 0;
    let denied = false;
    try { Bun.spawnSync(["true"]); } catch { denied = true; }
    console.log(JSON.stringify({ denied, errors, exitCode }));
    process.exitCode = 0;
  `;
  const result = Bun.spawnSync(
    [process.execPath, "--preload", PRELOAD, "--eval", script, "--", "--check"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const verdict: { denied: boolean; errors: string[]; exitCode: number } =
    JSON.parse(result.stdout.toString());
  expect(verdict.denied).toBe(true);
  expect(verdict.exitCode).toBe(0);
  expect(verdict.errors.join("\n")).toContain(".#convert: removed export");
});

const reorderKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(reorderKeys);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .toReversed()
      .map(([key, entry]) => [key, reorderKeys(entry)]),
  );
};

test("a committed report is compared as JSON: key order and layout never make it stale", async () => {
  const root = await fixture();
  const file = path.join(root, "packages/fixture/api-report.json");
  const committed: unknown = JSON.parse(readFileSync(file, "utf-8"));
  const reordered = JSON.stringify(reorderKeys(committed));
  expect(reordered).not.toBe(JSON.stringify(committed));
  writeFileSync(file, reordered);
  expect(run(root)).toEqual([]);
  replace(
    root,
    "src/index.ts",
    'export { convert } from "./model";\nexport type { Input } from "./model";\nexport const added = 1;\n',
  );
  expect(run(root).join("\n")).toContain(
    "stale packages/fixture/api-report.json",
  );
  writeFileSync(file, "{ not json");
  expect(run(root).join("\n")).toContain(
    "stale packages/fixture/api-report.json",
  );
});

test("a member removed from a nested result or parameter type is a breaking change", async () => {
  const root = await fixture();
  const packageDir = path.join(root, "packages/fixture");
  replace(
    root,
    "src/model.ts",
    "export type Input = string | number;\nexport const convert = (input: Input): string => String(input);\nexport interface Reader { read(): { marker: number; value?: string }; write(options: { marker: number; flush?: boolean }): void }\n",
  );
  const before = generateApiReport(packageDir);
  replace(
    root,
    "src/model.ts",
    "export type Input = string | number;\nexport const convert = (input: Input): string => String(input);\nexport interface Reader { read(): { marker: number }; write(options: { marker: number }): void }\n",
  );
  const after = generateApiReport(packageDir);
  const messages = breakingApiChanges({ before, after, packageDir }).map(
    ({ message }) => message,
  );
  expect(messages).toContain("./model#Reader.read(): removed member value");
  expect(messages).toContain(
    "./model#Reader.write(options): removed member flush",
  );
  replace(
    root,
    "src/model.ts",
    "export type Input = string | number;\nexport const convert = (input: Input | boolean): string => String(input);\nexport interface Reader { read(): { marker: number; value?: string; extra?: number }; write(options: { marker: number; flush?: boolean; sync?: boolean }): void }\n",
  );
  expect(
    breakingApiChanges({
      before,
      after: generateApiReport(packageDir),
      packageDir,
    }),
  ).toEqual([]);
});

test("a null export key or a more specific pattern takes subpaths from a wildcard", async () => {
  const root = await fixture();
  const packageDir = path.join(root, "packages/fixture");
  mkdirSync(path.join(packageDir, "src/features/private"), { recursive: true });
  replace(root, "src/features/public.ts", "export const open = 1;\n");
  replace(root, "src/features/internal.ts", "export const hidden = 1;\n");
  replace(root, "src/features/private/secret.ts", "export const secret = 1;\n");
  replace(
    root,
    "package.json",
    JSON.stringify({
      name: "@stll/fixture",
      exports: {
        "./features/*": "./src/features/*.ts",
        "./features/internal": null,
        "./features/private/*": null,
      },
    }),
  );
  expect(Object.keys(generateApiReport(packageDir).entrypoints)).toEqual([
    "./features/public",
  ]);
});

test("a base API that no longer type-checks needs a breaking release instead of failing the check", async () => {
  const root = await fixture();
  const packageDir = path.join(root, "packages/fixture");
  const after = generateApiReport(packageDir);
  const before = {
    ...after,
    declarations: {
      ...after.declarations,
      "./src/model.d.ts":
        'import type { Gone } from "missing-dependency";\nexport type Input = Gone;\nexport declare const convert: (input: Input) => string;\n',
    },
  };
  const breaks = breakingApiChanges({ before, after, packageDir });
  expect(breaks).toHaveLength(1);
  expect(breaks[0]).toMatchObject({ type: "signature", entrypoint: "." });
  expect(breaks[0]?.message).toContain("base API no longer type-checks");
  expect(() =>
    breakingApiChanges({ before: after, after: before, packageDir }),
  ).toThrow("missing-dependency");
});

const GENERIC_BASE = [
  "export type Input = string | number;",
  "export const convert = (input: Input): string => String(input);",
  "export interface Box<T extends object, D = string> { value: T; label?: D; map<U extends object>(next: (value: T) => U): Box<U, D> }",
  "export type Cents<C extends string> = { readonly currency: C; amount: number };",
  "export type Handlers<T> = { [K in keyof T]: (value: T[K]) => void };",
  "export class Store<S> { constructor(state: S); read(): S; protected write(state: S): void }",
  "export namespace shapes { export interface Node<T> { item: T; children: Node<T>[] } }",
].join("\n");

const genericBreaks = (root: string, model: string): string[] => {
  const packageDir = path.join(root, "packages/fixture");
  replace(root, "src/model.ts", `${GENERIC_BASE}\n`);
  const before = generateApiReport(packageDir);
  replace(root, "src/model.ts", `${model}\n`);
  return breakingApiChanges({
    before,
    after: generateApiReport(packageDir),
    packageDir,
  }).map(({ message }) => message);
};

test("an unchanged generic type is compatible with its own previous declaration", async () => {
  const root = await fixture();
  // A new export makes the reports differ, so every generic is compared.
  expect(
    genericBreaks(root, `${GENERIC_BASE}\nexport type Added<T> = T[];`),
  ).toEqual([]);
  // Renaming a type parameter or adding an optional member changes no contract.
  expect(
    genericBreaks(
      root,
      GENERIC_BASE.replace(
        "export type Cents<C extends string> = { readonly currency: C; amount: number };",
        "export type Cents<Code extends string> = { readonly currency: Code; amount: number; note?: string };",
      ),
    ),
  ).toEqual([]);
});

test.each([
  {
    change: "a removed optional member",
    from: "label?: D; ",
    to: "",
    expected: "./model#Box: removed member label",
  },
  {
    change: "a removed required member",
    from: "{ value: T; label?: D;",
    to: "{ label?: D;",
    expected: "./model#Box: incompatible type signature",
  },
  {
    change: "an added required member",
    from: "amount: number }",
    to: "amount: number; scale: number }",
    expected: "./model#Cents: incompatible type signature",
  },
  {
    change: "a narrowed member",
    from: "(value: T[K]) => void",
    to: "(value: T[K] & string) => void",
    expected: "./model#Handlers: incompatible type signature",
  },
  {
    change: "a changed type parameter count",
    from: "class Store<S> {",
    to: "class Store<S, E = never> {",
    expected: "./model#Store: changed type parameter count",
  },
  {
    change: "a narrowed constraint",
    from: "Cents<C extends string>",
    to: "Cents<C extends 'EUR' | 'CZK'>",
    expected: "./model#Cents: incompatible type signature",
  },
  {
    change: "a widened constraint",
    from: "Box<T extends object, D = string>",
    to: "Box<T, D = string>",
    expected: "./model#Box: incompatible type signature",
  },
  {
    change: "a changed class method",
    from: "read(): S;",
    to: "read(): S | undefined;",
    expected: "./model#Store: incompatible type signature",
  },
  {
    change: "a removed member of a namespaced generic",
    from: "item: T; children",
    to: "children",
    expected: "./model#shapes.Node: incompatible type signature",
  },
])(
  "a generic type with $change is a breaking change",
  async ({ from, to, expected }) => {
    const root = await fixture();
    expect(GENERIC_BASE).toContain(from);
    expect(
      genericBreaks(
        root,
        GENERIC_BASE.replace(from, () => to),
      ),
    ).toContain(expected);
  },
);

/**
 * A type expression whose unions and type literals list their members in two
 * orders.
 */
type DrawnType =
  | { type: "leaf"; text: string }
  | { type: "wrap"; wrap: (inner: string) => string; inner: DrawnType }
  | { type: "union"; drawn: DrawnType[]; shuffled: DrawnType[] }
  | { type: "object"; drawn: DrawnProperty[]; shuffled: DrawnProperty[] };
type DrawnProperty = { name: string; value: DrawnType };
type MemberOrder = "drawn" | "shuffled";

const LEAF_TYPES = ['"x"', '"y"', "1", "2", "null", "undefined", "string"];
const WRAPPERS = [
  (inner: string) => `(${inner})[]`,
  (inner: string) => `{ k: ${inner} }`,
  (inner: string) => `((value: ${inner}) => void)`,
  (inner: string) => `Promise<${inner}>`,
  (inner: string) => `readonly [${inner}, 1]`,
];

const PROPERTY_NAMES = ["a", "b", '"c-d"', "readonly e", "f?"];

const permutations = <T>(drawn: T[]) =>
  fc
    .shuffledSubarray(drawn, {
      minLength: drawn.length,
      maxLength: drawn.length,
    })
    .map((shuffled) => ({ drawn, shuffled }));

const { drawnType } = fc.letrec<{ drawnType: DrawnType }>((tie) => ({
  drawnType: fc.oneof(
    { depthSize: "small", withCrossShrink: true },
    fc
      .constantFrom(...LEAF_TYPES)
      .map((text): DrawnType => ({ type: "leaf", text })),
    fc
      .tuple(fc.constantFrom(...WRAPPERS), tie("drawnType"))
      .map(([wrap, inner]): DrawnType => ({ type: "wrap", wrap, inner })),
    fc
      .array(tie("drawnType"), { minLength: 2, maxLength: 4 })
      .chain(permutations)
      .map((orders): DrawnType => ({ type: "union", ...orders })),
    fc
      .uniqueArray(
        fc.record({
          name: fc.constantFrom(...PROPERTY_NAMES),
          value: tie("drawnType"),
        }),
        { minLength: 2, maxLength: 4, selector: ({ name }) => name },
      )
      .chain(permutations)
      .map((orders): DrawnType => ({ type: "object", ...orders })),
  ),
}));

const renderType = (drawn: DrawnType, order: MemberOrder): string => {
  switch (drawn.type) {
    case "leaf":
      return drawn.text;
    case "wrap":
      return drawn.wrap(renderType(drawn.inner, order));
    case "union":
      return drawn[order]
        .map((member) => `(${renderType(member, order)})`)
        .join(" | ");
    case "object":
      // The call signature and method overloads keep their place among the
      // properties around them.
      return `{ (call: 1): void; ${drawn[order]
        .map(({ name, value }) => `${name}: ${renderType(value, order)};`)
        .join(" m(): 1; ")} m(): 2; }`;
    default:
      drawn satisfies never;
      return panic("Unsupported drawn type");
  }
};

const declarationText = (drawn: DrawnType, order: MemberOrder): string =>
  `export declare const value: ${renderType(drawn, order)};\nexport type Alias = { field?: ${renderType(drawn, order)} };\n`;

// Names, keywords and literals, in sorted order: what a printed declaration
// says, whatever its layout, parentheses and member order.
const declarationTokens = (text: string): string[] => {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true);
  scanner.setText(text);
  const tokens: string[] = [];
  for (
    let kind = scanner.scan();
    kind !== ts.SyntaxKind.EndOfFileToken;
    kind = scanner.scan()
  ) {
    if (
      kind === ts.SyntaxKind.Identifier ||
      kind === ts.SyntaxKind.StringLiteral ||
      kind === ts.SyntaxKind.NumericLiteral ||
      (kind >= ts.SyntaxKind.FirstKeyword && kind <= ts.SyntaxKind.LastKeyword)
    ) {
      tokens.push(scanner.getTokenText());
    }
  }
  return tokens.toSorted(compareCodeUnit);
};

test("a printed declaration does not depend on the order of any union's members or any type literal's properties", () => {
  assertProperty(
    "package-api-report: union member and property order never reach a printed declaration",
    fc.property(drawnType, (drawn) => {
      const drawnText = declarationText(drawn, "drawn");
      const printed = printCanonicalDeclaration("api.d.ts", drawnText);
      expect(
        printCanonicalDeclaration(
          "api.d.ts",
          declarationText(drawn, "shuffled"),
        ),
      ).toBe(printed);
      // A fixed point, and nothing the declaration says is lost or added.
      expect(printCanonicalDeclaration("api.d.ts", printed)).toBe(printed);
      expect(declarationTokens(printed)).toEqual(declarationTokens(drawnText));
    }),
    { numRuns: 200 },
  );
});

// Literals the checker meets first get the lower type ids that TypeScript
// orders inferred unions and expanded mapped types by. The report checks and
// emits modules in path order, so `a-warm.ts` is met before `unions.ts`.
const WARM_LITERALS = ['"p"', '"q"', '"r"', "1", "2"];
const INFERRED_UNIONS = [
  'export const pick = (n: number) => (n === 0 ? "p" : n === 1 ? "q" : n === 2 ? "r" : n === 3 ? 1 : 2);',
  'export const box = (n: number) => ({ value: n === 0 ? "r" : n === 1 ? "p" : undefined });',
  'export const pair = (n: number) => [n === 0 ? "q" : "p", n === 1 ? 2 : 1] as const;',
  "const keyed = <K extends string>(keys: readonly K[]) => ({}) as { [P in K]: P };",
  'export const expanded = keyed(["r", "q", "p"]);',
].join("\n");

const inferredUnionsReport = (warmOrder: readonly string[]): string => {
  const root = mkdtempSync(path.join(tmpdir(), "package-api-order-"));
  roots.push(root);
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "@stll/fixture",
      exports: { "./a-warm": "./src/a-warm.ts", "./unions": "./src/unions.ts" },
    }),
  );
  writeFileSync(path.join(root, "src/unions.ts"), `${INFERRED_UNIONS}\n`);
  writeFileSync(
    path.join(root, "src/a-warm.ts"),
    `export const warm = [${warmOrder.join(", ")}] as const;\n`,
  );
  return (
    generateApiReport(root).declarations["./src/unions.d.ts"] ??
    panic("The report has no ./src/unions.d.ts entry")
  );
};

// timeout: each run type-checks two fixture programs; five runs take
// 10 to 25 seconds on a loaded CI runner.
test("one module's types never reorder another module's inferred unions or expanded properties", () => {
  const reference = inferredUnionsReport(WARM_LITERALS);
  assertProperty(
    "package-api-report: another module's type creation order never reorders a report entry",
    fc.property(
      fc.shuffledSubarray(WARM_LITERALS, {
        minLength: WARM_LITERALS.length,
        maxLength: WARM_LITERALS.length,
      }),
      (warmOrder) => {
        expect(inferredUnionsReport(warmOrder)).toBe(reference);
      },
    ),
    { numRuns: 5 },
  );
}, 90_000);

const CALL_ARITY_CASES = [
  {
    name: "an optional argument in a generic default",
    before:
      "export interface Reader<T = { read(key: string, format?: number): void }> { value: T }",
    after:
      "export interface Reader<T = { read(key: string): void }> { value: T }",
    consumer:
      'import type { Reader } from "./model"; declare const reader: Reader; reader.value.read("key", 1);',
  },
  {
    name: "a method argument in a class merged with a namespace",
    before:
      "export declare class Reader { read(key: string, format?: number): void } export declare namespace Reader { const version: string }",
    after:
      "export declare class Reader { read(key: string): void } export declare namespace Reader { const version: string }",
    consumer: 'import { Reader } from "./model"; new Reader().read("key", 1);',
  },
  {
    name: "an optional function argument",
    before:
      "export declare const read: (key: string, format?: number) => void;",
    after: "export declare const read: (key: string) => void;",
    consumer: 'import { read } from "./model"; read("key", 1);',
  },
  {
    name: "a defaulted function argument",
    before:
      "export const read = (key: string, count = 1) => key.repeat(count);",
    after: "export const read = (key: string) => key;",
    consumer: 'import { read } from "./model"; read("key", 2);',
  },
  {
    name: "an interface method argument",
    before:
      "export interface Reader { read(key: string, format?: number): void }",
    after: "export interface Reader { read(key: string): void }",
    consumer:
      'import type { Reader } from "./model"; declare const reader: Reader; reader.read("key", 1);',
  },
  {
    name: "a class method argument",
    before:
      "export declare class Reader { read(key: string, format?: number): void }",
    after: "export declare class Reader { read(key: string): void }",
    consumer: 'import { Reader } from "./model"; new Reader().read("key", 1);',
  },
  {
    name: "an optional constructor argument",
    before:
      "export declare class Reader { constructor(key: string, format?: number) }",
    after: "export declare class Reader { constructor(key: string) }",
    consumer: 'import { Reader } from "./model"; new Reader("key", 1);',
  },
  {
    name: "an optional construct-signature argument",
    before:
      "export interface ReaderFactory { new (key: string, format?: number): object }",
    after: "export interface ReaderFactory { new (key: string): object }",
    consumer:
      'import type { ReaderFactory } from "./model"; declare const Reader: ReaderFactory; new Reader("key", 1);',
  },
  {
    name: "an unbounded rest argument",
    before: "export declare const read: (...parts: string[]) => void;",
    after: "export declare const read: (first?: string) => void;",
    consumer: 'import { read } from "./model"; read("a", "b", "c");',
  },
  {
    name: "a bounded rest tuple argument",
    before:
      "export declare const read: (...args: [key: string, format?: number]) => void;",
    after: "export declare const read: (...args: [key: string]) => void;",
    consumer: 'import { read } from "./model"; read("key", 1);',
  },
  {
    name: "a constrained generic rest tuple argument",
    before:
      "export declare const read: <T extends [key: string, format?: number]>(...args: T) => void;",
    after:
      "export declare const read: <T extends [key: string]>(...args: T) => void;",
    consumer: 'import { read } from "./model"; read("key", 1);',
  },
  {
    name: "a rest tuple with a required tail",
    before:
      "export declare const read: (...args: [first: string, ...middle: string[], last: number]) => void;",
    after:
      "export declare const read: (...args: [first: string, last: number]) => void;",
    consumer: 'import { read } from "./model"; read("a", "b", 1);',
  },
  {
    name: "a discriminated overload despite an unchanged global maximum",
    before:
      'export declare function read(mode: "short"): void; export declare function read(mode: "long", count?: number): void;',
    after:
      'export declare function read(mode: "short", count?: number): void; export declare function read(mode: "long"): void;',
    consumer: 'import { read } from "./model"; read("long", 1);',
  },
  {
    name: "a discriminated constructor overload despite an unchanged global maximum",
    before:
      'export declare class Reader { constructor(mode: "short"); constructor(mode: "long", count?: number) }',
    after:
      'export declare class Reader { constructor(mode: "short", count?: number); constructor(mode: "long") }',
    consumer: 'import { Reader } from "./model"; new Reader("long", 1);',
  },
] as const;

const consumerDiagnostics = (root: string, consumer: string) => {
  const file = path.join(root, "packages/fixture/src/consumer.ts");
  writeFileSync(file, consumer);
  const program = ts.createProgram({
    rootNames: [file],
    options: {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      types: [],
    },
  });
  const source =
    program.getSourceFile(file) ?? panic("Missing API consumer fixture");
  return [
    ...program.getSyntacticDiagnostics(source),
    ...program.getSemanticDiagnostics(source),
  ].map((diagnostic) => ({
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  }));
};

const ARITY_MODEL_PREAMBLE =
  "export type Input = string | number; export const convert = (input: Input): string => String(input);\n";

test.each(CALL_ARITY_CASES)(
  "reports lost calls after removing $name",
  async ({ before, after, consumer }) => {
    const root = await fixture();
    const packageDir = path.join(root, "packages/fixture");
    replace(root, "src/model.ts", `${ARITY_MODEL_PREAMBLE}${before}\n`);
    expect(consumerDiagnostics(root, consumer)).toEqual([]);
    const previous = generateApiReport(packageDir);
    replace(root, "src/model.ts", `${ARITY_MODEL_PREAMBLE}${after}\n`);
    expect(consumerDiagnostics(root, consumer).length).toBeGreaterThan(0);
    const changes = breakingApiChanges({
      before: previous,
      after: generateApiReport(packageDir),
      packageDir,
    });
    expect(changes.length).toBeGreaterThan(0);
  },
);

const PRESERVED_CALL_CASES = [
  {
    name: "an added optional argument",
    before: "export declare const read: (key: string) => void;",
    after: "export declare const read: (key: string, format?: number) => void;",
    consumer: 'import { read } from "./model"; read("key");',
  },
  {
    name: "fixed arguments widened to an array rest",
    before: "export declare const read: (key: string) => void;",
    after: "export declare const read: (...parts: string[]) => void;",
    consumer: 'import { read } from "./model"; read("key");',
  },
  {
    name: "equivalent fixed and rest tuple arguments",
    before: "export declare const read: (key: string, count?: number) => void;",
    after:
      "export declare const read: (...args: [key: string, count?: number]) => void;",
    consumer: 'import { read } from "./model"; read("key"); read("key", 1);',
  },
  {
    name: "an added optional constructor argument",
    before: "export declare class Reader { constructor(key: string) }",
    after:
      "export declare class Reader { constructor(key: string, count?: number) }",
    consumer: 'import { Reader } from "./model"; new Reader("key");',
  },
  {
    name: "reordered discriminated overloads",
    before:
      'export declare function read(mode: "short"): void; export declare function read(mode: "long", count?: number): void;',
    after:
      'export declare function read(mode: "long", count?: number): void; export declare function read(mode: "short"): void;',
    consumer: 'import { read } from "./model"; read("short"); read("long", 1);',
  },
  {
    name: "reordered generic overloads with renamed parameters",
    before:
      'export declare function read(mode: "short"): void; export declare function read<T>(mode: "long", value: T, count?: number): void;',
    after:
      'export declare function read<U>(mode: "long", value: U, count?: number): void; export declare function read(mode: "short"): void;',
    consumer:
      'import { read } from "./model"; read("short"); read("long", { value: 1 }, 2);',
  },
  {
    name: "widened generic constraints on the matching overload",
    before:
      'export declare function read(mode: "short"): void; export declare function read<T extends "long">(mode: T, count?: number): void;',
    after:
      'export declare function read<U extends string>(mode: U, count?: number): void; export declare function read(mode: "short"): void;',
    consumer: 'import { read } from "./model"; read("short"); read("long", 1);',
  },
  {
    name: "reordered generic methods with private parameter types",
    before:
      'type Item<T> = { item: T }; export interface Reader<T extends object> { read(mode: "short"): void; read<U extends T>(mode: "long", value: Item<U>, count?: number): void }',
    after:
      'type Item<T> = { item: T }; export interface Reader<T extends object> { read<V extends T>(mode: "long", value: Item<V>, count?: number): void; read(mode: "short"): void }',
    consumer:
      'import type { Reader } from "./model"; declare const reader: Reader<{ id: number }>; reader.read("short"); reader.read("long", { item: { id: 1 } }, 2);',
  },
  {
    name: "reordered constructor overloads",
    before:
      'export declare class Reader { constructor(mode: "short"); constructor(mode: "long", count?: number) }',
    after:
      'export declare class Reader { constructor(mode: "long", count?: number); constructor(mode: "short") }',
    consumer:
      'import { Reader } from "./model"; new Reader("short"); new Reader("long", 1);',
  },
  {
    name: "reordered methods with a polymorphic receiver parameter",
    before:
      'export interface Reader { read(mode: "short"): void; read(mode: "long", peer: this, count?: number): void }',
    after:
      'export interface Reader { read(mode: "long", peer: this, count?: number): void; read(mode: "short"): void }',
    consumer:
      'import type { Reader } from "./model"; declare const reader: Reader; reader.read("short"); reader.read("long", reader, 1);',
  },
  {
    name: "an explicit receiver and a predicate",
    before:
      "export declare const read: (this: { prefix: string }, value: unknown) => value is string;",
    after:
      "export declare const read: (this: { prefix: string }, value: unknown, hint?: string) => value is string;",
    consumer:
      'import { read } from "./model"; read.call({ prefix: "a" }, "text");',
  },
  {
    name: "reordered receiver overloads with a predicate",
    before:
      'export declare function read(this: { prefix: string }, mode: "short"): boolean; export declare function read(this: { prefix: string }, mode: "long", value: unknown, count?: number): value is string;',
    after:
      'export declare function read(this: { prefix: string }, mode: "long", value: unknown, count?: number): value is string; export declare function read(this: { prefix: string }, mode: "short"): boolean;',
    consumer:
      'import { read } from "./model"; const reader = { prefix: "a", read }; let value: unknown; if (reader.read("long", value, 1)) { const text: string = value; }',
  },
  {
    name: "reordered overloads with parameter-bound typeof inputs",
    before:
      'export declare function read(mode: "short"): void; export declare function read(mode: "long", value: string, copy?: typeof value): void;',
    after:
      'export declare function read(mode: "long", value: string, copy?: typeof value): void; export declare function read(mode: "short"): void;',
    consumer:
      'import { read } from "./model"; read("short"); read("long", "value", "copy");',
  },
  {
    name: "a parameter-bound typeof result",
    before: "export declare const read: <T>(value: T) => typeof value;",
    after:
      "export declare const read: <T>(value: T, hint?: string) => typeof value;",
    consumer: 'import { read } from "./model"; const result: number = read(1);',
  },
] as const;

test.each(PRESERVED_CALL_CASES)(
  "preserves existing calls with $name",
  async ({ before, after, consumer }) => {
    const root = await fixture();
    const packageDir = path.join(root, "packages/fixture");
    replace(root, "src/model.ts", `${ARITY_MODEL_PREAMBLE}${before}\n`);
    expect(consumerDiagnostics(root, consumer)).toEqual([]);
    const previous = generateApiReport(packageDir);
    replace(root, "src/model.ts", `${ARITY_MODEL_PREAMBLE}${after}\n`);
    expect(consumerDiagnostics(root, consumer)).toEqual([]);
    expect(
      breakingApiChanges({
        before: previous,
        after: generateApiReport(packageDir),
        packageDir,
      }),
    ).toEqual([]);
  },
);

test("argument evidence preserves conditional types inspecting the original parameter tuple", async () => {
  const root = await fixture();
  const packageDir = path.join(root, "packages/fixture");
  const result =
    'export type Shape = Parameters<typeof read> extends [string] ? "one" : "many";';
  replace(
    root,
    "src/model.ts",
    `${ARITY_MODEL_PREAMBLE}export declare const read: (value: string) => void; ${result}`,
  );
  const before = generateApiReport(packageDir);
  replace(
    root,
    "src/model.ts",
    `${ARITY_MODEL_PREAMBLE}export declare const read: (value: string, extra?: number) => void; ${result}`,
  );
  const changes = breakingApiChanges({
    before,
    after: generateApiReport(packageDir),
    packageDir,
  });
  expect(changes.map(({ message }) => message)).toContain(
    "./model#Shape: incompatible type signature",
  );
});

test("removing an optional public argument requires a minor release before 1.0", async () => {
  const root = await fixture("0.6.6");
  replace(
    root,
    "src/model.ts",
    `${ARITY_MODEL_PREAMBLE}export declare const read: (key: string, count?: number) => void;`,
  );
  await write(root);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "optional argument baseline"]);
  git(root, ["branch", "-f", "baseline"]);
  replace(
    root,
    "src/model.ts",
    `${ARITY_MODEL_PREAMBLE}export declare const read: (key: string) => void;`,
  );
  await write(root);
  const changeset = path.join(root, ".changeset/argument-removal.md");
  writeFileSync(
    changeset,
    '---\n"@stll/fixture": patch\n---\nRemove the optional count argument.\n',
  );
  git(root, ["add", "."]);
  expect(run(root).join("\n")).toContain("removed accepted argument count");
  writeFileSync(
    changeset,
    '---\n"@stll/fixture": minor\n---\nRemove the optional count argument.\n',
  );
  expect(run(root)).toEqual([]);
});
