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

import { apiResolvedTypecheckInputs } from "./api-typecheck-inputs";
import {
  apiTestPartitionIssues,
  apiTypecheckInputIssues,
  deriveApiTestPartition,
} from "./api-typecheck-partition";

test("API test ownership follows transitive imports and fails when its derived partition drifts", () => {
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
    for (const name of ["scripts", "contracts", "mcp-apps", "visual-sandbox"]) {
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
            "mcp-apps",
            "visual-sandbox",
          ].map((name) => [
            `typecheck:${name}`,
            `bun check --project=tsconfig.${name}.json`,
          ]),
        ),
      }),
    );
    const tasks = Object.fromEntries(
      [
        "src",
        "tests",
        "declarations",
        "scripts",
        "contracts",
        "mcp-apps",
        "visual-sandbox",
      ].map((name) => [
        `@stll/api#typecheck:${name}`,
        {
          inputs: apiResolvedTypecheckInputs(
            path.join(root, `apps/api/tsconfig.${name}.json`),
          ),
        },
      ]),
    );
    const writeTasks = () => write("turbo.json", JSON.stringify({ tasks }));
    writeTasks();
    expect(deriveApiTestPartition(root)).toEqual({
      independent: ["src/alpha.test.ts"],
      coupled: ["src/beta.test.ts", "src/dynamic.test.ts", "src/gamma.test.ts"],
    });
    expect(apiTestPartitionIssues(root)).toEqual([]);
    expect(apiTypecheckInputIssues(root)).toEqual([]);
    const original = tasks["@stll/api#typecheck:src"];
    if (!original) {
      panic("Missing source inputs");
    }
    const saved = original.inputs;
    original.inputs = [...saved, "!src/**/*.test.ts"];
    writeTasks();
    expect(
      apiTypecheckInputIssues(root).map(({ message }) => message),
    ).toContain(
      "@stll/api#typecheck:src cache inputs must match the native resolved program; regenerate API test partition",
    );
    original.inputs = saved;
    writeTasks();
    write(
      "apps/api/src/hidden.ts",
      "import './alpha.test';\nexport type Value = number;\n",
    );
    expect(deriveApiTestPartition(root).independent).toEqual([]);
    expect(
      apiTestPartitionIssues(root).map(({ path: filename }) => filename),
    ).toContain("src/alpha.test.ts");
    write("apps/api/src/hidden.ts", "export type Value = number;\n");
    // A transitive package dependency moves the test across the boundary,
    // without changing either the test itself or either project config.
    write(
      "packages/shared/src/bridge.ts",
      "export type { Value } from '../../../apps/api/src/hidden';\n",
    );
    expect(deriveApiTestPartition(root).independent).toEqual([]);
    expect(
      apiTestPartitionIssues(root).map(({ path: filename }) => filename),
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
    expect(deriveApiTestPartition(root).independent).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
