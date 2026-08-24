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

const readStringArray = (value: unknown, field: string) => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${field} must be an array of strings`);
  }
  const strings = value.flatMap((item) =>
    typeof item === "string" ? [item] : [],
  );
  if (strings.length !== value.length) {
    throw new TypeError(`${field} must be an array of strings`);
  }
  return strings;
};

const parseElysiaGroup = (source: string) => {
  const dependabot: unknown = Bun.YAML.parse(source);
  if (!isRecord(dependabot) || !Array.isArray(dependabot["updates"])) {
    throw new TypeError("Dependabot config must contain an updates array");
  }
  const bunUpdate = dependabot["updates"].find(
    (update) => isRecord(update) && update["package-ecosystem"] === "bun",
  );
  if (!isRecord(bunUpdate) || !isRecord(bunUpdate["groups"])) {
    throw new TypeError("Dependabot config must contain Bun dependency groups");
  }
  const elysiaGroup = bunUpdate["groups"]["elysia"];
  if (!isRecord(elysiaGroup)) {
    throw new TypeError("Dependabot config must contain the Elysia group");
  }

  return {
    excludePatterns:
      elysiaGroup["exclude-patterns"] === undefined
        ? []
        : readStringArray(
            elysiaGroup["exclude-patterns"],
            "Elysia exclude-patterns",
          ),
    patterns: readStringArray(elysiaGroup["patterns"], "Elysia patterns"),
  };
};

const readElysiaGroup = async () =>
  parseElysiaGroup(
    await Bun.file(
      new URL("../.github/dependabot.yml", import.meta.url),
    ).text(),
  );

const matchesDependabotPattern = (dependency: string, pattern: string) => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "u").test(dependency);
};

type DependabotGroup = ReturnType<typeof parseElysiaGroup>;

const isDependencyInGroup = (
  dependency: string,
  { excludePatterns, patterns }: DependabotGroup,
) =>
  patterns.some((pattern) => matchesDependabotPattern(dependency, pattern)) &&
  !excludePatterns.some((pattern) =>
    matchesDependabotPattern(dependency, pattern),
  );

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

    const group = await readElysiaGroup();
    const uncovered = [...installedElysiaPackages]
      .filter((dependency) => !isDependencyInGroup(dependency, group))
      .sort();

    expect(uncovered).toEqual([]);
  });

  test("applies exclude patterns after include patterns", () => {
    const group = parseElysiaGroup(`
version: 2
updates:
  - package-ecosystem: bun
    groups:
      elysia:
        patterns:
          - "@elysia/*"
        exclude-patterns:
          - "@elysia/eden"
`);

    expect(isDependencyInGroup("@elysia/cors", group)).toBe(true);
    expect(isDependencyInGroup("@elysia/eden", group)).toBe(false);
  });
});
