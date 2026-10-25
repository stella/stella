import { panic } from "better-result";
import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { legalAtlasImageSelected } from "./ci-plan-scope";
import {
  commandEntries,
  sourceClosureProblems,
  unresolvedRuntimeImports,
} from "./docker-source-closure";
import {
  legalAtlasApiSourceClosure,
  legalAtlasApiSourcePredicate,
  legalAtlasApiSourceRequired,
} from "./legal-atlas-image-scope";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCKERFILE = "apps/legal-atlas-runner/Dockerfile";
const API_SOURCE = "apps/api/src/consumed.ts";
const UNRELATED = "apps/api/src/handlers/health.ts";

type FixtureOptions = {
  build?: string;
  source?: string;
  extra?: Readonly<Record<string, string>>;
};
const withFixture = async (
  options: FixtureOptions,
  check: (root: string, trackedFiles: string[]) => Promise<void>,
) => {
  const root = mkdtempSync(path.join(tmpdir(), "legal-atlas-scope-"));
  const files = {
    [DOCKERFILE]:
      "FROM bun AS base\nWORKDIR /app\nRUN turbo prune @stll/legal-atlas-runner --docker\nRUN bun --filter @stll/legal-atlas-runner build\n",
    "apps/legal-atlas-runner/package.json": JSON.stringify({
      name: "@stll/legal-atlas-runner",
      scripts: {
        build:
          options.build ?? "bun build src/index.ts --outfile dist/index.js",
      },
    }),
    "apps/legal-atlas-runner/tsconfig.json": JSON.stringify({
      compilerOptions: { paths: { "@/api/*": ["../api/src/*"] } },
    }),
    "apps/legal-atlas-runner/src/index.ts":
      options.source ?? 'import "@/api/consumed";',
    [API_SOURCE]: "export const consumed = 1;",
    [UNRELATED]: "export const health = 1;",
    ...options.extra,
  };
  try {
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), content);
    }
    await check(root, Object.keys(files));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("image selection includes every consumed source and workspace manifest and rejects any omission", async () => {
  const tracked = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT });
  expect(tracked.exitCode).toBe(0);
  const trackedFiles = tracked.stdout.toString().split("\0").filter(Boolean);
  const tree = new Map(trackedFiles.map((file) => [`/app/${file}`, file]));
  // This integration guard follows the real build script and Docker inputs.
  // Resolver completeness is independently pinned by the alias fixture below.
  const entries = await commandEntries(
    ROOT,
    tree,
    "bun --filter @stll/legal-atlas-runner build",
    "/app",
  );
  const seen = new Set<string>();
  expect(await sourceClosureProblems(ROOT, tree, entries, seen)).toEqual([]);
  const dockerfile = readFileSync(path.join(ROOT, DOCKERFILE), "utf-8");
  const installInputs = /for input in ([^;]+);/u
    .exec(dockerfile)
    ?.at(1)
    ?.split(/\s+/u);
  expect(installInputs).toBeDefined();
  const copiedRootInputs = /cp ([^;&]+) \/json\//u
    .exec(dockerfile)
    ?.at(1)
    ?.split(/\s+/u);
  expect(copiedRootInputs).toBeDefined();
  const installPaths = [...(installInputs ?? []), ...(copiedRootInputs ?? [])];
  const consumed = [
    ...new Set([
      ...[...seen].map((file) => file.slice("/app/".length)),
      ...trackedFiles.filter((file) =>
        installPaths.some(
          (input) => file === input || file.startsWith(`${input}/`),
        ),
      ),
      // The Docker install-inputs stage preserves the complete workspace map,
      // including manifests outside the runner's dependency graph.
      ...trackedFiles.filter((file) =>
        /^(?:apps|packages)\/[^/]+\/package\.json$/u.test(file),
      ),
    ]),
  ];
  expect(consumed.some((file) => file.startsWith("apps/api/src/"))).toBe(true);
  // The planner's coarse scope selects every consumed file before the
  // closure narrows it.
  const selected = new Set(
    consumed.filter((file) => legalAtlasImageSelected([file])),
  );
  const required = legalAtlasApiSourcePredicate({ root: ROOT, trackedFiles });
  expect(await required([UNRELATED])).toBe(false);
  const included = new Set<string>();
  for (const file of consumed) {
    if (selected.has(file) && (await required([file]))) {
      included.add(file);
    }
  }
  const violations = (selection: ReadonlySet<string>) =>
    consumed.filter((file) => !selection.has(file));
  expect(violations(included)).toEqual([]);
  for (const file of consumed) {
    expect(await required([file]), file).toBe(true);
    const omitted = new Set(included);
    omitted.delete(file);
    expect(violations(omitted), file).toEqual([file]);
  }
}, 30_000);

test("image build entrypoints and configured aliases contribute new API dependencies automatically", async () => {
  await withFixture(
    {
      build:
        "bun build src/index.ts --outfile dist/index.js && bun build ../api/src/new-entry.ts --outfile dist/extra.js",
      extra: {
        "apps/api/src/new-entry.ts": 'import "./new-dependency";',
        "apps/api/src/new-dependency.ts": "export const dependency = 1;",
      },
    },
    async (root, trackedFiles) => {
      const required = legalAtlasApiSourcePredicate({ root, trackedFiles });
      expect(await required([API_SOURCE])).toBe(true);
      expect(await required(["apps/api/src/new-entry.ts"])).toBe(true);
      expect(await required(["apps/api/src/new-dependency.ts"])).toBe(true);
      expect(await required([UNRELATED])).toBe(false);
    },
  );
});

test("additional Docker build commands and newly configured aliases join the source scope", async () => {
  await withFixture(
    {
      source: 'import "@new/dependency";',
      extra: {
        [DOCKERFILE]:
          "FROM bun AS base\nWORKDIR /app\nRUN turbo prune @stll/legal-atlas-runner --docker\nRUN bun --filter @stll/legal-atlas-runner build\nRUN bun build apps/api/src/direct-entry.ts --outfile extra.js\n",
        "apps/legal-atlas-runner/tsconfig.json": JSON.stringify({
          compilerOptions: { paths: { "@new/*": ["../api/src/new/*"] } },
        }),
        "apps/api/src/new/dependency.ts":
          'export { dependency } from "./transitive";',
        "apps/api/src/new/transitive.ts":
          'export { dependency } from "../shared/leaf";',
        "apps/api/src/shared/leaf.ts": "export const dependency = 1;",
        "apps/api/src/direct-entry.ts": 'import "./direct-dependency";',
        "apps/api/src/direct-dependency.ts": "export const direct = 1;",
      },
    },
    async (root, trackedFiles) => {
      // This list comes from the fixture's authored imports, never from the
      // resolver. Losing an alias or transitive edge must fail this oracle.
      const expected = [
        "apps/legal-atlas-runner/src/index.ts",
        "apps/api/src/new/dependency.ts",
        "apps/api/src/new/transitive.ts",
        "apps/api/src/shared/leaf.ts",
        "apps/api/src/direct-entry.ts",
        "apps/api/src/direct-dependency.ts",
      ];
      const closure = await legalAtlasApiSourceClosure({ root, trackedFiles });
      expect(closure.status).toBe("resolved");
      if (closure.status !== "resolved") {
        panic("Alias fixture must have a resolved image source closure");
      }
      expect(closure.files).toEqual(new Set(expected));
      const required = legalAtlasApiSourcePredicate({ root, trackedFiles });
      for (const file of expected) {
        expect(await required([file]), file).toBe(true);
        const omitted = new Set(closure.files);
        omitted.delete(file);
        expect(
          expected.filter((dependency) => !omitted.has(dependency)),
        ).toEqual([file]);
      }
      expect(await required([API_SOURCE])).toBe(false);
      expect(await required([UNRELATED])).toBe(false);
    },
  );
});

test("unknown import edges and missing tracked sources conservatively require the image", async () => {
  for (const source of [
    'import "@/api/missing";',
    'const module = "@/api/consumed"; await import(module);',
    'const module = "@/api/consumed"; require(module);',
    `const name = "consumed"; await import(\`@/api/\${name}\`);`,
  ]) {
    await withFixture({ source }, async (root, trackedFiles) => {
      const closure = await legalAtlasApiSourceClosure({ root, trackedFiles });
      expect(closure.status, source).toBe("unresolved");
      expect(
        await legalAtlasApiSourceRequired({
          changed: [UNRELATED],
          root,
          trackedFiles,
        }),
      ).toBe(true);
    });
  }
  await withFixture({}, async (root, trackedFiles) => {
    expect(
      await legalAtlasApiSourceRequired({
        changed: [UNRELATED],
        root,
        trackedFiles: trackedFiles.filter((file) => file !== API_SOURCE),
      }),
    ).toBe(true);
  });
});

test("image metadata and non-API inputs retain the existing broad image scope", async () => {
  const required = legalAtlasApiSourcePredicate({
    root: "/missing-image-scope-fixture",
    trackedFiles: [],
  });
  expect(await required([])).toBe(false);
  for (const file of [
    "apps/api/package.json",
    "apps/api/tsconfig.json",
    "apps/api/drizzle.config.ts",
    "apps/api/src/example.config.ts",
    "apps/api/src/example.d.ts",
    "apps/api/src/example.d.mts",
    "apps/api/src/asset.json",
    "apps/legal-atlas-runner/src/index.ts",
    "packages/legal-atlas/src/index.ts",
    "bun.lock",
    "package.json",
    ".dockerignore",
    DOCKERFILE,
  ]) {
    expect(await required([file]), file).toBe(true);
  }
  expect(await required([UNRELATED])).toBe(true);
});

test("the canonical runtime import reader distinguishes literal edges from unresolved execution", () => {
  const source = [
    'import type { Example } from "./types";',
    'await import("./literal");',
    "await import(`./template-literal`);",
    "await import(target);",
    "require(target);",
  ].join("\n");
  expect(unresolvedRuntimeImports("entry.ts", source)).toEqual([
    "entry.ts:4: nonliteral runtime import",
    "entry.ts:5: nonliteral runtime import",
  ]);
  // Cached readers must follow current content, including a resolved edit.
  expect(
    unresolvedRuntimeImports("entry.ts", 'await import("./literal");'),
  ).toEqual([]);
});
