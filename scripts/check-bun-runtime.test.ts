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
import * as v from "valibot";

import {
  dockerCmdRuntime,
  type Launch,
  launches,
  packageExecutables,
  scanPackageScripts,
} from "./check-bun-runtime";

const ROOT = path.resolve(import.meta.dir, "..");
const context = {
  executables: new Set(["vite", "playwright", "tsdown", "knip"]),
  scripts: new Set(["build", "generate", "knip"]),
};

const node = (program: string): Launch => ({ program, runs: "node" });
const bun = (program: string): Launch => ({ program, runs: "bun" });
const cases: [string, Launch[]][] = [
  ["vite dev", [node("vite")]],
  ["bun --bun vite dev", [bun("vite")]],
  ["bun -b vite dev", [bun("vite")]],
  ["bun run --bun vite build", [bun("vite")]],
  ["bun run vite build", [node("vite")]],
  ["bun vite build", [node("vite")]],
  ["bunx playwright test", [node("playwright")]],
  ["bunx --bun playwright test", [bun("playwright")]],
  ["bun x tsdown", [node("tsdown")]],
  ["bun x --bun tsdown", [bun("tsdown")]],
  ["node scripts/build.mjs", [node("node")]],
  ["npx tsdown", [node("npx")]],
  ['cd ../.. && FORCE=1 exec vite build --mode "$MODE"', [node("vite")]],
  [
    '([ -n "$TURBO_HASH" ] || bun run generate) && bun --bun vite dev',
    [bun("vite")],
  ],
  ['echo "$(vite --version)"', [node("vite")]],
  ["bun run build", []],
  ["bun run knip", []],
  ["bun --bun knip", [{ program: "knip", runs: "script" }]],
  ["bunx --bun knip", [bun("knip")]],
  ["bun --filter @stll/web vite", []],
  ["bun run --cwd ../web vite", []],
  ["bun --preload ./setup.ts scripts/run.ts", []],
  ["bun test src", []],
  ["cargo build && git status", []],
];

for (const [command, expected] of cases) {
  test(command, () => {
    expect(launches(command, context)).toEqual(expected);
  });
}

const writeRepo = (files: Record<string, string>): string => {
  const root = mkdtempSync(path.join(tmpdir(), "bun-runtime-"));
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), content);
  }
  return root;
};

const manifest = (scripts: Record<string, string>, extra = {}) =>
  `${JSON.stringify({ name: "fixture", ...extra, scripts }, null, 2)}\n`;

test("finds scripts that start package executables on Node, with their lines", () => {
  const root = writeRepo({
    "bun.lock": `{ "packages": { "vite": ["vite@8.0.0", "", { "bin": { "vite": "bin/vite.js" } }, "sha512-"] } }\n`,
    "package.json": manifest({ build: "turbo build" }),
    "apps/web/package.json": manifest({
      dev: "bun --bun vite dev",
      build: "vite build",
      cli: "own-cli --help",
    }),
    "packages/tool/package.json": manifest(
      { start: "own-cli" },
      { bin: { "own-cli": "src/cli.ts", "bun-cli": "src/bun-cli.ts" } },
    ),
    "packages/tool/src/cli.ts": "#!/usr/bin/env node\n",
    "packages/tool/src/bun-cli.ts": "#!/usr/bin/env bun\n",
  });
  try {
    expect([...packageExecutables(root)].toSorted()).toEqual([
      "own-cli",
      "vite",
    ]);
    expect(scanPackageScripts(root, {})).toEqual({
      findings: [
        {
          file: "apps/web/package.json",
          line: 5,
          script: "build",
          program: "vite",
          runs: "node",
        },
        {
          file: "apps/web/package.json",
          line: 6,
          script: "cli",
          program: "own-cli",
          runs: "node",
        },
        {
          file: "packages/tool/package.json",
          line: 8,
          script: "start",
          program: "own-cli",
          runs: "node",
        },
      ],
      unusedExceptions: [],
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an exception covers its executable and fails once no script needs it", () => {
  const root = writeRepo({
    "bun.lock": `{ "packages": { "expo": ["expo@1.0.0", "", { "bin": { "expo": "bin/cli" } }, "sha512-"] } }\n`,
    "package.json": manifest({ start: "expo start" }),
    "apps/.keep": "",
    "packages/.keep": "",
  });
  try {
    expect(
      scanPackageScripts(root, { expo: "fails on Bun", vite: "unused" }),
    ).toEqual({ findings: [], unusedExceptions: ["vite"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the web dev server starts on the runtime the web image serves on", () => {
  const runtime = dockerCmdRuntime(
    readFileSync(path.join(ROOT, "apps/web/Dockerfile"), "utf-8"),
  );
  const { scripts } = v.parse(
    v.object({ scripts: v.record(v.string(), v.string()) }),
    JSON.parse(readFileSync(path.join(ROOT, "apps/web/package.json"), "utf-8")),
  );
  const dev = launches(scripts["dev"] ?? "", {
    executables: packageExecutables(ROOT),
    scripts: new Set(Object.keys(scripts)),
  });
  expect(dev.map(({ program, runs }) => [program, runs])).toEqual([
    ["vite", runtime],
  ]);
});

test("the image runtime is read from the last exec-form CMD", () => {
  expect(
    dockerCmdRuntime(
      'FROM a AS build\nCMD ["node", "x.js"]\nFROM b\nCMD ["bun", "dist/runtime.js"]\n',
    ),
  ).toBe("bun");
  expect(() => dockerCmdRuntime("FROM a\nCMD bun x.js\n")).toThrow(
    "Dockerfile has no exec-form CMD",
  );
});
