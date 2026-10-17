import { expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readFixtureEvidence,
  runtimeModuleReferences,
} from "./external-contract-evidence";

type ProjectOptions = {
  files: Record<string, string>;
  run: (root: string) => void;
};

const withProject = ({ files, run }: ProjectOptions) => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-import-evidence-"));
  try {
    for (const [file, text] of Object.entries(files)) {
      const target = path.join(root, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const sdkFiles = {
  "node_modules/@example/sdk/package.json": JSON.stringify({
    name: "@example/sdk",
    exports: "./runtime.js",
  }),
  "node_modules/@example/sdk/runtime.js": "export const client = 1;",
};

test.each(["installed", "symlinked", "workspace"])(
  "SDK claims require resolved membership in the %s package root",
  (layout) => {
    const packageRoot =
      layout === "workspace" ? "packages/sdk" : "node_modules/@example/sdk";
    withProject({
      files: {
        [`${packageRoot}/package.json`]: JSON.stringify({
          name: "@example/sdk",
          exports: "./runtime.js",
        }),
        [`${packageRoot}/runtime.js`]: "export const client = 1;",
        "local/shim.ts": "export const client = 1;",
        "aliased/tsconfig.json": JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@example/sdk": ["../local/shim.ts"] },
          },
        }),
        "aliased/replay.ts": 'import "@example/sdk";',
        "real/replay.ts": 'import "@example/sdk";',
      },
      run: (root) => {
        if (layout === "symlinked") {
          const installed = path.join(root, packageRoot);
          const store = path.join(root, "store/node_modules/@example/sdk");
          mkdirSync(store, { recursive: true });
          writeFileSync(
            path.join(store, "package.json"),
            JSON.stringify({ name: "@example/sdk", exports: "./runtime.js" }),
          );
          writeFileSync(
            path.join(store, "runtime.js"),
            "export const client = 1;",
          );
          rmSync(installed, { recursive: true });
          symlinkSync(store, installed, "dir");
        }
        const claims = { owners: [], sdks: ["@example/sdk"] };
        const aliased = readFixtureEvidence({
          root,
          replayFiles: ["aliased/replay.ts"],
          sdkNames: claims.sdks,
          claims,
        });
        expect(aliased.owners.has("local/shim.ts")).toBe(true);
        expect([...aliased.sdks]).toEqual([]);
        expect(aliased.problems).toEqual([
          "Cannot prove runtime reachability for claimed SDK @example/sdk",
        ]);
        const real = readFixtureEvidence({
          root,
          replayFiles: ["real/replay.ts"],
          sdkNames: claims.sdks,
          claims,
        });
        expect(real.problems).toEqual([]);
        expect([...real.sdks]).toEqual(["@example/sdk"]);
      },
    });
  },
);

test("runtime reachability follows every literal edge through aliases, workspace exports and external adapters", () => {
  withProject({
    files: {
      ...sdkFiles,
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
      "replay.ts":
        'import "@/direct"; export * from "./reexport"; import("./dynamic"); require("./required"); import legacy = require("./legacy");',
      "src/direct.ts": 'import "@stll/fixture";',
      "reexport.ts": 'export { client } from "@example/adapter";',
      "dynamic.ts": 'import "./transitive";',
      "required.ts": "export const required = 1;",
      "legacy.ts": "export const legacy = 1;",
      "transitive.ts": "export const transitive = 1;",
      "packages/fixture/package.json": JSON.stringify({
        name: "@stll/fixture",
        exports: "./src/runtime.ts",
      }),
      "packages/fixture/src/runtime.ts": "export const workspace = 1;",
      "node_modules/@example/adapter/package.json": JSON.stringify({
        name: "@example/adapter",
        exports: "./runtime.js",
      }),
      "node_modules/@example/adapter/runtime.js":
        'export { client } from "@example/sdk";',
      "unreachable.ts": 'import "@example/unreachable";',
    },
    run: (root) => {
      const evidence = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts"],
        sdkNames: ["@example/adapter", "@example/sdk", "@example/unreachable"],
      });
      expect(evidence.problems).toEqual([]);
      expect([...evidence.owners].toSorted()).toEqual([
        "dynamic.ts",
        "legacy.ts",
        "packages/fixture/src/runtime.ts",
        "reexport.ts",
        "replay.ts",
        "required.ts",
        "src/direct.ts",
        "transitive.ts",
      ]);
      expect([...evidence.sdks].toSorted()).toEqual([
        "@example/adapter",
        "@example/sdk",
      ]);
      expect(evidence.owners.has("unreachable.ts")).toBe(false);
      expect(evidence.owners.has("nonexistent.ts")).toBe(false);
    },
  });
});

test("type-only imports, exports, declarations and manifest dependencies cannot prove runtime claims", () => {
  withProject({
    files: {
      ...sdkFiles,
      "package.json": JSON.stringify({
        dependencies: { "@example/sdk": "1.0.0" },
      }),
      "replay.ts":
        'import type { Client } from "@example/sdk"; import { type Client as Other } from "@example/sdk"; export type { Client } from "@example/sdk"; export { type Client as Third } from "@example/sdk"; type Lazy = typeof import("@example/sdk"); import type Legacy = require("@example/sdk");',
      "types.d.ts": 'import "@example/sdk";',
    },
    run: (root) => {
      const evidence = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts", "types.d.ts"],
        sdkNames: ["@example/sdk"],
      });
      expect(evidence.problems).toEqual([]);
      expect([...evidence.owners]).toEqual(["replay.ts"]);
      expect([...evidence.sdks]).toEqual([]);
    },
  });
});

test("cycles terminate and mixed imports retain their runtime edges", () => {
  withProject({
    files: {
      ...sdkFiles,
      "replay.ts": 'import "./owner";',
      "owner.ts":
        'import "./replay"; import { type Client, client } from "@example/sdk";',
    },
    run: (root) => {
      const evidence = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts"],
        sdkNames: ["@example/sdk"],
      });
      expect(evidence.problems).toEqual([]);
      expect([...evidence.owners].toSorted()).toEqual([
        "owner.ts",
        "replay.ts",
      ]);
      expect([...evidence.sdks]).toEqual(["@example/sdk"]);
    },
  });
});

test("unresolved runtime imports and replay files produce explicit problems without SDK evidence", () => {
  withProject({
    files: { "replay.ts": 'import "./missing"; import "@example/missing";' },
    run: (root) => {
      const evidence = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts", "nonexistent.ts"],
        sdkNames: ["@example/missing"],
      });
      expect(evidence.problems).toHaveLength(3);
      expect(evidence.problems.join("\n")).toContain(
        "Cannot read replay/runtime source nonexistent.ts",
      );
      expect(evidence.problems.join("\n")).toContain(
        'Cannot resolve runtime import "./missing" from replay.ts',
      );
      expect([...evidence.sdks]).toEqual([]);
    },
  });
});

test("deep runtime graphs fail explicitly at their traversal bound", () => {
  const files: Record<string, string> = {};
  for (let index = 0; index < 70; index += 1) {
    files[`${index}.ts`] =
      index === 69 ? "export const end = 1;" : `import "./${index + 1}";`;
  }
  withProject({
    files,
    run: (root) => {
      const evidence = readFixtureEvidence({
        root,
        replayFiles: ["0.ts"],
        sdkNames: [],
      });
      expect(evidence.problems).toHaveLength(1);
      expect(evidence.problems.at(0)).toContain("exceeds depth bound 64");
      expect(evidence.owners.has("69.ts")).toBe(false);
    },
  });
});

test("positive claims use resolved paths despite unrelated missing runtime branches", () => {
  withProject({
    files: {
      ...sdkFiles,
      "replay.ts":
        'import "./missing"; import "./unrelated"; import "./owner";',
      "unrelated.ts": 'import "./also-missing";',
      "owner.ts": 'import "@example/sdk";',
    },
    run: (root) => {
      const claims = { owners: ["owner.ts"], sdks: ["@example/sdk"] };
      const evidence = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts"],
        sdkNames: ["@example/sdk"],
        claims,
      });
      expect(evidence.problems).toEqual([]);
      expect(evidence.owners.has("owner.ts")).toBe(true);
      expect(evidence.sdks.has("@example/sdk")).toBe(true);
      const incomplete = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts"],
        sdkNames: ["@example/sdk"],
        claims: { owners: ["unreachable.ts"], sdks: ["@example/sdk"] },
      });
      expect(incomplete.problems.join("\n")).toContain(
        'Cannot resolve runtime import "./missing"',
      );
      expect(incomplete.problems.join("\n")).toContain(
        "Cannot prove runtime reachability for claimed owner unreachable.ts",
      );
    },
  });
});

test("all replay roots must exist even when the claims already have positive paths", () => {
  withProject({
    files: {
      "replay.ts": 'import "./owner";',
      "owner.ts": "export const owner = 1;",
    },
    run: (root) => {
      const evidence = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts", "missing-root.ts"],
        sdkNames: [],
        claims: { owners: ["owner.ts"], sdks: [] },
      });
      expect(evidence.owners.has("owner.ts")).toBe(true);
      expect(evidence.problems).toEqual([
        "Cannot read replay/runtime source missing-root.ts",
      ]);
      const emptyClaims = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts", "other-missing.ts"],
        sdkNames: [],
        claims: { owners: [], sdks: [] },
      });
      expect(emptyClaims.problems).toEqual([
        "Cannot read replay/runtime source other-missing.ts",
      ]);
      expect([...emptyClaims.owners]).toEqual([]);
    },
  });
});

test("optional foreign packages with workspace-like names do not become local runtime claims", () => {
  withProject({
    files: {
      ...sdkFiles,
      "replay.ts": 'import "@example/sdk";',
      "node_modules/@example/sdk/runtime.js":
        'import "@stll/nonexistent-native-platform"; export const client = 1;',
    },
    run: (root) => {
      const evidence = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts"],
        sdkNames: ["@example/sdk"],
      });
      expect(evidence.problems).toEqual([]);
      expect([...evidence.sdks]).toEqual(["@example/sdk"]);
    },
  });
});

test.each([
  'import sdk from "@example/sdk";',
  'export { client } from "@example/sdk";',
  'import sdk = require("@example/sdk");',
  'const sdk = require("@example/sdk");',
  "const sdk = require(`@example/sdk`);",
  'const sdk = await import("@example/sdk");',
  "const sdk = await import(`@example/sdk`);",
])("runtime module references share literal syntax coverage: %s", (text) => {
  expect(runtimeModuleReferences({ file: "client.ts", text })).toEqual([
    { type: "literal", specifier: "@example/sdk" },
  ]);
  withProject({
    files: { ...sdkFiles, "replay.ts": text },
    run: (root) => {
      const evidence = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts"],
        sdkNames: ["@example/sdk"],
      });
      expect([...evidence.sdks]).toEqual(["@example/sdk"]);
      expect(evidence.problems).toEqual([]);
    },
  });
});
test("non-literal runtime module references remain explicit unresolved evidence", () => {
  const text =
    'import(moduleName); require(moduleName); type Client = typeof import("@example/sdk");';
  expect(runtimeModuleReferences({ file: "client.ts", text })).toEqual([
    { type: "dynamic" },
    { type: "dynamic" },
  ]);
  withProject({
    files: { "replay.ts": text },
    run: (root) => {
      const evidence = readFixtureEvidence({
        root,
        replayFiles: ["replay.ts"],
        sdkNames: ["@example/sdk"],
      });
      expect([...evidence.sdks]).toEqual([]);
      expect(evidence.problems).toEqual([
        "Cannot resolve non-literal runtime module reference from replay.ts",
        "Cannot resolve non-literal runtime module reference from replay.ts",
      ]);
    },
  });
});
