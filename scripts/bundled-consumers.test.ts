import { describe, expect, test } from "bun:test";

import {
  BUNDLED_CONSUMERS,
  scanBundledConsumers,
  type BundledConsumerSite,
  type RepositoryFile,
} from "./bundled-consumers";

const SCAN_GLOBS = [
  "apps/*/Dockerfile",
  "docker/**/Dockerfile",
  "apps/*/package.json",
  "packages/*/package.json",
  ".github/workflows/*.yml",
  ".github/workflows/*.yaml",
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
    const duplicateRegistrations = registered.filter(
      (site, index) => registered.indexOf(site) !== index,
    );
    const missing = found.filter((site) => !registered.includes(site));
    const stale = registered.filter((site) => !found.includes(site));

    expect({
      duplicateRegistrations,
      missingRegistryEntries: missing,
      staleRegistryEntries: stale,
    }).toEqual({
      duplicateRegistrations: [],
      missingRegistryEntries: [],
      staleRegistryEntries: [],
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
      name: "a Bun build API call",
      file: {
        path: "apps/example/scripts/build.ts",
        contents:
          "export const build = () => Bun.build({ entrypoints: ['src/index.ts'] });\n",
      },
      command: "Bun.build(",
    },
  ])("reports $name", ({ file, command }) => {
    expect(scanBundledConsumers([file])).toEqual([
      { file: file.path, command },
    ]);
  });
});
