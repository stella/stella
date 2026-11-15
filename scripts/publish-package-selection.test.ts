import { describe, expect, test } from "bun:test";
import { fail as panic } from "node:assert";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import { loadChangesetPolicy } from "./changeset-guard";
import { publishedPackageNames } from "./check-published-package-lists";
import {
  NPM_RELEASE_WORKFLOW,
  readNpmReleaseGraph,
} from "./generate-npm-release-jobs";
import {
  changedPathsCommand,
  expandPublishPackages,
  npmRegistryVersion,
  selectPublishPackages,
} from "./publish-package-selection";
import { ALL_PACKAGE_ORDER } from "./publish-packages";

const workspaceDependencies = async (
  packageName: string,
): Promise<readonly string[]> => {
  const manifest: unknown = await Bun.file(
    new URL(`../packages/${packageName}/package.json`, import.meta.url),
  ).json();
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("dependencies" in manifest) ||
    typeof manifest.dependencies !== "object" ||
    manifest.dependencies === null
  ) {
    return [];
  }
  return Object.keys(manifest.dependencies).flatMap((name) =>
    name.startsWith("@stll/") ? [name.slice("@stll/".length)] : [],
  );
};

const dependencyGroups = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

const packageManifest = async (packageName: string): Promise<unknown> =>
  await Bun.file(
    new URL(`../packages/${packageName}/package.json`, import.meta.url),
  ).json();

const manifestName = (manifest: unknown): string | null =>
  typeof manifest === "object" &&
  manifest !== null &&
  "name" in manifest &&
  typeof manifest.name === "string"
    ? manifest.name
    : null;

const isPrivateManifest = (manifest: unknown): boolean =>
  typeof manifest === "object" &&
  manifest !== null &&
  "private" in manifest &&
  manifest.private === true;

const isPublishedManifest = (manifest: unknown): boolean =>
  typeof manifest === "object" &&
  manifest !== null &&
  "publishConfig" in manifest &&
  typeof manifest.publishConfig === "object" &&
  manifest.publishConfig !== null &&
  !isPrivateManifest(manifest);

const manifestDependencies = (manifest: unknown): readonly string[] => {
  if (typeof manifest !== "object" || manifest === null) {
    return [];
  }
  return dependencyGroups.flatMap((group) => {
    const dependencies: unknown = Reflect.get(manifest, group);
    if (typeof dependencies !== "object" || dependencies === null) {
      return [];
    }
    return Object.keys(dependencies);
  });
};

describe("publish package selection", () => {
  test("publishes exactly the packages the release policy gates", () => {
    const order: readonly string[] = ALL_PACKAGE_ORDER;
    expect(order.toSorted()).toEqual([
      ...publishedPackageNames(loadChangesetPolicy().releasePaths),
    ]);
  });

  test("publishes every package after the published packages it depends on", async () => {
    const order: readonly string[] = ALL_PACKAGE_ORDER;
    const misordered: string[] = [];
    for (const [index, packageName] of order.entries()) {
      for (const dependency of await workspaceDependencies(packageName)) {
        const dependencyIndex = order.indexOf(dependency);
        if (dependencyIndex > index) {
          misordered.push(`${dependency} after ${packageName}`);
        }
      }
    }
    expect(misordered).toEqual([]);
  });

  test("published packages do not depend on private workspace packages", async () => {
    const packageNames = [
      ...new Bun.Glob("*/package.json").scanSync({
        cwd: new URL("../packages", import.meta.url).pathname,
      }),
    ].map((file) => file.slice(0, -"/package.json".length));
    const manifests = await Promise.all(packageNames.map(packageManifest));
    const privateWorkspaceNames = new Set(
      manifests.flatMap((manifest) => {
        const name = manifestName(manifest);
        return name !== null && isPrivateManifest(manifest) ? [name] : [];
      }),
    );
    const violations = manifests.flatMap((manifest) => {
      if (!isPublishedManifest(manifest)) {
        return [];
      }
      const name = manifestName(manifest);
      if (name === null) {
        return ["published package has no name"];
      }
      return manifestDependencies(manifest).flatMap((dependency) =>
        privateWorkspaceNames.has(dependency)
          ? [`${name} depends on private workspace package ${dependency}`]
          : [],
      );
    });
    expect(violations).toEqual([]);
  });

  test("publish workflow delegates push selection to the tested resolver", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain(
      'mapfile -t pkgs < <(bun scripts/publish-package-selection.ts "$EVENT_NAME" "$MANUAL_PACKAGE")',
    );
    expect(workflow).not.toContain(
      "pkgs=(auth-model ai-catalog anonymize-chat chat",
    );
    expect(workflow).toContain(
      `if [[ "${String.fromCodePoint(36)}{#pkgs[@]}" -eq 0 ]]; then`,
    );
  });

  test("pushes only packages with a version changelog", () => {
    expect(
      selectPublishPackages({
        eventName: "push",
        manualPackage: "all",
        changedPaths: [
          "packages/ui/CHANGELOG.md",
          "packages/workspace-ui/CHANGELOG.md",
        ],
      }),
    ).toEqual(["ui", "workspace-ui"]);
  });

  test("does not republish a historically tagged but unpublished package", () => {
    expect(
      selectPublishPackages({
        eventName: "push",
        manualPackage: "all",
        changedPaths: ["packages/ui/CHANGELOG.md"],
      }),
    ).not.toContain("chat");
  });

  test("passes only an explicitly requested prior artifact run to the verified recovery path", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain("artifact_run_id:");
    expect(workflow).toContain(
      `artifact-run-id: ${String.fromCodePoint(36)}{{ inputs.artifact_run_id || '' }}`,
    );
    expect(workflow).toContain(`uses: ${NPM_RELEASE_WORKFLOW}`);
  });

  test("selects an explicit historical recovery package without requiring new tooling in old source", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain(
      'if [[ "$EVENT_NAME" == "workflow_run" || ( "$EVENT_NAME" == "workflow_dispatch" && "$MANUAL_PACKAGE" != "all" ) ]]; then',
    );
    expect(workflow).not.toContain("pkgs=(cli)");
    expect(workflow).toContain(
      'selection="$(bun .pack-tooling/scripts/publish-package-selection.ts "$EVENT_NAME" "$MANUAL_PACKAGE" "$GITHUB_WORKSPACE")"',
    );
    for (const script of [
      "publish-package-selection",
      "publish-packages",
      "generate-npm-release-jobs",
    ]) {
      expect(workflow).toContain(`            scripts/${script}.ts`);
    }
  });

  test("a named CLI dispatch includes exactly its transitive workspace dependencies first", async () => {
    const selection = selectPublishPackages({
      eventName: "workflow_dispatch",
      manualPackage: "cli",
      changedPaths: [],
      readRegistryVersion: () => "absent",
    });
    const expected = new Set(["cli"]);
    const pending = ["cli"];
    while (pending.length > 0) {
      const directory = pending.pop();
      if (directory === undefined) {
        break;
      }
      const dependencies = manifestDependencies(
        await packageManifest(directory),
      )
        .filter((name) =>
          ALL_PACKAGE_ORDER.some((known) => name === `@stll/${known}`),
        )
        .map((name) => name.slice("@stll/".length));
      for (const dependency of dependencies) {
        expect(selection.indexOf(dependency)).toBeGreaterThanOrEqual(0);
        expect(selection.indexOf(dependency)).toBeLessThan(
          selection.indexOf(directory),
        );
        if (!expected.has(dependency)) {
          expected.add(dependency);
          pending.push(dependency);
        }
      }
    }
    expect(selection.toSorted()).toEqual([...expected].toSorted());
    expect(selection).toContain("agent-input");
    expect(selection).toContain("stable-stringify");
    expect(new Set(selection).size).toBe(selection.length);
    expect(
      selectPublishPackages({
        eventName: "workflow_dispatch",
        manualPackage: "cli",
        changedPaths: [],
        readRegistryVersion: () => "absent",
      }),
    ).toEqual(selection);
  });

  test("a leaf dispatch selects only itself and all retains its inventory", () => {
    expect(
      selectPublishPackages({
        eventName: "workflow_dispatch",
        manualPackage: "stable-stringify",
        changedPaths: [],
      }),
    ).toEqual(["stable-stringify"]);
    expect(
      selectPublishPackages({
        eventName: "workflow_dispatch",
        manualPackage: "all",
        changedPaths: [],
      }),
    ).toEqual(ALL_PACKAGE_ORDER);
  });

  test("unknown named selections panic", () => {
    expect(() =>
      selectPublishPackages({
        eventName: "workflow_dispatch",
        manualPackage: "unknown",
        changedPaths: [],
      }),
    ).toThrow("Unknown package 'unknown'");
    expect(() =>
      expandPublishPackages({ selected: ["unknown"], graph: [] }),
    ).toThrow("Unknown package 'unknown'");
  });

  test("historical source without unrelated packages supports leaf and dependency dispatches", () => {
    const root = mkdtempSync(path.join(tmpdir(), "publish-source-"));
    try {
      const toolingRoot = path.join(root, "tooling");
      const tooling = path.join(toolingRoot, "scripts");
      const source = path.join(root, "source");
      const workflow = v.parse(
        v.object({
          jobs: v.object({
            pack: v.object({
              steps: v.array(
                v.looseObject({
                  name: v.optional(v.string()),
                  with: v.optional(
                    v.looseObject({
                      "sparse-checkout": v.optional(v.string()),
                    }),
                  ),
                }),
              ),
            }),
          }),
        }),
        Bun.YAML.parse(
          readFileSync(
            new URL("../.github/workflows/publish-npm.yml", import.meta.url),
            "utf-8",
          ),
        ),
      );
      const checkout = workflow.jobs.pack.steps.find(
        (step) => step.name === "Checkout pack tooling",
      );
      const sparse =
        checkout?.with?.["sparse-checkout"] ??
        panic("Pack tooling must declare its sparse checkout");
      for (const file of sparse
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean)) {
        const target = path.join(toolingRoot, file);
        mkdirSync(path.dirname(target), { recursive: true });
        cpSync(new URL(`../${file}`, import.meta.url), target, {
          recursive: true,
        });
      }
      for (const directory of [
        "cli",
        "agent-input",
        "stable-stringify",
        "auth-model",
      ]) {
        const manifestDir = path.join(source, "packages", directory);
        mkdirSync(manifestDir, { recursive: true });
        writeFileSync(
          path.join(manifestDir, "package.json"),
          JSON.stringify({
            name: `@stll/${directory}`,
            ...(directory === "cli"
              ? {
                  optionalDependencies: {
                    "@stll/agent-input": "workspace:*",
                    "@stll/stable-stringify": "workspace:*",
                  },
                }
              : {}),
            ...(directory === "agent-input"
              ? {
                  peerDependencies: {
                    "@stll/auth-model": "workspace:*",
                    "@stll/stable-stringify": "workspace:*",
                  },
                }
              : {}),
          }),
        );
      }
      const currentGraph = readNpmReleaseGraph({
        readManifest: (directory) =>
          readFileSync(
            new URL(`../packages/${directory}/package.json`, import.meta.url),
            "utf-8",
          ),
      });
      expect(
        expandPublishPackages({ selected: ["cli"], graph: currentGraph }),
      ).not.toContain("auth-model");
      const leaf = Bun.spawnSync(
        [
          process.execPath,
          path.join(tooling, "publish-package-selection.ts"),
          "workflow_dispatch",
          "auth-model",
          source,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(new TextDecoder().decode(leaf.stderr)).toBe("");
      expect(leaf.exitCode).toBe(0);
      expect(new TextDecoder().decode(leaf.stdout).trim()).toBe("auth-model");
      const result = Bun.spawnSync(
        [
          process.execPath,
          path.join(tooling, "publish-package-selection.ts"),
          "workflow_dispatch",
          "cli",
          source,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(new TextDecoder().decode(result.stderr)).toBe("");
      expect(result.exitCode).toBe(0);
      expect(
        new TextDecoder().decode(result.stdout).trim().split("\n"),
      ).toEqual(["stable-stringify", "auth-model", "agent-input", "cli"]);
      // A release run resolves the same closure from the release source.
      const releaseRun = Bun.spawnSync(
        [
          process.execPath,
          path.join(tooling, "publish-package-selection.ts"),
          "workflow_run",
          "all",
          source,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(new TextDecoder().decode(releaseRun.stderr)).toBe("");
      expect(releaseRun.exitCode).toBe(0);
      expect(
        new TextDecoder().decode(releaseRun.stdout).trim().split("\n"),
      ).toEqual(["stable-stringify", "auth-model", "agent-input", "cli"]);
      rmSync(path.join(source, "packages", "agent-input", "package.json"));
      const missing = Bun.spawnSync(
        [
          process.execPath,
          path.join(tooling, "publish-package-selection.ts"),
          "workflow_dispatch",
          "cli",
          source,
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      expect(missing.exitCode).not.toBe(0);
      expect(new TextDecoder().decode(missing.stderr)).toContain(
        "Unable to read source manifest packages/agent-input/package.json",
      );
      expect(new TextDecoder().decode(missing.stdout)).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("reachable source cycles fail while unrelated manifests are never read", () => {
    const readManifest = (directory: string) => {
      expect(["cli", "agent-input"]).toContain(directory);
      return JSON.stringify({
        name: `@stll/${directory}`,
        dependencies: {
          [`@stll/${directory === "cli" ? "agent-input" : "cli"}`]:
            "workspace:*",
        },
      });
    };
    expect(() =>
      selectPublishPackages({
        eventName: "workflow_dispatch",
        manualPackage: "cli",
        changedPaths: [],
        readManifest,
      }),
    ).toThrow("Dependency cycle in npm publishing inventory");
  });

  // A merge-queue batch pushes several commits at once; the version commit
  // may not be the last one, and its changelogs still have to count.
  test("selects from the whole pushed range when the push names its base", () => {
    const before = "a".repeat(40);
    expect(changedPathsCommand(before)).toEqual([
      "git",
      "diff",
      "--name-only",
      before,
      "HEAD",
      "--",
      "packages",
    ]);
  });

  test("falls back to HEAD alone without a usable push base", () => {
    for (const before of [undefined, "", "0".repeat(40), "HEAD~1", "abc"]) {
      expect(changedPathsCommand(before).slice(0, 2)).toEqual([
        "git",
        "diff-tree",
      ]);
    }
  });

  test("publish workflow hands the push base to the selector", async () => {
    const workflow = await Bun.file(
      new URL("../.github/workflows/publish-npm.yml", import.meta.url),
    ).text();

    expect(workflow).toContain(
      `PUSH_BEFORE: ${String.fromCodePoint(36)}{{ github.event.before || '' }}`,
    );
  });

  test("a CLI release packs the CLI's dependencies npm lacks, dependencies first", () => {
    // cli -> agent-input -> text-normalize, and cli -> stable-stringify.
    const manifests: Readonly<Record<string, object>> = {
      cli: {
        version: "6.11.1",
        dependencies: {
          "@stll/agent-input": "workspace:^",
          "@stll/stable-stringify": "workspace:^",
        },
      },
      "agent-input": {
        version: "0.4.3",
        dependencies: { "@stll/text-normalize": "workspace:^" },
      },
      "text-normalize": { version: "0.8.0" },
      "stable-stringify": { version: "0.2.2" },
    };
    const readManifest = (directory: string) =>
      JSON.stringify({
        name: `@stll/${directory}`,
        ...(manifests[directory] ?? panic(`unexpected read of ${directory}`)),
      });
    const select = (
      eventName: "workflow_run" | "workflow_dispatch",
      registry: Readonly<Record<string, "published" | "absent" | "unknown">>,
    ) => {
      const asked: string[] = [];
      const selection = selectPublishPackages({
        eventName,
        manualPackage: eventName === "workflow_run" ? "all" : "cli",
        changedPaths: [],
        readManifest,
        readRegistryVersion: (name, version) => {
          asked.push(`${name}@${version}`);
          return registry[name] ?? "published";
        },
      });
      return { selection, asked };
    };

    // A release that bumps a transitive dependency packs it before its user.
    for (const eventName of ["workflow_run", "workflow_dispatch"] as const) {
      const bumped = select(eventName, {
        "@stll/agent-input": "absent",
        "@stll/text-normalize": "absent",
      });
      expect(bumped.selection).toEqual([
        "text-normalize",
        "agent-input",
        "cli",
      ]);
      // The CLI itself is always packed; only its dependencies are looked up.
      expect(bumped.asked.toSorted()).toEqual([
        "@stll/agent-input@0.4.3",
        "@stll/stable-stringify@0.2.2",
        "@stll/text-normalize@0.8.0",
      ]);
    }
    // Resumed after text-normalize published: only what is left.
    expect(
      select("workflow_run", { "@stll/agent-input": "absent" }).selection,
    ).toEqual(["agent-input", "cli"]);
    // Nothing bumped beside the CLI: every dependency comes from npm.
    expect(select("workflow_run", {}).selection).toEqual(["cli"]);
    // An unreadable registry packs the package rather than assume npm has it.
    expect(
      select("workflow_run", { "@stll/stable-stringify": "unknown" }).selection,
    ).toEqual(["stable-stringify", "cli"]);
  });

  test("a CLI release covers whatever workspace dependencies the CLI has", async () => {
    // Every dependency npm lacks: the release packs the CLI's whole closure,
    // so a dependency the CLI gains later is packed without a hand list.
    const absent = () => "absent" as const;
    const closure = selectPublishPackages({
      eventName: "workflow_dispatch",
      manualPackage: "cli",
      changedPaths: [],
      readRegistryVersion: absent,
    });
    expect(
      selectPublishPackages({
        eventName: "workflow_run",
        manualPackage: "all",
        changedPaths: [],
        readRegistryVersion: absent,
      }),
    ).toEqual(closure);
    const cliDependencies = manifestDependencies(await packageManifest("cli"))
      .filter((name) => name.startsWith("@stll/"))
      .map((name) => name.slice("@stll/".length))
      .filter((name) => ALL_PACKAGE_ORDER.some((known) => known === name));
    expect(cliDependencies.length).toBeGreaterThan(0);
    for (const dependency of cliDependencies) {
      expect(closure.indexOf(dependency)).toBeGreaterThanOrEqual(0);
      expect(closure.indexOf(dependency)).toBeLessThan(closure.indexOf("cli"));
    }
    expect(closure.at(-1)).toBe("cli");
  });

  test("reads the registry answer for an exact version through npm view", () => {
    const root = mkdtempSync(path.join(tmpdir(), "npm-view-"));
    try {
      // A stand-in npm: published, missing, empty and failing answers.
      const npm = path.join(root, "npm");
      writeFileSync(
        npm,
        `#!/usr/bin/env bash
case "$2" in
  "@stll/a@1.0.0") echo '"1.0.0"' ;;
  "@stll/b@1.0.0") echo 'npm error code E404' >&2; exit 1 ;;
  "@stll/c@1.0.0") ;;
  *) echo 'npm error code ECONNRESET' >&2; exit 1 ;;
esac
`,
        { mode: 0o755 },
      );
      expect(npmRegistryVersion("@stll/a", "1.0.0", npm)).toBe("published");
      expect(npmRegistryVersion("@stll/b", "1.0.0", npm)).toBe("absent");
      expect(npmRegistryVersion("@stll/c", "1.0.0", npm)).toBe("absent");
      expect(npmRegistryVersion("@stll/d", "1.0.0", npm)).toBe("unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a push with no changed library changelog", () => {
    expect(() =>
      selectPublishPackages({
        eventName: "push",
        manualPackage: "all",
        changedPaths: ["packages/chat/src/index.ts"],
      }),
    ).toThrow("no changed library changelog");
  });
});
