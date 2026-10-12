import { expect, test } from "bun:test";
import {
  readFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import {
  browserSuiteInputs,
  ciBrowserScopePredicate,
  requiresCiBrowser,
} from "./ci-browser-scope";
import {
  sourceClosureProblems,
  unresolvedRuntimeImports,
} from "./docker-source-closure";
import { GENERATORS } from "./generated-files";
import { lexShell } from "./install-free-ci";

const ROOT = path.resolve(import.meta.dirname, "..");
const source = readFileSync(
  path.join(ROOT, ".github/workflows/ci.yml"),
  "utf-8",
);
const workflow = v.parse(
  v.object({
    jobs: v.object({
      "ci-browser": v.object({
        steps: v.array(
          v.looseObject({
            name: v.optional(v.string()),
            run: v.optional(v.string()),
          }),
        ),
      }),
    }),
  }),
  Bun.YAML.parse(source),
);

// Vite serves the frontend roots and their imported shared modules; no API
// process is started by these configs. Include test sources and config imports.
const frontendRoots = [
  "apps/desktop/src/mainview/",
  "apps/web/src/",
  "apps/extension/src/",
  "packages/ui/src/",
];
const configFiles = [
  "apps/desktop/playwright.config.ts",
  "apps/desktop/vite.config.ts",
  "apps/web/vite.config.ts",
  "apps/web/e2e/playwright.ui-playground.config.ts",
  "apps/extension/playwright.config.ts",
  "packages/ui/playwright.config.ts",
  "packages/ui/vite.config.ts",
];

test("browser scope skips unrelated API implementation and preserves every served runtime dependency", () => {
  expect(
    requiresCiBrowser({
      root: ROOT,
      changed: ["apps/api/src/handlers/health.ts"],
    }),
  ).toBe(false);
  const inventory = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  expect(inventory.exitCode).toBe(0);
  const files = inventory.stdout.toString().split("\0").filter(Boolean);
  const tree = new Map(files.map((file) => [`/app/${file}`, file]));
  const entries = files.filter(
    (file) =>
      /\.[cm]?[jt]sx?$/u.test(file) &&
      (frontendRoots.some((root) => file.startsWith(root)) ||
        configFiles.includes(file) ||
        file.startsWith("apps/desktop/tests/browser/") ||
        file.startsWith("apps/web/e2e/ui-playground/") ||
        file.startsWith("apps/extension/tests/")),
  );
  const seen = new Set<string>();
  const problems = sourceClosureProblems(
    ROOT,
    tree,
    entries.map((file) => `/app/${file}`),
    seen,
  );
  expect(entries.length).toBeGreaterThan(0);
  // The route tree is generated before the Vite playground starts. Its
  // declared inputs must be selected too; every other unresolved edge fails.
  const routeTree = GENERATORS.find(({ outputs }) =>
    outputs.includes("apps/web/src/routeTree.gen.ts"),
  );
  expect(routeTree).toBeDefined();
  expect(problems).toEqual([
    "apps/web/src/router.tsx imports @/routeTree.gen, unavailable in Docker stage",
  ]);
  const required = ciBrowserScopePredicate({ root: ROOT });
  for (const input of routeTree?.inputs ?? []) {
    expect(
      required([input.split("*").at(0)?.replace(/\/$/u, "") ?? input]),
      input,
    ).toBe(true);
  }
  const consumed = [...seen]
    .map((file) => file.slice("/app/".length))
    .filter((file) => tree.has(`/app/${file}`));
  const included = new Set(consumed.filter((file) => required([file])));
  const omissions = (selection: ReadonlySet<string>) =>
    consumed.filter((file) => !selection.has(file));
  expect(omissions(included)).toEqual([]);
  for (const file of consumed) {
    const omitted = new Set(included);
    omitted.delete(file);
    expect(omissions(omitted), file).toEqual([file]);
  }
}, 30_000);

test("browser admission follows every declared suite selector and preparation input", () => {
  const inputs = browserSuiteInputs(source);
  const expected = new Set<string>();
  for (const { run } of workflow.jobs["ci-browser"].steps) {
    if (run === undefined) {
      continue;
    }
    for (const event of lexShell(run)) {
      if (event.type !== "command" || !event.words.includes("--quiet")) {
        continue;
      }
      const boundary = event.words.indexOf("--");
      if (boundary !== -1) {
        for (const file of event.words.slice(boundary + 1)) {
          expected.add(file);
        }
      }
    }
  }
  expect(expected.size).toBeGreaterThan(0);
  for (const input of expected) {
    expect(inputs, input).toContain(input);
    expect(requiresCiBrowser({ root: ROOT, changed: [input] }), input).toBe(
      true,
    );
  }
  for (const file of ["apps/api/.env.example", "apps/web/.env.example"]) {
    expect(inputs, file).toContain(file);
    expect(requiresCiBrowser({ root: ROOT, changed: [file] }), file).toBe(true);
  }
});

test("unresolvable browser selectors retain coverage", () => {
  expect(() => browserSuiteInputs("jobs: {}")).toThrow(
    "Missing browser suite steps",
  );
  const invalid = source.replace(
    "            apps/web \\",
    "            $UNKNOWN_INPUT \\",
  );
  expect(invalid).not.toBe(source);
  expect(() => browserSuiteInputs(invalid)).toThrow(
    "Browser scope requires literal Git paths",
  );
  expect(
    requiresCiBrowser({
      root: path.join(ROOT, "missing-checkout"),
      changed: ["apps/api/src/handlers/health.ts"],
    }),
  ).toBe(true);
});

test("the shared import reader identifies dependencies that need conservative discovery", () => {
  expect(unresolvedRuntimeImports("input.ts", 'import("./fixed.ts");')).toEqual(
    [],
  );
  expect(
    unresolvedRuntimeImports("input.ts", "import(variable);"),
  ).toHaveLength(1);
});

test("browser source consumption preserves an independently pinned alias chain", () => {
  const root = mkdtempSync(path.join(tmpdir(), "browser-alias-scope-"));
  const entry = "apps/web/src/alias-entry.ts";
  const dependency = "packages/browser-scope-fixture/src/dependency.ts";
  const transitive = "packages/browser-scope-fixture/src/transitive.ts";
  const expected = [entry, dependency, transitive];
  const files = {
    ".github/workflows/ci.yml": source,
    "bun.lock": readFileSync(path.join(ROOT, "bun.lock"), "utf-8"),
    "turbo.json": readFileSync(path.join(ROOT, "turbo.json"), "utf-8"),
    "apps/web/tsconfig.json": JSON.stringify({
      compilerOptions: {
        paths: { "@fixture/*": ["../../packages/browser-scope-fixture/src/*"] },
      },
    }),
    [entry]: 'import "@fixture/dependency";',
    [dependency]: 'import "./transitive";',
    [transitive]: "export const value = 1;",
  };
  try {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    }
    const tree = new Map(
      Object.keys(files).map((file) => [`/app/${file}`, file]),
    );
    const seen = new Set<string>();
    expect(sourceClosureProblems(root, tree, [`/app/${entry}`], seen)).toEqual(
      [],
    );
    expect(seen).toEqual(new Set(expected.map((file) => `/app/${file}`)));
    const required = ciBrowserScopePredicate({ root });
    for (const file of expected) {
      expect(required([file]), file).toBe(true);
    }
    expect(required(["apps/api/src/handlers/health.ts"])).toBe(false);
    const missingPackageScope = source.replace("            packages \\", "");
    expect(missingPackageScope).not.toBe(source);
    writeFileSync(
      path.join(root, ".github/workflows/ci.yml"),
      missingPackageScope,
    );
    const narrowed = ciBrowserScopePredicate({ root });
    expect(narrowed([dependency])).toBe(false);
    expect(narrowed([transitive])).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
