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

import { parseArgs, scaffoldPackage } from "./new-package";

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

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const createRoot = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "stella-new-package-"));
  roots.push(root);
  writeFileSync(path.join(root, "knip.json"), KNIP_FIXTURE);
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
