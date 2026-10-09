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

type IgnorePolicy =
  | {
      readonly blocker: string;
      readonly repositoryBlocker: string | undefined;
      readonly type: "upstream_blocker";
    }
  | {
      readonly reason: string;
      readonly type: "documented_policy";
    }
  | {
      readonly blockedVersion: string;
      readonly prerequisite: string;
      readonly type: "installed_prerequisite";
    }
  | {
      readonly type: "expo_sdk";
    };

const ignorePolicies = {
  "@anthropic-ai/sdk": {
    blocker: "@tanstack/ai-anthropic",
    repositoryBlocker: undefined,
    type: "upstream_blocker",
  },
  "@expo/*": {
    reason:
      "Expo packages ship as one SDK-coordinated major and are upgraded together.",
    type: "documented_policy",
  },
  "@formatjs/icu-messageformat-parser": {
    blocker: "intl-messageformat",
    repositoryBlocker: undefined,
    type: "upstream_blocker",
  },
  "@openrouter/sdk": {
    blocker: "@tanstack/ai-openrouter",
    repositoryBlocker: undefined,
    type: "upstream_blocker",
  },
  // elysia-rate-limit 5 requires Elysia 2.
  "elysia-rate-limit": {
    blockedVersion: "2.0.0",
    prerequisite: "elysia",
    type: "installed_prerequisite",
  },
  expo: {
    reason:
      "Expo packages ship as one SDK-coordinated major and are upgraded together.",
    type: "documented_policy",
  },
  "expo-*": {
    reason:
      "Expo packages ship as one SDK-coordinated major and are upgraded together.",
    type: "documented_policy",
  },
  katex: {
    blocker: "@streamdown/math",
    repositoryBlocker: "apps/web/package.json",
    type: "upstream_blocker",
  },
  openai: {
    blocker: "@tanstack/ai-openai",
    repositoryBlocker: undefined,
    type: "upstream_blocker",
  },
  "react-native": {
    type: "expo_sdk",
  },
  "react-native-screens": {
    type: "expo_sdk",
  },
} as const satisfies Record<string, IgnorePolicy>;

type IgnorePolicyDependency = keyof typeof ignorePolicies;

const hasIgnorePolicy = (
  dependency: string,
): dependency is IgnorePolicyDependency => dependency in ignorePolicies;

type BunIgnore = {
  readonly dependency: string;
  readonly updateTypes: readonly string[];
  readonly versions: readonly string[];
};

const readBunIgnore = (value: unknown): BunIgnore => {
  if (!isRecord(value) || typeof value["dependency-name"] !== "string") {
    throw new TypeError("Each Dependabot ignore must name a dependency");
  }
  return {
    dependency: value["dependency-name"],
    updateTypes:
      value["update-types"] === undefined
        ? []
        : readStringArray(value["update-types"], "ignore update-types"),
    versions:
      value["versions"] === undefined
        ? []
        : readStringArray(value["versions"], "ignore versions"),
  };
};

const normalizeVersion = (version: string) => {
  const parts = version.split(".");
  return [...parts, ...Array.from({ length: 3 - parts.length }, () => "0")]
    .slice(0, 3)
    .join(".");
};

const nextVersion = (version: string, part: "major" | "minor" | "patch") => {
  const [major, minor, patch] = normalizeVersion(version)
    .split(".")
    .map(Number);
  if (major === undefined || minor === undefined || patch === undefined) {
    throw new TypeError(`Cannot increment invalid version ${version}`);
  }
  switch (part) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    default: {
      const unknownPart: never = part;
      throw new TypeError(`Unknown version part: ${String(unknownPart)}`);
    }
  }
};

const ignoredVersionForRange = (range: string) => {
  const match = /^(>=|>)(\d+(?:\.\d+){0,2})$/u.exec(range);
  if (match === null) {
    throw new TypeError(`Unsupported Dependabot ignore range: ${range}`);
  }
  const operator = match.at(1);
  const boundary = match.at(2);
  if (operator === undefined || boundary === undefined) {
    throw new TypeError(`Unsupported Dependabot ignore range: ${range}`);
  }
  return operator === ">"
    ? nextVersion(boundary, "patch")
    : normalizeVersion(boundary);
};

// Blocker ranges are single intervals (caret, tilde or exact), so the ignore
// is stale exactly when the highest lower bound satisfies every blocker.
const rangeLowerBound = (range: string) => {
  const match = /^[\^~]?(\d+\.\d+\.\d+)$/u.exec(range);
  const lowerBound = match?.at(1);
  if (lowerBound === undefined) {
    throw new TypeError(`Unsupported blocker range: ${range}`);
  }
  return lowerBound;
};

type FirstUnblockedIgnoredVersionArgs = {
  blockerRanges: readonly string[];
  ignoredFloor: string;
};

const firstUnblockedIgnoredVersion = ({
  blockerRanges,
  ignoredFloor,
}: FirstUnblockedIgnoredVersionArgs) => {
  let candidate = ignoredFloor;
  for (const range of blockerRanges) {
    const lowerBound = rangeLowerBound(range);
    if (Bun.semver.order(lowerBound, candidate) > 0) {
      candidate = lowerBound;
    }
  }
  return blockerRanges.every((range) => Bun.semver.satisfies(candidate, range))
    ? candidate
    : undefined;
};

const readManifest = async (path: string) => {
  const manifest: unknown = await Bun.file(path).json();
  if (!isRecord(manifest)) {
    throw new TypeError(`${path} must contain a JSON object`);
  }
  return manifest;
};

const readDeclaredRange = (
  manifest: Record<string, unknown>,
  dependency: string,
  manifestPath: string,
) => {
  for (const field of dependencyFields) {
    const dependencies = manifest[field];
    if (
      isRecord(dependencies) &&
      typeof dependencies[dependency] === "string"
    ) {
      return dependencies[dependency];
    }
  }
  throw new TypeError(`${manifestPath} must declare ${dependency}`);
};

const ignoredVersion = async ({
  dependency,
  updateTypes,
  versions,
}: BunIgnore) => {
  if (versions.length === 1 && updateTypes.length === 0) {
    return ignoredVersionForRange(versions.at(0) ?? "");
  }
  const updateType = updateTypes.length === 1 ? updateTypes.at(0) : undefined;
  let part: "major" | "minor" | undefined;
  if (updateType === "version-update:semver-major") {
    part = "major";
  } else if (updateType === "version-update:semver-minor") {
    part = "minor";
  }
  if (part === undefined) {
    throw new TypeError(`Unsupported Dependabot ignore rule for ${dependency}`);
  }
  const mobileManifestPath = `${repositoryRoot}/apps/mobile/package.json`;
  const mobileManifest = await readManifest(mobileManifestPath);
  const declared = readDeclaredRange(
    mobileManifest,
    dependency,
    mobileManifestPath,
  );
  const match = /\d+(?:\.\d+){0,2}/u.exec(declared);
  if (match === null) {
    throw new TypeError(`Cannot derive the installed ${dependency} version`);
  }
  return nextVersion(match.at(0) ?? "", part);
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
  test("keeps every Bun ignore tied to a live policy", async () => {
    const source = await Bun.file(
      new URL("../.github/dependabot.yml", import.meta.url),
    ).text();
    const ignores = parseBunIgnores(source).map(readBunIgnore);
    const dependencies = ignores.map(({ dependency }) => dependency);

    expect(dependencies.toSorted()).toEqual(
      Object.keys(ignorePolicies).toSorted(),
    );

    for (const ignore of ignores) {
      const { dependency } = ignore;
      if (!hasIgnorePolicy(dependency)) {
        throw new TypeError(
          `${dependency} has no stale-ignore policy; add one or delete the ignore`,
        );
      }
      const policy = ignorePolicies[dependency];
      switch (policy.type) {
        case "documented_policy":
          // Pinned by "keeps Expo packages on one SDK major".
          break;
        case "installed_prerequisite": {
          const prerequisitePath = `${repositoryRoot}/node_modules/${policy.prerequisite}/package.json`;
          const prerequisite = await readManifest(prerequisitePath);
          const installed = prerequisite["version"];
          if (typeof installed !== "string") {
            throw new TypeError(`${prerequisitePath} must declare a version`);
          }
          expect(
            Bun.semver.order(installed, policy.blockedVersion),
            `${policy.prerequisite} ${installed} is installed; delete the ${dependency} ignore.`,
          ).toBe(-1);
          break;
        }
        case "expo_sdk": {
          const candidate = await ignoredVersion(ignore);
          const bundledModulesPath = `${repositoryRoot}/node_modules/expo/bundledNativeModules.json`;
          const bundledModules = await readManifest(bundledModulesPath);
          const supportedRange = bundledModules[dependency];
          if (typeof supportedRange !== "string") {
            throw new TypeError(
              `${bundledModulesPath} must declare ${dependency}`,
            );
          }
          expect(
            Bun.semver.satisfies(candidate, supportedRange),
            `Expo now admits ${dependency} ${candidate}; delete the Dependabot ignore.`,
          ).toBe(false);
          break;
        }
        case "upstream_blocker": {
          const candidate = await ignoredVersion(ignore);
          if (ignore.versions.length !== 1) {
            throw new TypeError(
              `${dependency} upstream blockers require one ignored version range`,
            );
          }
          expect(
            Bun.semver.satisfies(candidate, ignore.versions.at(0) ?? ""),
          ).toBe(true);

          const blockerPaths = [
            `${repositoryRoot}/node_modules/${policy.blocker}/package.json`,
            ...(policy.repositoryBlocker === undefined
              ? []
              : [`${repositoryRoot}/${policy.repositoryBlocker}`]),
          ];
          const blockerRanges = await Promise.all(
            blockerPaths.map(async (blockerPath) =>
              readDeclaredRange(
                await readManifest(blockerPath),
                dependency,
                blockerPath,
              ),
            ),
          );
          const unblocked = firstUnblockedIgnoredVersion({
            blockerRanges,
            ignoredFloor: candidate,
          });
          expect(
            unblocked,
            `Every blocker now admits ${dependency} ${String(unblocked)}; narrow or delete the ${dependency} ignore.`,
          ).toBeUndefined();
          break;
        }
      }
    }
  });

  test.each([
    {
      blockerRanges: ["^6.41.0"],
      expected: undefined,
      name: "blocker below the ignored floor",
    },
    {
      blockerRanges: ["0.13.20"],
      ignoredFloor: "0.14.0",
      expected: undefined,
      name: "exact blocker below the ignored floor",
    },
    {
      blockerRanges: ["^7.2.0"],
      expected: "7.2.0",
      name: "blocker admits the ignored floor's major",
    },
    {
      blockerRanges: ["^8.0.0"],
      expected: "8.0.0",
      name: "blocker skips past the floor to a higher ignored major",
    },
    {
      blockerRanges: ["^7.0.0", "^6.0.0"],
      expected: undefined,
      name: "only one of two blockers has lifted",
    },
    {
      blockerRanges: ["^6.0.0", "^7.1.0"],
      expected: undefined,
      name: "only the other of two blockers has lifted",
    },
    {
      blockerRanges: ["^7.0.0", "^7.1.0"],
      expected: "7.1.0",
      name: "both blockers have lifted",
    },
  ])(
    "finds the first ignored version every blocker admits: $name",
    ({ blockerRanges, expected, ignoredFloor = "7.0.0" }) => {
      expect(
        firstUnblockedIgnoredVersion({ blockerRanges, ignoredFloor }),
      ).toBe(expected);
    },
  );

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
});
