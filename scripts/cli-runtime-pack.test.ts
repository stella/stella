import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CLI_CONTRACT_SURFACE,
  canonicalJson,
  findSurfaceDrift,
  type CliContractSurface,
  type CliContractSurfacePart,
} from "./check-cli-release-coupling";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_DIRECTORY = "packages/cli";
const COMMAND_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 600_000;
const RUNTIME_SOURCES = [
  "src/generated/route-map.ts",
  "src/generated/tool-annotations.ts",
] as const;

const run = (args: readonly [string, ...string[]], root: string): string => {
  const [command, ...parameters] = args;
  const result = spawnSync(command, parameters, {
    cwd: root,
    encoding: "utf-8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(result.error, args.join(" ")).toBeUndefined();
  expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
  return result.stdout;
};

type CloneRevisionOptions = {
  readonly directory: string;
  readonly revision: string;
};

const cloneRevision = ({ directory, revision }: CloneRevisionOptions): void => {
  // Dependencies are read through a symlink; builds write only inside the clone.
  run(
    [
      "git",
      "clone",
      "--shared",
      "--no-checkout",
      "--quiet",
      REPO_ROOT,
      directory,
    ],
    REPO_ROOT,
  );
  run(["git", "checkout", "--detach", "--quiet", revision], directory);
  symlinkSync(
    path.join(REPO_ROOT, "node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );
};

const packedFiles = (root: string): string[] => {
  // Prepack must regenerate missing runtime sources before its normal build.
  const packed: unknown = JSON.parse(
    run(
      ["npm", "pack", "--dry-run", "--json", "--foreground-scripts=false"],
      path.join(root, CLI_DIRECTORY),
    ),
  );
  if (!Array.isArray(packed) || packed.length !== 1) {
    throw new TypeError("npm pack must report exactly one package");
  }
  const packageEntry: unknown = packed.at(0);
  if (
    typeof packageEntry !== "object" ||
    packageEntry === null ||
    !("files" in packageEntry) ||
    !Array.isArray(packageEntry.files)
  ) {
    throw new TypeError("npm pack must report its complete files list");
  }
  return packageEntry.files
    .map((entry: unknown) => {
      if (
        typeof entry !== "object" ||
        entry === null ||
        !("path" in entry) ||
        typeof entry.path !== "string"
      ) {
        throw new TypeError("npm pack files must contain string paths");
      }
      return entry.path;
    })
    .toSorted();
};

type ReadSurfaceOptions = {
  readonly root: string;
  readonly layout: "source" | "published";
};

const readSurface = ({ root, layout }: ReadSurfaceOptions) => {
  const read = (part: CliContractSurfacePart): string =>
    readFileSync(
      path.join(
        root,
        CLI_DIRECTORY,
        layout === "source" ? part : CLI_CONTRACT_SURFACE[part].published,
      ),
      "utf-8",
    );
  return {
    "capability-catalog.json": read("capability-catalog.json"),
    "src/generated/registry-snapshot.json": read(
      "src/generated/registry-snapshot.json",
    ),
    "src/generated/api-contract.ts": read("src/generated/api-contract.ts"),
    "src/generated/mcp-contract.ts": read("src/generated/mcp-contract.ts"),
  } as const satisfies CliContractSurface;
};

const readBuiltRuntime = (root: string): unknown =>
  JSON.parse(
    run(
      [
        "node",
        "--input-type=module",
        "--eval",
        'import { generatedRouteMap } from "./dist/generated/route-map.js"; import { generatedToolAnnotations } from "./dist/generated/tool-annotations.js"; process.stdout.write(JSON.stringify({ routes: generatedRouteMap, annotations: generatedToolAnnotations }));',
      ],
      path.join(root, CLI_DIRECTORY),
    ),
  );

const runtimeSourcesAtBase = (): boolean => {
  const routeMap = `${CLI_DIRECTORY}/${RUNTIME_SOURCES[0]}`;
  return (
    run(
      ["git", "ls-tree", "--name-only", "origin/main", "--", routeMap],
      REPO_ROOT,
    ).trim() === routeMap
  );
};

// Before/after parity is a migration acceptance check; later contract changes
// remain governed by the ordinary catalog, registry, and changeset guards.
test.skipIf(!process.env["CI"] || !runtimeSourcesAtBase())(
  "fresh CLI packaging reconstructs runtime sources without changing published files or contracts",
  () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "stella-cli-runtime-pack-"),
    );
    const base = path.join(directory, "base");
    const head = path.join(directory, "head");
    try {
      const baseRevision = run(
        ["git", "rev-parse", "origin/main"],
        REPO_ROOT,
      ).trim();
      const headRevision = run(["git", "rev-parse", "HEAD"], REPO_ROOT).trim();
      cloneRevision({ directory: base, revision: baseRevision });
      cloneRevision({ directory: head, revision: headRevision });
      expect(existsSync(path.join(head, "apps/api/.env"))).toBe(false);
      for (const file of RUNTIME_SOURCES) {
        expect(existsSync(path.join(head, CLI_DIRECTORY, file))).toBe(false);
      }

      // Changesets uses version generation independently of runtime generation.
      run(["bun", "run", "codegen:version"], path.join(head, CLI_DIRECTORY));
      expect(
        run(
          [
            "git",
            "diff",
            "--exit-code",
            "--",
            `${CLI_DIRECTORY}/src/generated/cli-version.ts`,
          ],
          head,
        ),
      ).toBe("");
      for (const file of RUNTIME_SOURCES) {
        expect(existsSync(path.join(head, CLI_DIRECTORY, file))).toBe(false);
      }

      const baseFiles = packedFiles(base);
      const headFiles = packedFiles(head);
      expect(headFiles).toEqual(baseFiles);
      for (const file of RUNTIME_SOURCES) {
        expect(headFiles).toContain(file);
      }
      const baseSurface = readSurface({ root: base, layout: "source" });
      const headSurface = readSurface({ root: head, layout: "source" });
      expect(
        findSurfaceDrift({ head: headSurface, published: baseSurface }),
      ).toEqual([]);
      expect(
        findSurfaceDrift({
          head: headSurface,
          published: readSurface({ root: head, layout: "published" }),
        }),
      ).toEqual([]);
      const baseRuntime = canonicalJson(readBuiltRuntime(base));
      expect(canonicalJson(readBuiltRuntime(head))).toBe(baseRuntime);

      // Publishing must also work after every ignored output has been removed.
      for (const file of RUNTIME_SOURCES) {
        rmSync(path.join(head, CLI_DIRECTORY, file));
      }
      rmSync(path.join(head, CLI_DIRECTORY, "dist"), {
        recursive: true,
        force: true,
      });
      run(["npm", "run", "prepublishOnly"], path.join(head, CLI_DIRECTORY));
      for (const file of RUNTIME_SOURCES) {
        expect(existsSync(path.join(head, CLI_DIRECTORY, file))).toBe(true);
      }
      expect(canonicalJson(readBuiltRuntime(head))).toBe(baseRuntime);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);
