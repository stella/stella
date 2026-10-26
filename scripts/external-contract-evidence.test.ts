import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { hasChangedLocalRuntimeClosure } from "./check-external-contracts";
import {
  createLocalRuntimeClosureReader,
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

test("runtime resolution stays owned by the syntax-aware resolver", () => {
  const evidenceSource = readFileSync(
    path.join(import.meta.dir, "external-contract-evidence.ts"),
    "utf-8",
  );
  const checkSource = readFileSync(
    path.join(import.meta.dir, "check-external-contracts.ts"),
    "utf-8",
  );
  const directCalls =
    /(?:Bun\.resolveSync|ts\.resolveModuleName|require\.resolve)\s*\(/gu;

  expect(evidenceSource.match(directCalls)).toHaveLength(1);
  expect(checkSource.match(directCalls)).toBeNull();
  expect(evidenceSource).toContain("export const resolveRuntimeReference");
});

test("fixture evidence caches import and require export branches separately", () => {
  withProject({
    files: {
      "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
      "replay.ts": "",
      "packages/helper/package.json": JSON.stringify({
        name: "@stll/helper",
        exports: {
          ".": {
            import: "./src/import.ts",
            require: "./src/require.ts",
          },
        },
      }),
      "packages/helper/src/import.ts": 'export const target = "import";',
      "packages/helper/src/require.ts": 'export const target = "require";',
    },
    run: (root) => {
      const evidenceFor = (source: string) => {
        writeFileSync(path.join(root, "replay.ts"), source);
        return readFixtureEvidence({
          root,
          replayFiles: ["replay.ts"],
          sdkNames: [],
        });
      };
      const imported = evidenceFor('import "@stll/helper";');
      const required = evidenceFor('require("@stll/helper");');
      const both = evidenceFor(
        'import "@stll/helper"; require("@stll/helper");',
      );

      expect(imported.owners).toContain("packages/helper/src/import.ts");
      expect(imported.owners).not.toContain("packages/helper/src/require.ts");
      expect(required.owners).toContain("packages/helper/src/require.ts");
      expect(required.owners).not.toContain("packages/helper/src/import.ts");
      expect(both.problems).toEqual([]);
      expect(both.owners).toContain("packages/helper/src/import.ts");
      expect(both.owners).toContain("packages/helper/src/require.ts");
    },
  });
});

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
  ['import sdk from "@example/sdk";', "esm-import"],
  ['export { client } from "@example/sdk";', "esm-import"],
  ['import sdk = require("@example/sdk");', "import-equals-require"],
  ['const sdk = require("@example/sdk");', "require"],
  ["const sdk = require(`@example/sdk`);", "require"],
  ['const sdk = await import("@example/sdk");', "dynamic-import"],
  ["const sdk = await import(`@example/sdk`);", "dynamic-import"],
] as const)(
  "runtime module references retain literal syntax: %s",
  (text, syntax) => {
    expect(runtimeModuleReferences({ file: "client.ts", text })).toEqual([
      { type: "literal", specifier: "@example/sdk", syntax },
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
  },
);
test("non-literal runtime module references remain explicit unresolved evidence", () => {
  const text =
    'import(moduleName); require(moduleName); type Client = typeof import("@example/sdk");';
  expect(runtimeModuleReferences({ file: "client.ts", text })).toEqual([
    { type: "dynamic", syntax: "dynamic-import" },
    { type: "dynamic", syntax: "require" },
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

test.each([
  {
    syntax: "CommonJS require",
    owner: 'import sdk from "vendor"; require("@stll/helper"); sdk.send();',
    selected: "packages/helper/src/require.ts",
    ignored: "packages/helper/src/import.ts",
  },
  {
    syntax: "ESM import",
    owner: 'import sdk from "vendor"; import "@stll/helper"; sdk.send();',
    selected: "packages/helper/src/import.ts",
    ignored: "packages/helper/src/require.ts",
  },
] as const)(
  "$syntax resolves only its conditional export target",
  ({ owner, selected, ignored }) => {
    const sources = new Map([
      ["owner.ts", owner],
      [
        "packages/helper/package.json",
        JSON.stringify({
          name: "@stll/helper",
          exports: {
            ".": {
              import: "./src/import.ts",
              require: "./src/require.ts",
            },
          },
        }),
      ],
      ["packages/helper/src/import.ts", 'export const target = "import";'],
      ["packages/helper/src/require.ts", 'export const target = "require";'],
    ]);
    const reader = (target?: string) =>
      Object.assign(
        (file: string) =>
          file === target
            ? 'export const target = "changed";'
            : sources.get(file),
        {
          blobId: (file: string) =>
            sources.has(file)
              ? `fixture:${file}:${target ?? "baseline"}`
              : undefined,
        },
      );
    const baseline = reader();
    const changed = (target: string) => reader(target);
    const closure = createLocalRuntimeClosureReader({
      root: "/fixture",
      read: baseline,
    })(["owner.ts"]);
    const compare = (current: (file: string) => string | undefined) =>
      hasChangedLocalRuntimeClosure({
        root: "/fixture",
        owners: ["owner.ts"],
        sdks: ["vendor"],
        scope: "sdk-reachable",
        baseline,
        current,
      });

    expect(closure.problems).toEqual([]);
    expect(closure.files.has(selected)).toBe(true);
    expect(closure.files.has(ignored)).toBe(false);
    expect(compare(changed(selected))).toBe(true);
    expect(compare(changed(ignored))).toBe(false);
  },
);
