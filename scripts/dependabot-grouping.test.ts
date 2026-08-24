import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readElysiaGroupPatterns = async (): Promise<string[]> => {
  const dependabot = await Bun.file(
    new URL("../.github/dependabot.yml", import.meta.url),
  ).text();
  const groupMarker = "\n      elysia:\n";
  const groupStart = dependabot.indexOf(groupMarker);
  expect(groupStart).toBeGreaterThanOrEqual(0);

  const groupTail = dependabot.slice(groupStart + groupMarker.length);
  const nextGroupOffset = groupTail.search(/^ {6}[a-z0-9][a-z0-9-]*:$/mu);
  expect(nextGroupOffset).toBeGreaterThanOrEqual(0);

  return [
    ...groupTail.slice(0, nextGroupOffset).matchAll(/^ {10}- "([^"]+)"$/gmu),
  ].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
};

const matchesDependabotPattern = (
  dependency: string,
  pattern: string,
): boolean => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "u").test(dependency);
};

describe("Dependabot dependency groups", () => {
  test("keeps every installed Elysia package in one update group", async () => {
    const manifestPaths = [
      "package.json",
      ...(await Array.fromAsync(
        new Bun.Glob("apps/*/package.json").scan(repositoryRoot),
      )),
      ...(await Array.fromAsync(
        new Bun.Glob("packages/*/package.json").scan(repositoryRoot),
      )),
    ];
    const installedElysiaPackages = new Set<string>();
    const manifests = await Promise.all(
      manifestPaths.map(async (manifestPath) => ({
        manifest: await Bun.file(`${repositoryRoot}/${manifestPath}`).json(),
        manifestPath,
      })),
    );

    for (const { manifest, manifestPath } of manifests) {
      if (!isRecord(manifest)) {
        throw new TypeError(`${manifestPath} must contain a JSON object`);
      }

      for (const field of dependencyFields) {
        const dependencies = manifest[field];
        if (!isRecord(dependencies)) {
          continue;
        }
        for (const dependency of Object.keys(dependencies)) {
          if (
            dependency === "elysia" ||
            dependency.startsWith("@elysia/") ||
            dependency.startsWith("@elysiajs/")
          ) {
            installedElysiaPackages.add(dependency);
          }
        }
      }
    }

    const groupPatterns = await readElysiaGroupPatterns();
    const uncovered = [...installedElysiaPackages]
      .filter(
        (dependency) =>
          !groupPatterns.some((pattern) =>
            matchesDependabotPattern(dependency, pattern),
          ),
      )
      .sort();

    expect(uncovered).toEqual([]);
  });
});
