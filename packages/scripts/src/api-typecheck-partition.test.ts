import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  apiTestPartitionIssues,
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
    expect(deriveApiTestPartition(root)).toEqual({
      independent: ["src/alpha.test.ts"],
      coupled: ["src/beta.test.ts", "src/dynamic.test.ts", "src/gamma.test.ts"],
    });
    expect(apiTestPartitionIssues(root)).toEqual([]);
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
