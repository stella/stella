import { describe, expect, test } from "bun:test";

import { decideDependabotEmptyChangeset } from "./dependabot-empty-changeset";

const policy = {
  releasePaths: [
    "packages/workspace-ui/package.json",
    "packages/workspace-ui/README.md",
    "packages/workspace-ui/src/**",
    "packages/ui/package.json",
    "packages/ui/README.md",
    "packages/ui/src/**",
  ],
  generatedPaths: [],
  packageFiles: [
    "packages/workspace-ui/package.json",
    "packages/ui/package.json",
  ],
} as const;

const workspaceUiManifest = "packages/workspace-ui/package.json";
const uiManifest = "packages/ui/package.json";

const manifest = (
  packagePath: string,
  base: string,
  head: string,
) => ({ packagePath, base, head });

const json = (value: unknown): string => JSON.stringify(value);

const basePackage = {
  name: "@stll/workspace-ui",
  version: "0.6.2",
  dependencies: { "@stll/ui": "workspace:^" },
  peerDependencies: { react: ">=19" },
  devDependencies: { "@tanstack/react-table": "9.2.2" },
};

const decide = (
  input: Partial<Parameters<typeof decideDependabotEmptyChangeset>[0]> = {},
) =>
  decideDependabotEmptyChangeset({
    policy,
    changedFiles: [],
    addedChangesetFiles: [],
    manifests: [],
    ...input,
  });

describe("Dependabot empty changeset decision", () => {
  test("does nothing when no release-gated path changed", () => {
    expect(
      decide({ changedFiles: ["bun.lock", "apps/web/src/routes.tsx"] }),
    ).toEqual({ status: "noop", reason: "no-release-paths" });
  });

  test("does nothing when a changeset already exists", () => {
    expect(
      decide({
        changedFiles: [workspaceUiManifest],
        addedChangesetFiles: [".changeset/quiet-bears-wave.md"],
      }),
    ).toEqual({ status: "noop", reason: "existing-changeset" });
  });

  test("creates one empty changeset for semantic devDependency-only manifest changes", () => {
    const head = {
      ...basePackage,
      devDependencies: { "@tanstack/react-table": "9.2.3" },
    };

    expect(
      decide({
        changedFiles: [workspaceUiManifest],
        manifests: [manifest(workspaceUiManifest, json(basePackage), json(head))],
      }),
    ).toEqual({
      status: "create",
      packages: ["@stll/workspace-ui"],
    });
  });

  test("derives all eligible published package names from the policy manifests", () => {
    const uiBase = { ...basePackage, name: "@stll/ui" };
    const uiHead = {
      ...uiBase,
      devDependencies: { ...uiBase.devDependencies, react: "19.1.0" },
    };

    expect(
      decide({
        changedFiles: [workspaceUiManifest, uiManifest],
        manifests: [
          manifest(
            workspaceUiManifest,
            json(basePackage),
            json({
              ...basePackage,
              devDependencies: {
                "@tanstack/react-table": "9.2.3",
              },
            }),
          ),
          manifest(uiManifest, json(uiBase), json(uiHead)),
        ],
      }),
    ).toEqual({
      status: "create",
      packages: ["@stll/workspace-ui", "@stll/ui"],
    });
  });

  test.each([
    [
      "runtime dependency changes",
      {
        ...basePackage,
        dependencies: { "@stll/ui": "workspace:^", zod: "^4.0.0" },
      },
      "runtime-change",
    ],
    [
      "peer dependency changes",
      { ...basePackage, peerDependencies: { react: ">=20" } },
      "peer-change",
    ],
    [
      "source changes",
      basePackage,
      "source-change",
    ],
  ] as const)("refuses %s", (_label, head, reason) => {
    const changedFiles =
      reason === "source-change"
        ? [workspaceUiManifest, "packages/workspace-ui/src/table.tsx"]
        : [workspaceUiManifest];

    expect(
      decide({
        changedFiles,
        manifests: [manifest(workspaceUiManifest, json(basePackage), json(head))],
      }),
    ).toEqual({ status: "refuse", reason });
  });

  test("refuses a group mixing an eligible devDependency change with a runtime change", () => {
    const runtimeBase = { ...basePackage, name: "@stll/ui" };
    const runtimeHead = {
      ...runtimeBase,
      dependencies: { ...runtimeBase.dependencies, zod: "^4.0.0" },
    };

    expect(
      decide({
        changedFiles: [workspaceUiManifest, uiManifest],
        manifests: [
          manifest(
            workspaceUiManifest,
            json(basePackage),
            json({
              ...basePackage,
              devDependencies: {
                "@tanstack/react-table": "9.2.3",
              },
            }),
          ),
          manifest(uiManifest, json(runtimeBase), json(runtimeHead)),
        ],
      }),
    ).toEqual({ status: "refuse", reason: "mixed-change" });
  });

  test("refuses formatting-only manifest changes", () => {
    expect(
      decide({
        changedFiles: [workspaceUiManifest],
        manifests: [
          manifest(
            workspaceUiManifest,
            json(basePackage),
            JSON.stringify(basePackage, null, 2),
          ),
        ],
      }),
    ).toEqual({ status: "refuse", reason: "format-only" });
  });

  test.each([
    ["invalid JSON", manifest(workspaceUiManifest, json(basePackage), "{")],
    ["missing manifest pair", undefined],
  ] as const)("refuses a malformed manifest pair: %s", (_label, pair) => {
    expect(
      decide({
        changedFiles: [workspaceUiManifest],
        manifests: pair === undefined ? [] : [pair],
      }),
    ).toEqual({ status: "refuse", reason: "malformed-manifest" });
  });
});
