import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { formattedLikeRepository } from "./generated-artifacts";
import {
  breakingApiChanges,
  checkPackageApi,
  generateApiReport,
} from "./package-api-report";

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

const fixture = async (): Promise<string> => {
  const root = mkdtempSync(path.join(tmpdir(), "package-api-"));
  roots.push(root);
  mkdirSync(path.join(root, "packages/fixture/src"), { recursive: true });
  mkdirSync(path.join(root, ".changeset"));
  writeFileSync(
    path.join(root, "packages/fixture/package.json"),
    JSON.stringify({
      name: "@stll/fixture",
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

const run = (root: string) =>
  checkPackageApi({
    root,
    base: "baseline",
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
  expect((await run(root)).join("\n")).toContain(".#convert: removed export");
  expect((await run(root)).join("\n")).toContain(
    "consumers outside this repository",
  );
});

test("additions require regeneration and then pass without a major changeset", async () => {
  const root = await fixture();
  replace(
    root,
    "src/index.ts",
    'export { convert } from "./model";\nexport type { Input } from "./model";\nexport const added = 1;\n',
  );
  expect((await run(root)).join("\n")).toContain("bun run update:package-api");
  await write(root);
  expect(await run(root)).toEqual([]);
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
  expect((await run(root)).join("\n")).toContain("removed export");
  writeFileSync(
    path.join(root, ".changeset/current.md"),
    '---\n"@stll/other": major\n"@stll/fixture": minor\n---\nRelease.\n',
  );
  git(root, ["add", "."]);
  expect((await run(root)).join("\n")).toContain("removed export");
  writeFileSync(
    path.join(root, ".changeset/current.md"),
    '---\n"@stll/fixture": major\n---\nRemove old exports.\n',
  );
  expect(await run(root)).toEqual([]);
  replace(root, "src/index.ts", "export const extra = 1;\n");
  expect((await run(root)).join("\n")).toContain("stale");
});

test("narrowing a referenced parameter type fails, while widening a parameter passes", async () => {
  const root = await fixture();
  replace(
    root,
    "src/model.ts",
    "export type Input = string;\nexport const convert = (input: Input): string => input;\n",
  );
  await write(root);
  const errors = (await run(root)).join("\n");
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
  expect((await run(root)).join("\n")).toContain(
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
  expect((await run(root)).join("\n")).toContain("./model: removed entrypoint");
  expect((await run(root)).join("\n")).toContain(
    "./theme.css: removed entrypoint",
  );
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
    expect((await run(root)).join("\n")).toContain(
      "Input: removed runtime export",
    );
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
  expect((await run(root)).join("\n")).toContain("Model.Input: removed export");
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
  expect((await run(root)).join("\n")).toContain(
    "removed asset ./capabilities/first.json",
  );
});
