import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";

import { isDistModuleEntry } from "./publish-manifest";
import { stageWorkspacePackage } from "./stage-web-runtime";
import { findExternalRuntimeWorkspacePaths } from "./web-runtime-closure";

const repoRoot = path.resolve(import.meta.dir, "..");

const lockfilePath = new URL("../bun.lock", import.meta.url);
const runtimeWorkspacePaths = findExternalRuntimeWorkspacePaths(
  Bun.JSONC.parse(await Bun.file(lockfilePath).text()),
);

describe("external runtime workspace closure", () => {
  // Bun stores a dependency under a consumer-scoped key ("parent/name") when
  // its resolution differs from the hoisted copy, and platform bindings ride
  // optionalDependencies. Both must feed the walk: following the hoisted
  // copy's dependency list here would miss packages/ws entirely.
  test("follows consumer-scoped entries and optional dependencies", () => {
    const lock = {
      packages: {
        "@x/external": [
          "@x/external@1.0.0",
          "",
          {
            dependencies: { shared: "^2.0.0" },
            optionalDependencies: { "@x/opt-native": "^1.0.0" },
          },
        ],
        "@x/external/shared": [
          "shared@2.0.0",
          "",
          { dependencies: { "@x/ws": "^1.0.0" } },
        ],
        "@x/opt-native": ["@x/opt-native@workspace:packages/opt-native"],
        "@x/web/dual": [
          "dual@2.0.0",
          "",
          { dependencies: { "@x/web-scoped-ws": "^1.0.0" } },
        ],
        "@x/web-scoped-ws": [
          "@x/web-scoped-ws@workspace:packages/web-scoped-ws",
        ],
        "@x/ws": ["@x/ws@workspace:packages/ws"],
        dual: ["dual@1.0.0", "", { dependencies: {} }],
        shared: ["shared@1.0.0", "", { dependencies: {} }],
      },
      workspaces: {
        "apps/web": {
          dependencies: { "@x/external": "^1.0.0", dual: "^2.0.0" },
          name: "@x/web",
        },
        "packages/opt-native": { name: "@x/opt-native" },
        "packages/web-scoped-ws": { name: "@x/web-scoped-ws" },
        "packages/ws": { name: "@x/ws" },
      },
    };
    expect(findExternalRuntimeWorkspacePaths(lock)).toEqual([
      "packages/opt-native",
      "packages/web-scoped-ws",
      "packages/ws",
    ]);
  });

  // The closure is derived, not declared, so its exact members may change
  // with the dependency graph. Pin @stll/folio-core's currently known
  // workspace-linked runtime dep: the derivation regressing to miss it — or
  // to an empty set — must fail here, not in a production rollout.
  test("reaches folio-core's workspace-linked runtime dependencies", () => {
    expect(runtimeWorkspacePaths).toEqual(
      expect.arrayContaining(["packages/docx-utils"]),
    );
  });
});

// The fixture reproduces the runner-image layout: node_modules/@stll/* is a
// symlink into packages/*, and the package manifest is source-shaped
// (exports -> ./src/*.ts) with the conventions of the real publishable
// packages (sideEffects: false, explicit .ts specifiers, tsdown build). A
// tree carrying only the manifest — what the runner ships from out/json —
// must fail to import; the staged dist-shaped tree must succeed. Exercises
// the sourceless-manifest failure mode end to end through Bun's real
// resolver.
describe("stageWorkspacePackage", () => {
  const fixtureManifest = {
    exports: { ".": "./src/index.ts" },
    files: ["dist", "src", "README.md"],
    name: "@stll/stage-fixture",
    scripts: { build: "tsdown" },
    sideEffects: false,
    type: "module",
    version: "0.0.1",
  };

  const probe = async (appDir: string) =>
    await Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        'const { answer } = await import("@stll/stage-fixture"); if (answer() !== 42) { process.exit(2); }',
      ],
      cwd: appDir,
      stderr: "ignore",
      stdout: "ignore",
    }).exited;

  const linkFixture = async (appDir: string, target: string) => {
    const scopeDir = path.join(appDir, "node_modules", "@stll");
    await mkdir(scopeDir, { recursive: true });
    await symlink(target, path.join(scopeDir, "stage-fixture"), "dir");
  };

  let workDir: string | undefined;

  afterAll(async () => {
    if (workDir !== undefined) {
      await rm(workDir, { force: true, recursive: true });
    }
  });

  test("manifest-only tree fails to import; staged tree succeeds", async () => {
    // Inside the repo (not the OS tmpdir) so the fixture's `bun run build`
    // resolves the workspace's real tsdown toolchain, like every closure
    // member does in the Docker builder.
    const cacheRoot = path.join(repoRoot, "node_modules", ".cache");
    await mkdir(cacheRoot, { recursive: true });
    workDir = await mkdtemp(path.join(cacheRoot, "stage-web-runtime-test-"));

    const pkgDir = path.join(workDir, "packages", "stage-fixture");
    await mkdir(path.join(pkgDir, "src"), { recursive: true });
    await Bun.write(
      path.join(pkgDir, "package.json"),
      `${JSON.stringify(fixtureManifest, null, 2)}\n`,
    );
    await Bun.write(
      path.join(pkgDir, "tsdown.config.ts"),
      [
        'import { defineConfig } from "tsdown";',
        "",
        "export default defineConfig({",
        '  entry: ["src/index.ts"],',
        '  format: ["esm"],',
        '  platform: "neutral",',
        "  dts: false,",
        '  outDir: "dist",',
        "  clean: true,",
        "});",
        "",
      ].join("\n"),
    );
    // Explicit .ts specifier, matching how workspace source imports its own
    // modules; the build must rewrite or inline it rather than emit a
    // dangling .ts specifier.
    await Bun.write(
      path.join(pkgDir, "src", "index.ts"),
      'export { answer } from "./impl.ts";\n',
    );
    await Bun.write(
      path.join(pkgDir, "src", "impl.ts"),
      "export const answer = (): number => 42;\n",
    );

    // Manifest-only: the source-shaped package.json without src, which is
    // exactly what the runner's out/json overlay provides.
    const manifestOnlyDir = path.join(
      workDir,
      "manifest-only",
      "stage-fixture",
    );
    await mkdir(manifestOnlyDir, { recursive: true });
    await Bun.write(
      path.join(manifestOnlyDir, "package.json"),
      `${JSON.stringify(fixtureManifest, null, 2)}\n`,
    );
    const brokenApp = path.join(workDir, "app-broken");
    await linkFixture(brokenApp, manifestOnlyDir);
    expect(await probe(brokenApp)).not.toBe(0);

    const stagedDir = path.join(workDir, "staged", "stage-fixture");
    const staged = await stageWorkspacePackage({ pkgDir, stagedDir });
    const root = staged.exports["."];
    expect(root !== undefined && isDistModuleEntry(root) && root.import).toBe(
      "./dist/index.js",
    );
    const stagedApp = path.join(workDir, "app-staged");
    await linkFixture(stagedApp, stagedDir);
    expect(await probe(stagedApp)).toBe(0);
  }, 30_000);
});
