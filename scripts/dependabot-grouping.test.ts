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

const parseBunGroup = (source: string, name: string) => {
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
  const group = bunUpdate["groups"][name];
  if (!isRecord(group)) {
    throw new TypeError(`Dependabot config must contain the ${name} group`);
  }

  return {
    excludePatterns:
      group["exclude-patterns"] === undefined
        ? []
        : readStringArray(
            group["exclude-patterns"],
            `${name} exclude-patterns`,
          ),
    patterns: readStringArray(group["patterns"], `${name} patterns`),
    updateTypes:
      group["update-types"] === undefined
        ? undefined
        : readStringArray(group["update-types"], `${name} update-types`),
  };
};

const parseElysiaGroup = (source: string) => parseBunGroup(source, "elysia");

const parseBunIgnores = (source: string) => {
  const dependabot: unknown = Bun.YAML.parse(source);
  if (!isRecord(dependabot) || !Array.isArray(dependabot["updates"])) {
    throw new TypeError("Dependabot config must contain an updates array");
  }
  const bunUpdate = dependabot["updates"].find(
    (update) => isRecord(update) && update["package-ecosystem"] === "bun",
  );
  if (!isRecord(bunUpdate) || !Array.isArray(bunUpdate["ignore"])) {
    throw new TypeError("Dependabot Bun config must contain ignore rules");
  }
  return bunUpdate["ignore"];
};

const readDependabotConfig = () =>
  Bun.file(new URL("../.github/dependabot.yml", import.meta.url)).text();

const readElysiaGroup = async () =>
  parseElysiaGroup(await readDependabotConfig());

const ANONYMIZER_PACKAGES = [
  "@stll/anonymize",
  "@stll/anonymize-wasm",
  "@stll/anonymize-data",
] as const;

const matchesDependabotPattern = (dependency: string, pattern: string) => {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "u").test(dependency);
};

type DependabotGroup = ReturnType<typeof parseBunGroup>;

const isDependencyInGroup = (
  dependency: string,
  { excludePatterns, patterns }: DependabotGroup,
) =>
  patterns.some((pattern) => matchesDependabotPattern(dependency, pattern)) &&
  !excludePatterns.some((pattern) =>
    matchesDependabotPattern(dependency, pattern),
  );

describe("Dependabot dependency groups", () => {
  test("keeps Expo packages on one SDK major", async () => {
    const source = await Bun.file(
      new URL("../.github/dependabot.yml", import.meta.url),
    ).text();
    const ignores = parseBunIgnores(source);
    const expoMajorIgnores = ignores.filter(
      (entry) =>
        isRecord(entry) &&
        ["expo", "expo-*", "@expo/*"].includes(
          typeof entry["dependency-name"] === "string"
            ? entry["dependency-name"]
            : "",
        ),
    );

    expect(expoMajorIgnores).toEqual([
      {
        "dependency-name": "expo",
        "update-types": ["version-update:semver-major"],
      },
      {
        "dependency-name": "expo-*",
        "update-types": ["version-update:semver-major"],
      },
      {
        "dependency-name": "@expo/*",
        "update-types": ["version-update:semver-major"],
      },
    ]);
  });

  test("keeps Expo-native screens on the SDK-supported minor", async () => {
    const source = await Bun.file(
      new URL("../.github/dependabot.yml", import.meta.url),
    ).text();
    const ignores = parseBunIgnores(source);
    const reactNativeScreens = ignores.find(
      (entry) =>
        isRecord(entry) && entry["dependency-name"] === "react-native-screens",
    );

    expect(reactNativeScreens).toEqual({
      "dependency-name": "react-native-screens",
      "update-types": ["version-update:semver-minor"],
    });
  });

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
      .toSorted();

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

  test("updates the anonymizer packages on their own", async () => {
    const source = await readDependabotConfig();
    const sweep = parseBunGroup(source, "minor-and-patch");
    const anonymizer = parseBunGroup(source, "stll-anonymize");

    for (const dependency of ANONYMIZER_PACKAGES) {
      expect(isDependencyInGroup(dependency, sweep)).toBe(false);
      expect(isDependencyInGroup(dependency, anonymizer)).toBe(true);
    }
    // Every update type, so a patch is never folded into the sweep instead.
    expect(anonymizer.updateTypes).toBeUndefined();
    // Nothing else rides in the anonymizer pull request.
    expect(isDependencyInGroup("@stll/property-testing", anonymizer)).toBe(
      false,
    );
    expect(isDependencyInGroup("zod", sweep)).toBe(true);
  });
});
