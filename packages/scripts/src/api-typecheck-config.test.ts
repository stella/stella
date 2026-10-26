import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript6";

import { childExitStatus } from "./child-exit-status";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const API_ROOT = path.join(REPO_ROOT, "apps/api");
const COMPILER_CLI = path.join(REPO_ROOT, "node_modules/tsrs/bin/tsrs");
const GENERATED_PREFIX = "./.cache/typecheck-declarations/";
const FIX_COMMAND = "bun --filter @stll/api generate:typecheck-declarations";

const generatedApiProjects = () =>
  [...new Bun.Glob("tsconfig*.json").scanSync({ cwd: API_ROOT })]
    .map((name) => {
      const config = ts.readConfigFile(path.join(API_ROOT, name), (file) =>
        ts.sys.readFile(file),
      ).config;
      const extended: readonly string[] = Array.isArray(config.extends)
        ? config.extends.filter(
            (value: unknown): value is string => typeof value === "string",
          )
        : [];
      const generated = extended.find((value) =>
        value.startsWith(GENERATED_PREFIX),
      );
      if (generated === undefined) {
        return undefined;
      }
      const required = extended.at(extended.indexOf(generated) - 1);
      if (required === undefined) {
        throw new Error(
          `${name} extends ${generated} without a guard before it`,
        );
      }
      const guard = ts.readConfigFile(
        path.resolve(API_ROOT, required),
        (file) => ts.sys.readFile(file),
      ).config;
      return { name, generated, required, files: guard.files };
    })
    .filter((project) => project !== undefined)
    .toSorted((left, right) => left.name.localeCompare(right.name));

const compilers = [
  {
    name: "Bun",
    command: (project: string, listFiles = false) => [
      process.execPath,
      "check",
      "--no-pretty",
      ...(listFiles ? ["--listFilesOnly"] : []),
      `--project=${project}`,
    ],
  },
  {
    name: "tsrs",
    command: (project: string, listFiles = false) => [
      process.execPath,
      COMPILER_CLI,
      "--pretty",
      "false",
      ...(listFiles ? ["--listFilesOnly"] : []),
      "--project",
      project,
    ],
  },
];

test("generated API projects fail closed and source roots exclude tests", () => {
  const projects = generatedApiProjects();
  expect(projects.map(({ name }) => name)).toEqual([
    "tsconfig.declarations.json",
    "tsconfig.src.json",
    "tsconfig.tests.json",
  ]);

  const root = mkdtempSync(path.join(tmpdir(), "api-typecheck-config-"));
  try {
    writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          types: [],
        },
        include: ["src"],
      }),
    );
    mkdirSync(path.join(root, "src"));
    writeFileSync(path.join(root, "src/value.ts"), "export const value = 1;\n");
    writeFileSync(
      path.join(root, "src/value.test.ts"),
      "export const testValue = 1;\n",
    );

    for (const { name, generated, required, files } of projects) {
      expect(files).toEqual([
        expect.stringContaining(`${generated.slice(2)} is missing;`),
      ]);
      expect(files[0]).toContain(FIX_COMMAND);
      const guard = path.join(root, required);
      mkdirSync(path.dirname(guard), { recursive: true });
      writeFileSync(guard, JSON.stringify({ files, include: [] }));
      writeFileSync(
        path.join(root, name),
        JSON.stringify({
          extends: ["./tsconfig.json", required, generated],
        }),
      );
      for (const compiler of compilers) {
        const result = Bun.spawnSync(compiler.command(name), {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = `${result.stdout.toString()}${result.stderr.toString()}`;
        expect(childExitStatus(result), `${compiler.name}: ${output}`).not.toBe(
          0,
        );
        expect(output).toContain(generated.slice(2));
        expect(output).toContain(FIX_COMMAND);
      }
    }

    const generated = path.join(root, ".cache/typecheck-declarations");
    mkdirSync(generated, { recursive: true });
    writeFileSync(
      path.join(generated, "src.json"),
      JSON.stringify({ files: [], include: ["../../src/value.ts"] }),
    );
    for (const compiler of compilers) {
      const result = Bun.spawnSync(
        compiler.command("tsconfig.src.json", true),
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const output = `${result.stdout.toString()}${result.stderr.toString()}`;
      expect(childExitStatus(result), `${compiler.name}: ${output}`).toBe(0);
      expect(output).toContain(path.join(root, "src/value.ts"));
      expect(output).not.toContain(path.join(root, "src/value.test.ts"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
