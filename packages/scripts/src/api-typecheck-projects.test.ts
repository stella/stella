import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  typecheckOwnershipIssues,
  validateApiTypecheckProjects,
} from "./api-typecheck-projects";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

test("every API TypeScript source has exactly one compiler project owner", () => {
  expect(validateApiTypecheckProjects(REPO_ROOT)).toEqual([]);
});

test("Bun consumers read referenced declarations instead of source", () => {
  const config = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "apps/api/tsconfig.tests.json"), "utf-8"),
  );
  const directory = realpathSync(
    mkdtempSync(path.join(tmpdir(), "api-typecheck-reference-")),
  );
  try {
    for (const name of ["src", "tests", "declarations"]) {
      mkdirSync(path.join(directory, name));
    }
    writeFileSync(
      path.join(directory, "src/value.ts"),
      'export const value = "source";\n',
    );
    writeFileSync(
      path.join(directory, "declarations/value.d.ts"),
      'export declare const value: "declaration";\n',
    );
    writeFileSync(
      path.join(directory, "tests/value.test.ts"),
      'import { value } from "../src/value";\nexport const result: "declaration" = value;\n',
    );
    writeFileSync(
      path.join(directory, "src/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          declaration: true,
          rootDir: ".",
          outDir: "../declarations",
          types: [],
        },
        files: ["value.ts"],
      }),
    );
    writeFileSync(
      path.join(directory, "tests/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          disableSourceOfProjectReferenceRedirect:
            config.compilerOptions.disableSourceOfProjectReferenceRedirect,
          types: [],
        },
        references: [{ path: "../src" }],
        files: ["value.test.ts"],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [
        "check",
        "--no-pretty",
        "--listFilesOnly",
        "--project=tests/tsconfig.json",
      ],
      { cwd: directory, encoding: "utf-8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const files = result.stdout.split("\n");
    expect(files).toContain(path.join(directory, "declarations/value.d.ts"));
    expect(files).not.toContain(path.join(directory, "src/value.ts"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing and overlapping project roots fail ownership validation", () => {
  const sources = ["src/a.ts", "src/a.test.ts", "scripts/new.ts"];
  const projects = [
    { project: "src", files: ["src/a.ts"] },
    { project: "tests", files: ["src/a.test.ts"] },
  ];
  expect(
    typecheckOwnershipIssues(sources, projects).map(({ path: file }) => file),
  ).toEqual(["scripts/new.ts"]);
  expect(
    typecheckOwnershipIssues(sources.slice(0, 2), [
      ...projects,
      { project: "extra", files: ["src/a.test.ts"] },
    ]).map(({ path: file }) => file),
  ).toEqual(["src/a.test.ts"]);
});

test("the API declaration command emits through the native compiler CLI", () => {
  const api = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "apps/api/package.json"), "utf-8"),
  );
  const [, wrapper, ...args] = api.scripts["typecheck:declarations"].split(" ");
  const directory = mkdtempSync(
    path.join(tmpdir(), "api-native-declarations-"),
  );
  try {
    writeFileSync(
      path.join(directory, "value.ts"),
      "export type Value = string;\n",
    );
    writeFileSync(
      path.join(directory, "tsconfig.declarations.json"),
      JSON.stringify({
        compilerOptions: {
          noCheck: true,
          declaration: true,
          emitDeclarationOnly: true,
          outDir: "declarations",
          types: [],
        },
        files: ["value.ts"],
      }),
    );
    const result = spawnSync(
      process.execPath,
      [path.resolve(REPO_ROOT, "apps/api", wrapper), ...args],
      { cwd: directory, encoding: "utf-8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(
      readFileSync(path.join(directory, "declarations/value.d.ts"), "utf-8"),
    ).toContain("export type Value = string;");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
