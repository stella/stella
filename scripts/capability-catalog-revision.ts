// Derives one Git revision's capability catalog from that revision's sources.
//
// The catalog is generated, never committed, so a guard comparing two
// revisions cannot read it from Git. Each revision is exported into a private
// directory with the checkout's installed dependencies borrowed, its MCP App
// bundles are built there and the catalog is exported from its handler graph
// into another private directory. Nothing is written to the checkout, so a
// derivation can never race a check reading the checkout's generated outputs.
// Revisions from before the catalog stopped being committed are read as
// committed.
//
// Uses only Bun and Node built-ins: the guards that call it run before any
// dependency install is assumed.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { borrowDependencies } from "./borrowed-dependencies";

const CATALOG_DIRECTORY = "packages/cli/capabilities";

export type RevisionCatalog =
  | { readonly status: "derived"; readonly directory: string }
  | { readonly status: "failed"; readonly command: string };

const run = (command: readonly string[], cwd: string): boolean => {
  // A prepared-sources manifest describes the checkout, never the export.
  const env = { ...process.env };
  delete env["CI_GENERATED_SOURCES_MANIFEST"];
  return (
    Bun.spawnSync([...command], {
      cwd,
      env,
      stdout: "ignore",
      stderr: "inherit",
    }).exitCode === 0
  );
};

const tracksCatalog = (repoRoot: string, revision: string): boolean => {
  const listed = Bun.spawnSync(
    ["git", "ls-tree", "--name-only", revision, "--", CATALOG_DIRECTORY],
    { cwd: repoRoot, stdout: "pipe", stderr: "inherit" },
  );
  return listed.exitCode === 0 && listed.stdout.toString().trim() !== "";
};

type DeriveRevisionCatalogOptions = {
  readonly repoRoot: string;
  readonly revision: string;
};

/** Writes `revision`'s catalog shards into a new private directory. */
export const deriveRevisionCatalog = ({
  repoRoot,
  revision,
}: DeriveRevisionCatalogOptions): RevisionCatalog => {
  const output = mkdtempSync(path.join(tmpdir(), "stella-catalog-shards-"));
  const exportRoot = mkdtempSync(path.join(tmpdir(), "stella-catalog-tree-"));
  const archive = `${exportRoot}.tar`;
  const legacy = tracksCatalog(repoRoot, revision);
  const steps: readonly (readonly [readonly string[], string])[] = legacy
    ? [
        [
          [
            "git",
            "archive",
            "--format=tar",
            `--output=${archive}`,
            revision,
            "--",
            CATALOG_DIRECTORY,
          ],
          repoRoot,
        ],
        [["tar", "-xf", archive, "-C", output], repoRoot],
      ]
    : [
        [
          ["git", "archive", "--format=tar", `--output=${archive}`, revision],
          repoRoot,
        ],
        [["tar", "-xf", archive, "-C", exportRoot], repoRoot],
        [["bun", "scripts/prepare-mcp-apps.ts"], exportRoot],
        // The handler graph validates the API environment when it loads; the
        // committed example supplies static defaults, and no configuration
        // enters the catalog.
        [
          [
            "bun",
            "--env-file=apps/api/.env.example",
            "apps/api/scripts/export-capability-catalog.ts",
            "--catalog-only",
            "--out",
            output,
          ],
          exportRoot,
        ],
      ];
  try {
    for (const [index, [command, cwd]] of steps.entries()) {
      // Dependencies are borrowed once the export exists, before any Bun step.
      if (!legacy && index === 2) {
        borrowDependencies(repoRoot, exportRoot);
      }
      if (!run(command, cwd)) {
        rmSync(output, { recursive: true, force: true });
        return { status: "failed", command: command.join(" ") };
      }
    }
    const directory = legacy ? path.join(output, CATALOG_DIRECTORY) : output;
    // A legacy revision whose catalog directory is empty still has a catalog.
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }
    return { status: "derived", directory };
  } finally {
    rmSync(exportRoot, { recursive: true, force: true });
    rmSync(archive, { force: true });
  }
};
