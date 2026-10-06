import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  canonicalJson,
  CLI_CONTRACT_SURFACE_PATHS,
  type CliContractSurface,
  type CliContractSurfacePart,
  findSurfaceDrift,
  readHeadSurface,
  readPublishedPackageSurface,
} from "./check-cli-release-coupling";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const CLI_DIRECTORY = "packages/cli";
const COMMAND_TIMEOUT_MS = 180_000;
const TEST_TIMEOUT_MS = 600_000;
const READER_PATHS = new Set([
  "src/capability-catalog-data.ts",
  "src/capability-catalog-data.test.ts",
  "dist/capability-catalog-data.js",
  "dist/capability-catalog-data.js.map",
  "dist/capability-catalog-data.d.ts",
]);

const run = (args: readonly [string, ...string[]], root: string): string => {
  const [command, ...parameters] = args;
  const childEnv = { ...process.env };
  if (root !== REPO_ROOT) {
    delete childEnv["CI_GENERATED_SOURCES_MANIFEST"];
  }
  const result = spawnSync(command, parameters, {
    cwd: root,
    env: childEnv,
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
  // Shared clones leave the source checkout and its worktree registry untouched.
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
  // Keep prepack enabled: this exercises the actual build and npm file selection.
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

const isCatalogPath = (file: string): boolean =>
  file === "capability-catalog.json" ||
  (file.startsWith("capabilities/") && file.endsWith(".json"));

// npm prepack builds both revisions; keep that work confined to CI runners.
const legacyCatalogAtBase = () => {
  const catalogPath = `${CLI_DIRECTORY}/capability-catalog.json`;
  const files = run(
    ["git", "ls-tree", "--name-only", "origin/main", "--", catalogPath],
    REPO_ROOT,
  );
  return files.trim() === catalogPath;
};

// File-list and before/after contract parity are specific to this migration.
// Later capability changes have their own changeset and drift guards.
test.skipIf(!process.env["CI"] || !legacyCatalogAtBase())(
  "capability shards preserve npm pack contents and the complete CLI contract",
  () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "stella-capability-pack-"),
    );
    const base = path.join(directory, "base");
    const head = path.join(directory, "head");
    try {
      const baseRevision = run(
        ["git", "rev-parse", "origin/main"],
        REPO_ROOT,
      ).trim();
      // Pin the reference to committed main bytes before any lifecycle script runs.
      const committedBase = (part: CliContractSurfacePart) =>
        run(
          ["git", "show", `${baseRevision}:${CLI_DIRECTORY}/${part}`],
          REPO_ROOT,
        );
      const baseSurface = {
        "capability-catalog.json": committedBase("capability-catalog.json"),
        "src/generated/registry-snapshot.json": committedBase(
          "src/generated/registry-snapshot.json",
        ),
        "src/generated/api-contract.ts": committedBase(
          "src/generated/api-contract.ts",
        ),
        "src/generated/mcp-contract.ts": committedBase(
          "src/generated/mcp-contract.ts",
        ),
      } as const satisfies CliContractSurface;
      const headRevision = run(["git", "rev-parse", "HEAD"], REPO_ROOT).trim();
      cloneRevision({ directory: base, revision: baseRevision });
      cloneRevision({ directory: head, revision: headRevision });
      // Changesets invokes this path without preparing an API environment.
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
      const baseFiles = packedFiles(base);
      const headFiles = packedFiles(head);
      for (const part of CLI_CONTRACT_SURFACE_PATHS) {
        expect(
          readFileSync(path.join(base, CLI_DIRECTORY, part), "utf-8"),
        ).toBe(baseSurface[part]);
      }
      expect(
        findSurfaceDrift({
          head: readPublishedPackageSurface(path.join(base, CLI_DIRECTORY)),
          published: baseSurface,
        }),
      ).toEqual([]);
      const unchangedFiles = (files: readonly string[]): string[] =>
        files.filter((file) => !isCatalogPath(file) && !READER_PATHS.has(file));
      expect(unchangedFiles(headFiles)).toEqual(unchangedFiles(baseFiles));

      const committedShards = run(
        [
          "git",
          "ls-tree",
          "-r",
          "-z",
          "--name-only",
          "HEAD",
          "--",
          `${CLI_DIRECTORY}/capabilities`,
        ],
        head,
      )
        .split("\0")
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(`${CLI_DIRECTORY}/`.length))
        .toSorted();
      expect(committedShards.length).toBeGreaterThan(0);
      expect(headFiles.filter(isCatalogPath)).toEqual(committedShards);
      for (const file of READER_PATHS) {
        expect(headFiles).toContain(file);
      }

      // The published reader handles the old monolith and the new shard layout.
      // Compare every raw catalog field as well as the other negotiated contracts.
      const headSurface = readHeadSurface(head);
      expect(
        findSurfaceDrift({ head: headSurface, published: baseSurface }),
      ).toEqual([]);
      expect(
        findSurfaceDrift({
          head: headSurface,
          published: readPublishedPackageSurface(
            path.join(head, CLI_DIRECTORY),
          ),
        }),
      ).toEqual([]);
      const readerOutput: unknown = JSON.parse(
        run(
          [
            "node",
            "--input-type=module",
            "--eval",
            'import { readCapabilityCatalog } from "./dist/capability-catalog-data.js"; process.stdout.write(JSON.stringify(readCapabilityCatalog()));',
          ],
          path.join(head, CLI_DIRECTORY),
        ),
      );
      expect(canonicalJson(readerOutput)).toBe(
        canonicalJson(
          JSON.parse(baseSurface["capability-catalog.json"]) as unknown,
        ),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
  TEST_TIMEOUT_MS,
);
