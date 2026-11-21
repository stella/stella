import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  apiResolvedTypecheckInputs,
  missingApiTypecheckGeneratedSources,
  requireApiTypecheckGeneratedSources,
} from "./api-typecheck-inputs";
import {
  apiTestPartitionIssues,
  apiTypecheckInputIssues,
  deriveApiTestPartition,
} from "./api-typecheck-partition";
import { childExitStatus } from "./child-exit-status";
import { CI_GENERATED_OUTPUTS } from "./generated-files";

test("API test ownership follows transitive imports and fails when its derived partition drifts", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "api-test-partition-"));
  const write = (filename: string, contents: string) => {
    const target = path.join(root, filename);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  try {
    write(
      "apps/api/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          preserveSymlinks: true,
          types: [],
        },
        include: ["src"],
      }),
    );
    write(
      "apps/api/tsconfig.declarations.json",
      JSON.stringify({ files: ["src/safe.ts"] }),
    );
    write(
      "apps/api/tsconfig.src.json",
      JSON.stringify({ exclude: ["src/alpha.test.ts"] }),
    );
    write(
      "apps/api/tsconfig.tests.json",
      JSON.stringify({ files: ["src/alpha.test.ts"] }),
    );
    write("apps/api/src/safe.ts", "export type Value = string;\n");
    write("apps/api/src/hidden.ts", "export type Value = number;\n");
    write(
      "apps/api/src/alpha.test.ts",
      "import type { Value } from '../../../packages/shared/src/bridge';\n",
    );
    write(
      "packages/shared/src/bridge.ts",
      "export type { Value } from '../../../apps/api/src/safe';\n",
    );
    write("apps/api/src/beta.test.ts", "import './gamma.test';\n");
    write(
      "apps/api/src/gamma.test.ts",
      "import './beta.test';\nimport type { Value } from './hidden';\n",
    );
    write(
      "apps/api/src/dynamic.test.ts",
      "const modulePath = './safe';\nvoid import(modulePath);\n",
    );
    write(
      "apps/api/tsconfig.src.json",
      JSON.stringify({
        extends: "./tsconfig.json",
        exclude: ["src/alpha.test.ts"],
      }),
    );
    for (const name of ["scripts", "contracts", "visual-sandbox"]) {
      write(
        `apps/api/tsconfig.${name}.json`,
        JSON.stringify({
          compilerOptions: { types: [] },
          files: ["src/safe.ts"],
        }),
      );
    }
    write(
      "apps/api/package.json",
      JSON.stringify({
        scripts: Object.fromEntries(
          [
            "src",
            "tests",
            "declarations",
            "scripts",
            "contracts",
            "visual-sandbox",
          ].map((name) => [
            `typecheck:${name}`,
            `bun check --project=tsconfig.${name}.json`,
          ]),
        ),
      }),
    );
    const tasks = Object.fromEntries(
      await Promise.all(
        [
          "src",
          "tests",
          "declarations",
          "scripts",
          "contracts",
          "visual-sandbox",
        ].map(async (name) => [
          `@stll/api#typecheck:${name}`,
          {
            inputs: await apiResolvedTypecheckInputs(
              path.join(root, `apps/api/tsconfig.${name}.json`),
            ),
          },
        ]),
      ),
    );
    const writeTasks = () => write("turbo.json", JSON.stringify({ tasks }));
    writeTasks();
    expect(await deriveApiTestPartition(root)).toEqual({
      independent: ["src/alpha.test.ts"],
      coupled: ["src/beta.test.ts", "src/dynamic.test.ts", "src/gamma.test.ts"],
    });
    expect(await apiTestPartitionIssues(root)).toEqual([]);
    expect(await apiTypecheckInputIssues(root)).toEqual([]);
    const original = tasks["@stll/api#typecheck:src"];
    if (!original) {
      panic("Missing source inputs");
    }
    const saved = original.inputs;
    original.inputs = [...saved, "!src/**/*.test.ts"];
    writeTasks();
    expect(
      (await apiTypecheckInputIssues(root)).map(({ message }) => message),
    ).toContain(
      "@stll/api#typecheck:src cache inputs must cover the native resolved program and workspace discovery; regenerate API test partition",
    );
    original.inputs = saved;
    writeTasks();
    write(
      "apps/api/src/hidden.ts",
      "import './alpha.test';\nexport type Value = number;\n",
    );
    expect((await deriveApiTestPartition(root)).independent).toEqual([]);
    expect(
      (await apiTestPartitionIssues(root)).map(
        ({ path: filename }) => filename,
      ),
    ).toContain("src/alpha.test.ts");
    write("apps/api/src/hidden.ts", "export type Value = number;\n");
    // A transitive package dependency moves the test across the boundary,
    // without changing either the test itself or either project config.
    write(
      "packages/shared/src/bridge.ts",
      "export type { Value } from '../../../apps/api/src/hidden';\n",
    );
    expect((await deriveApiTestPartition(root)).independent).toEqual([]);
    expect(
      (await apiTestPartitionIssues(root)).map(
        ({ path: filename }) => filename,
      ),
    ).toContain("src/alpha.test.ts");
    write(
      "packages/shared/package.json",
      JSON.stringify({ name: "@stll/shared", types: "src/bridge.ts" }),
    );
    mkdirSync(path.join(root, "apps/api/node_modules/@stll"), {
      recursive: true,
    });
    symlinkSync(
      path.join(root, "packages/shared"),
      path.join(root, "apps/api/node_modules/@stll/shared"),
      "dir",
    );
    write(
      "apps/api/src/alpha.test.ts",
      "import type { Value } from '@stll/shared';\n",
    );
    expect((await deriveApiTestPartition(root)).independent).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native input capture requires every canonical runtime generated source", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "api-generated-inputs-"));
  const outputs = [
    ...CI_GENERATED_OUTPUTS.capabilityRuntime,
    ...CI_GENERATED_OUTPUTS.cliRuntime,
  ];
  try {
    expect(missingApiTypecheckGeneratedSources(root)).toEqual(outputs);
    const project = path.join(root, "apps/api/tsconfig.declarations.json");
    mkdirSync(path.join(root, "apps/api/src"), { recursive: true });
    writeFileSync(
      path.join(root, "apps/api/src/value.ts"),
      "export const value = 1;\n",
    );
    writeFileSync(
      project,
      JSON.stringify({
        files: ["src/value.ts"],
        include: [],
        compilerOptions: {
          noEmit: false,
          noCheck: true,
          declaration: true,
          emitDeclarationOnly: true,
          composite: true,
          rootDir: ".",
          outDir: ".cache/declarations",
          module: "Preserve",
          moduleResolution: "Bundler",
          types: [],
        },
      }),
    );
    const cli = Bun.spawnSync(
      [
        process.execPath,
        path.join(import.meta.dirname, "api-typecheck-declarations.ts"),
        project,
        "--write-surface",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    expect(childExitStatus(cli)).not.toBe(0);
    expect(cli.stderr.toString()).toContain(
      "Prepare API and CLI generated sources before native typecheck input capture",
    );
    expect(() => requireApiTypecheckGeneratedSources(root)).toThrow(
      "Prepare API and CLI generated sources before native typecheck input capture",
    );
    for (const file of outputs) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "export {};\n");
    }
    expect(missingApiTypecheckGeneratedSources(root)).toEqual([]);
    for (const file of outputs) {
      const target = path.join(root, file);
      rmSync(target);
      expect(missingApiTypecheckGeneratedSources(root)).toEqual([file]);
      expect(() => requireApiTypecheckGeneratedSources(root)).toThrow(file);
      writeFileSync(target, "export {};\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
