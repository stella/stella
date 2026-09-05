import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseArgs, scaffoldPackage } from "./new-package";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

const KNIP_FIXTURE = `{
  "workspaces": {
    ".": {
      "entry": ["scripts/*.ts"]
    },
    "apps/api": {
      "entry": ["src/server.ts!"]
    },
    "packages/alpha": {
      "entry": ["src/index.ts"]
    },
    // A comment JSON.parse/stringify would drop.
    "packages/zulu": {
      "entry": ["src/index.ts"]
    }
  },
  "ignoreWorkspaces": ["packages/typescript-config"]
}
`;

// The last `packages/*` key is not the last workspace: appending after it must
// keep the comma its closing brace carries.
const KNIP_TRAILING_FIXTURE = `{
  "workspaces": {
    "packages/alpha": {
      "entry": ["src/index.ts"]
    },
    "packages/zulu": {
      "entry": ["src/index.ts"]
    },
    "apps/web": {
      "entry": ["src/client.tsx"]
    }
  }
}
`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createRoot = (knip = KNIP_FIXTURE): string => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-new-package-"));
  roots.push(root);
  writeFileSync(path.join(root, "knip.json"), knip);
  return root;
};

const read = (root: string, rel: string): string =>
  readFileSync(path.join(root, rel), "utf-8");

test("scaffolds the package files and registers the knip workspace", () => {
  const root = createRoot();

  const result = scaffoldPackage({
    name: "matter-dates",
    description: "matter date arithmetic shared by the API and the web client",
    root,
  });

  expect(result).toEqual({
    status: "created",
    files: [
      "packages/matter-dates/package.json",
      "packages/matter-dates/tsconfig.json",
      "packages/matter-dates/src/index.ts",
      "packages/matter-dates/README.md",
      "knip.json",
    ],
  });

  const manifest: unknown = JSON.parse(
    read(root, "packages/matter-dates/package.json"),
  );
  expect(manifest).toMatchObject({
    name: "@stll/matter-dates",
    version: "0.0.0",
    private: true,
    description: "matter date arithmetic shared by the API and the web client",
    exports: { ".": "./src/index.ts" },
    scripts: {
      test: "bun test src",
      typecheck: "bun ../../packages/scripts/src/tsc-native.ts --noEmit",
      format: "bun ../../scripts/run-oxfmt.ts .",
    },
    devDependencies: {
      "@stll/typescript-config": "workspace:*",
      "bun-types": "catalog:",
    },
  });

  expect(read(root, "packages/matter-dates/src/index.ts")).toContain(
    "export {};",
  );
  expect(read(root, "packages/matter-dates/README.md")).toContain(
    "## What lives here",
  );
  expect(read(root, "packages/matter-dates/tsconfig.json")).toContain(
    "@stll/typescript-config/base.json",
  );

  const knip = read(root, "knip.json");
  expect(knip).toContain("// A comment JSON.parse/stringify would drop.");
  expect(knip.indexOf('"packages/alpha"')).toBeLessThan(
    knip.indexOf('"packages/matter-dates"'),
  );
  expect(knip.indexOf('"packages/matter-dates"')).toBeLessThan(
    knip.indexOf('"packages/zulu"'),
  );
  expect(knip).toContain(
    '      "entry": ["src/index.ts", "src/**/*.test.ts"]\n',
  );
  expect(JSON.parse(knip.replaceAll(/^\s*\/\/.*$/gmu, ""))).toMatchObject({
    workspaces: {
      "packages/matter-dates": {
        entry: ["src/index.ts", "src/**/*.test.ts"],
      },
    },
  });
});

// The scaffold's own output is the fixture, and oxfmt is the oracle: no
// hand-written expectation can drift away from what the formatter does.
test("scaffolded files need no formatting pass", () => {
  const root = createRoot();
  const result = scaffoldPackage({
    name: "matter-dates",
    description: "matter date arithmetic shared by the API and the web client",
    root,
  });
  if (result.status !== "created") {
    throw new Error(`scaffold rejected: ${result.message}`);
  }

  const scaffolded = result.files.filter((rel) => rel !== "knip.json");
  const before = scaffolded.map((rel) => read(root, rel));

  const formatter = Bun.spawnSync(
    [
      process.execPath,
      "--bun",
      "oxfmt",
      "-c",
      path.join(REPO_ROOT, ".oxfmtrc.json"),
      ...scaffolded.map((rel) => path.join(root, rel)),
    ],
    { cwd: REPO_ROOT, stderr: "pipe", stdout: "pipe" },
  );
  expect(formatter.stderr.toString()).toBe("");
  expect(formatter.exitCode).toBe(0);

  expect(scaffolded.map((rel) => read(root, rel))).toEqual(before);
});

test("appends after the last packages entry when the name sorts last", () => {
  const root = createRoot();

  expect(
    scaffoldPackage({ name: "zzz-last", description: "sorts last", root })
      .status,
  ).toBe("created");

  const knip = read(root, "knip.json");
  expect(knip.indexOf('"packages/zulu"')).toBeLessThan(
    knip.indexOf('"packages/zzz-last"'),
  );
  expect(JSON.parse(knip.replaceAll(/^\s*\/\/.*$/gmu, ""))).toMatchObject({
    workspaces: {
      "packages/zzz-last": { entry: ["src/index.ts", "src/**/*.test.ts"] },
    },
  });
});

test("keeps the trailing comma when a non-package workspace follows", () => {
  const root = createRoot(KNIP_TRAILING_FIXTURE);

  expect(
    scaffoldPackage({ name: "zzz-last", description: "sorts last", root })
      .status,
  ).toBe("created");

  const knip = read(root, "knip.json");
  expect(JSON.parse(knip)).toMatchObject({
    workspaces: {
      "packages/zzz-last": { entry: ["src/index.ts", "src/**/*.test.ts"] },
      "apps/web": { entry: ["src/client.tsx"] },
    },
  });
});

test("rejects a knip.json with no packages workspace and writes nothing", () => {
  const root = createRoot(
    '{\n  "workspaces": {\n    "apps/api": {\n      "entry": ["src/server.ts!"]\n    }\n  }\n}\n',
  );

  const result = scaffoldPackage({
    name: "matter-dates",
    description: "shared matter dates",
    root,
  });

  expect(result.status).toBe("rejected");
  expect(existsSync(path.join(root, "packages/matter-dates"))).toBe(false);
});

test("rejects a name that is not kebab-case", () => {
  const root = createRoot();

  const result = scaffoldPackage({
    name: "Matter_Dates",
    description: "shared matter dates",
    root,
  });

  expect(result.status).toBe("rejected");
  expect(read(root, "knip.json")).toBe(KNIP_FIXTURE);
});

test("rejects a package directory that already exists", () => {
  const root = createRoot();
  mkdirSync(path.join(root, "packages/alpha"), { recursive: true });

  const result = scaffoldPackage({
    name: "alpha",
    description: "already extracted",
    root,
  });

  expect(result).toEqual({
    status: "rejected",
    message: "packages/alpha already exists",
  });
});

test("rejects a missing or empty description", () => {
  expect(parseArgs(["matter-dates"]).status).toBe("error");
  expect(parseArgs(["matter-dates", "--description", "   "]).status).toBe(
    "error",
  );
  expect(
    parseArgs(["matter-dates", "--description", "shared matter dates"]),
  ).toMatchObject({
    status: "ok",
    name: "matter-dates",
    description: "shared matter dates",
  });
});
