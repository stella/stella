import { describe, expect, test } from "bun:test";

import {
  BUNDLED_CONSUMERS,
  type BundledConsumerSite,
  compareSiteCounts,
  type RepositoryFile,
  scanBundledConsumers,
} from "./bundled-consumers";

const SCAN_GLOBS = [
  "apps/*/Dockerfile",
  "docker/**/Dockerfile",
  "apps/*/package.json",
  "packages/*/package.json",
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
  ".github/ci-checks/*.yml",
  ".github/ci-checks/*.yaml",
  ".github/actions/**/action.yml",
  ".github/actions/**/action.yaml",
  "scripts/**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}",
  "apps/*/scripts/**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}",
  "packages/*/scripts/**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}",
] as const;

const siteName = ({ file, command }: BundledConsumerSite): string =>
  `${file}: ${command}`;

const repositoryFiles = async (): Promise<RepositoryFile[]> => {
  const paths = new Set<string>();
  for (const pattern of SCAN_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan({
      cwd: `${import.meta.dir}/..`,
      onlyFiles: true,
    })) {
      paths.add(path);
    }
  }
  return Promise.all(
    [...paths].map(async (path) => ({
      path,
      contents: await Bun.file(`${import.meta.dir}/../${path}`).text(),
    })),
  );
};

const normalized = (contents: string): string =>
  contents
    .replace(/\\\r?\n/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

describe("bundled consumer census", () => {
  test("matches every repository bundling site in both directions", async () => {
    const found = scanBundledConsumers(await repositoryFiles()).map(siteName);
    const registered = BUNDLED_CONSUMERS.map(siteName);

    expect(compareSiteCounts(found, registered)).toEqual({
      missing: [],
      stale: [],
    });
  });

  test("references boot checks that still exist", async () => {
    const ci = await Bun.file(
      `${import.meta.dir}/../.github/workflows/ci.yml`,
    ).text();
    const dockerfiles = new Map<string, string>();
    const missing: string[] = [];

    for (const consumer of BUNDLED_CONSUMERS) {
      const check = consumer.bootCheck;
      if (check.type === "none") {
        continue;
      }
      if (check.type === "ci-job") {
        const job = check.jobId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        if (!new RegExp(`^  ${job}:\\s*$`, "mu").test(ci)) {
          missing.push(`${siteName(consumer)} -> CI job ${check.jobId}`);
        }
        continue;
      }

      let dockerfile = dockerfiles.get(check.dockerfile);
      if (dockerfile === undefined) {
        dockerfile = await Bun.file(
          `${import.meta.dir}/../${check.dockerfile}`,
        ).text();
        dockerfiles.set(check.dockerfile, dockerfile);
      }
      if (!normalized(dockerfile).includes(normalized(check.run))) {
        missing.push(
          `${siteName(consumer)} -> ${check.dockerfile}: ${check.run}`,
        );
      }
    }

    expect(missing).toEqual([]);
  });
});

describe("bundling-site scanner", () => {
  test.each([
    {
      name: "a compiled Docker artifact",
      file: {
        path: "apps/example/Dockerfile",
        contents:
          "FROM oven/bun:1\nRUN bun build src/index.ts --compile --outfile app\n",
      },
      command: "bun build src/index.ts --compile --outfile app",
    },
    {
      // Dockerfile instructions are case-insensitive and may be indented.
      name: "a lowercase indented Docker RUN",
      file: {
        path: "docker/example/Dockerfile",
        contents:
          "FROM oven/bun:1\n  run bun build src/index.ts --outfile app.js\n",
      },
      command: "bun build src/index.ts --outfile app.js",
    },
    {
      name: "a package script bundle",
      file: {
        path: "packages/example/package.json",
        contents: JSON.stringify({
          scripts: {
            build: "clean && bun build src/index.ts --outfile dist/app.js",
          },
        }),
      },
      command: "bun build src/index.ts --outfile dist/app.js",
    },
    {
      name: "an inline workflow list step",
      file: {
        path: ".github/workflows/example.yml",
        contents:
          "jobs:\n  build:\n    steps:\n      - run: bun build src/index.ts --outfile dist/app.js\n",
      },
      command: "bun build src/index.ts --outfile dist/app.js",
    },
    {
      name: "a block workflow list step",
      file: {
        path: ".github/workflows/example.yml",
        contents:
          "jobs:\n  build:\n    steps:\n      - name: Build\n        run: |\n          set -e\n          bun build src/index.ts --compile --outfile app\n",
      },
      command: "bun build src/index.ts --compile --outfile app",
    },
    {
      name: "a composite action step",
      file: {
        path: ".github/actions/example/action.yml",
        contents:
          "runs:\n  using: composite\n  steps:\n    - shell: bash\n      run: bun build src/index.ts --outfile dist/app.js\n",
      },
      command: "bun build src/index.ts --outfile dist/app.js",
    },
    {
      name: "a Bun build API call",
      file: {
        path: "apps/example/scripts/build.ts",
        contents:
          "export const build = () => Bun.build({ entrypoints: ['src/index.ts'] });\n",
      },
      command: "Bun.build(entrypoints: ['src/index.ts'])",
    },
    {
      name: "a Bun build API call after a string on its line",
      file: {
        path: "scripts/build-example.ts",
        contents:
          'const mode = "production"; await Bun.build({ entrypoints: [] });\n',
      },
      command: "Bun.build(entrypoints: [])",
    },
    {
      name: "a Bun build API call by element access",
      file: {
        path: "packages/example/scripts/build.mts",
        contents: 'await Bun["build"]({ entrypoints: [] });\n',
      },
      command: "Bun.build(entrypoints: [])",
    },
  ])("reports $name", ({ file, command }) => {
    expect(scanBundledConsumers([file])).toEqual([
      { file: file.path, command },
    ]);
  });

  test("reports each Bun build call in a file as its own site", () => {
    const file = {
      path: "scripts/build-two.ts",
      contents: [
        'await Bun.build({ entrypoints: ["src/server.ts"], outdir: "dist" });',
        "const options = { entrypoints: [] };",
        "await Bun.build(options);",
        "",
      ].join("\n"),
    };
    expect(scanBundledConsumers([file])).toEqual([
      { file: file.path, command: 'Bun.build(entrypoints: ["src/server.ts"])' },
      { file: file.path, command: "Bun.build(options)" },
    ]);
  });

  test("needs one registration per occurrence of an identical site", () => {
    const file = {
      path: "scripts/build-twice.ts",
      contents: [
        'await Bun.build({ entrypoints: ["src/app.ts"], outdir: "dist/a" });',
        'await Bun.build({ entrypoints: ["src/app.ts"], outdir: "dist/b" });',
        "",
      ].join("\n"),
    };
    const found = scanBundledConsumers([file]).map(siteName);
    expect(found).toHaveLength(2);
    const once = found.slice(0, 1);
    expect(found).toEqual([...once, ...once]);
    expect(compareSiteCounts(found, once)).toEqual({
      missing: once,
      stale: [],
    });
    expect(compareSiteCounts(once, found)).toEqual({
      missing: [],
      stale: once,
    });
    expect(compareSiteCounts(found, found)).toEqual({ missing: [], stale: [] });
  });

  test("ignores Bun build mentions that are not calls", () => {
    const file = {
      path: "scripts/build-notes.ts",
      contents:
        '// Bun.build({ entrypoints: [] })\nconst note = "Bun.build(";\nconst build = Bun.build;\n',
    };
    expect(scanBundledConsumers([file])).toEqual([]);
  });

  // The scanner accepts these shapes; enumeration must read each of them,
  // or a site there is never scanned.
  test.each([
    "apps/example/Dockerfile",
    "docker/example/Dockerfile",
    "apps/example/package.json",
    "packages/example/package.json",
    ".github/workflows/example.yml",
    ".github/workflows/example.yaml",
    ".github/ci-checks/example.yml",
    ".github/ci-checks/example.yaml",
    ".github/actions/example/action.yml",
    ".github/actions/example/action.yaml",
    "scripts/build.ts",
    "apps/example/scripts/build.mjs",
    "packages/example/scripts/build.cts",
  ])("enumerates %s", (path) => {
    expect(
      SCAN_GLOBS.some((pattern) => new Bun.Glob(pattern).match(path)),
    ).toBe(true);
  });
});
