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
  missingPreparedApiTypecheckConfigs,
  typecheckOwnershipIssues,
  validateApiTypecheckProjects,
} from "./api-typecheck-projects";
import { CI_GENERATED_OUTPUTS } from "./generated-files";

const REPO_ROOT = path.resolve(import.meta.dir, "../../..");

test("every API TypeScript source has exactly one compiler project owner", async () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "api-ownership-")));
  const api = path.join(root, "apps/api");
  const write = (file: string, contents: unknown) => {
    const destination = path.join(api, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  };
  try {
    write("package.json", {
      scripts: {
        "typecheck:src": "bun check --project=tsconfig.src.json",
        "typecheck:tests": "bun check --project=tsconfig.tests.json",
      },
    });
    write("tsconfig.json", {
      compilerOptions: {
        types: [],
        moduleResolution: "Bundler",
        module: "ESNext",
      },
      include: ["src"],
    });
    write("tsconfig.declarations.json", {
      extends: "./tsconfig.json",
      files: ["src/value.ts"],
      include: [],
    });
    write("tsconfig.src.json", {
      extends: "./tsconfig.json",
      exclude: ["src/value.test.ts"],
    });
    write("tsconfig.tests.json", {
      extends: "./tsconfig.json",
      files: ["src/value.test.ts"],
      include: [],
    });
    write("src/value.ts", "export type Value = string;\n");
    write(
      "src/value.test.ts",
      "import type { Value } from './value'; export type Test = Value;\n",
    );
    write("src/routes.ts", "export const route = 1;\n");
    write(
      "src/routes.test.ts",
      "import { route } from './routes'; export const checked = route;\n",
    );
    expect(await validateApiTypecheckProjects(root)).toEqual([]);
    write("src/new.ts", "export const value = 1;\n");
    expect(await validateApiTypecheckProjects(root)).toEqual([]);
    write("tsconfig.src.json", { extends: "./tsconfig.json", exclude: [] });
    expect(
      (await validateApiTypecheckProjects(root)).some(({ message }) =>
        message.includes("found 2"),
      ),
    ).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unprepared generated API configs skip ownership at install and fail when required", async () => {
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "api-unprepared-")),
  );
  const api = path.join(root, "apps/api");
  const write = (file: string, contents: unknown) => {
    const destination = path.join(api, file);
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  };
  try {
    write("package.json", {
      scripts: {
        "typecheck:src": "bun check --project=tsconfig.src.json",
        "typecheck:tests": "bun check --project=tsconfig.tests.json",
      },
    });
    write("tsconfig.json", { compilerOptions: { types: [] }, include: [] });
    for (const name of ["declarations", "src", "tests"]) {
      const generated = name === "declarations" ? "roots" : name;
      write(`tsconfig.${name}.json`, {
        extends: [
          "./tsconfig.json",
          `./.cache/typecheck-declarations/${generated}.json`,
        ],
      });
    }
    write("src/value.ts", "export const value = 1;\n");

    expect(missingPreparedApiTypecheckConfigs(root)).toEqual([
      "apps/api/.cache/typecheck-declarations/roots.json",
      "apps/api/.cache/typecheck-declarations/src.json",
      "apps/api/.cache/typecheck-declarations/tests.json",
    ]);
    expect(await validateApiTypecheckProjects(root)).toEqual([]);
    expect(
      await validateApiTypecheckProjects(root, { requirePrepared: true }),
    ).toEqual([
      {
        path: "apps/api/.cache/typecheck-declarations",
        message: expect.stringContaining(
          "prepared API typecheck configs are missing",
        ),
      },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
      { maxBuffer: 2 ** 30, cwd: directory, encoding: "utf-8" },
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

test("the API declaration command emits its public surface", () => {
  const api = JSON.parse(
    readFileSync(path.join(REPO_ROOT, "apps/api/package.json"), "utf-8"),
  );
  const [, wrapper, ...args] =
    api.scripts["generate:typecheck-declarations"].split(" ");
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "api-native-declarations-")),
  );
  const directory = path.join(root, "apps/api");
  try {
    mkdirSync(path.join(directory, "src"), { recursive: true });
    writeFileSync(
      path.join(directory, "src/value.ts"),
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
          rootDir: ".",
          types: [],
        },
        files: ["src/value.ts"],
        include: [],
      }),
    );
    for (const file of [
      ...CI_GENERATED_OUTPUTS.capabilityRuntime,
      ...CI_GENERATED_OUTPUTS.cliRuntime,
    ]) {
      const output = path.join(root, file);
      mkdirSync(path.dirname(output), { recursive: true });
      writeFileSync(output, "export {};\n");
    }
    const result = spawnSync(
      process.execPath,
      [path.resolve(REPO_ROOT, "apps/api", wrapper), ...args],
      { maxBuffer: 2 ** 30, cwd: directory, encoding: "utf-8" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(
      readFileSync(
        path.join(directory, "declarations/src/value.d.ts"),
        "utf-8",
      ),
    ).toContain("export type Value = string;");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
