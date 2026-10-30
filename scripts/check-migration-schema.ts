import { panic } from "better-result";
import { generateDrizzleJson } from "drizzle-kit/api-postgres";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MISSING_MIGRATION_MESSAGE =
  "ERROR: Database schema changed without a migration file in apps/api/drizzle/.";

const readSchemaInputs = (root: string) => {
  const config = readFileSync(
    path.join(root, "apps/api/drizzle.config.ts"),
    "utf-8",
  );
  const schemaMatch = /schema\s*:\s*\[([\s\S]*?)\]/mu.exec(config);
  const schemaSource = schemaMatch?.at(1);
  if (!schemaSource) {
    panic("Could not find schema inputs in apps/api/drizzle.config.ts.");
  }
  return [...schemaSource.matchAll(/["'`]([^"'`]+\.ts)["'`]/gu)].map(
    (match) => {
      const schemaPath = match.at(1);
      if (!schemaPath) {
        panic("Schema input capture was empty.");
      }
      return path.resolve(root, "apps/api", schemaPath);
    },
  );
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  // JSON drops undefined object values; keep the key so presence still counts.
  if (value === undefined) {
    return "null";
  }
  return JSON.stringify(value);
};

const generateSchemaSnapshot = async (root: string) => {
  const schemaEntries = await Promise.all(
    readSchemaInputs(root).map(async (input, inputIndex) => {
      const exports = await import(`${input}?snapshot=${crypto.randomUUID()}`);
      return Object.entries(exports).map(
        ([name, value]) => [`${inputIndex}:${name}`, value] as const,
      );
    }),
  );
  const schema = Object.fromEntries(schemaEntries.flat());
  const { ddl } = await generateDrizzleJson(schema, undefined, ["public"]);
  // Entity order follows schema input order, which a table move changes; each
  // entity is self-contained, so sorting them keeps only semantic differences.
  // Arrays inside an entity (column lists) stay ordered: their order is DDL.
  return ddl
    .map((entity) => canonicalJson(entity))
    .toSorted()
    .join("\n");
};

const runGit = (root: string, arguments_: readonly string[]) => {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(result.stderr.toString());
  }
  return result.stdout.toString();
};

const readPackageManifest = (manifestPath: string) => {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf-8"));
  if (manifest === null || typeof manifest !== "object") {
    panic(`Could not map package manifest at ${manifestPath}.`);
  }
  return manifest;
};

const workspacePackages = (root: string) => {
  const packageJson = readPackageManifest(path.join(root, "package.json"));
  if (
    !("workspaces" in packageJson) ||
    !Array.isArray(packageJson.workspaces) ||
    !packageJson.workspaces.every((workspace) => typeof workspace === "string")
  ) {
    panic(
      "Could not map workspace packages: package.json workspaces must be an array of paths.",
    );
  }

  const packages = new Map<string, string>();
  for (const workspace of packageJson.workspaces) {
    if (!workspace.endsWith("/*")) {
      panic(`Could not map workspace pattern ${workspace}.`);
    }
    const parent = path.join(root, workspace.slice(0, -2));
    if (!existsSync(parent)) {
      continue;
    }
    for (const directory of readdirSync(parent)) {
      const packageRoot = path.join(parent, directory);
      const manifestPath = path.join(packageRoot, "package.json");
      if (!existsSync(manifestPath)) {
        continue;
      }
      const manifest = readPackageManifest(manifestPath);
      if (
        !("name" in manifest) ||
        typeof manifest.name !== "string" ||
        packages.has(manifest.name)
      ) {
        panic(`Could not map workspace package at ${packageRoot}.`);
      }
      packages.set(manifest.name, packageRoot);
    }
  }
  return packages;
};

const linkBaseDependencies = (headRoot: string, baseRoot: string) => {
  const headModules = path.join(headRoot, "node_modules");
  const baseModules = path.join(baseRoot, "node_modules");
  if (!existsSync(headModules)) {
    panic(
      `Cannot build the baseline node_modules: ${headModules} does not exist.`,
    );
  }
  mkdirSync(baseModules);

  const workspaces = workspacePackages(baseRoot);
  const workspaceScopes = new Set(
    [...workspaces.keys()]
      .filter((name) => name.startsWith("@"))
      .map((name) => name.split("/").at(0)),
  );
  for (const entry of readdirSync(headModules)) {
    const headEntry = path.join(headModules, entry);
    if (workspaces.has(entry)) {
      continue;
    }
    if (workspaceScopes.has(entry)) {
      const baseScope = path.join(baseModules, entry);
      mkdirSync(baseScope);
      for (const scopedEntry of readdirSync(headEntry)) {
        if (!workspaces.has(`${entry}/${scopedEntry}`)) {
          symlinkSync(
            path.join(headEntry, scopedEntry),
            path.join(baseScope, scopedEntry),
          );
        }
      }
      continue;
    }
    symlinkSync(headEntry, path.join(baseModules, entry));
  }
  for (const [name, packageRoot] of workspaces) {
    const destination = path.join(baseModules, name);
    mkdirSync(path.dirname(destination), { recursive: true });
    if (existsSync(destination) || lstatSync(packageRoot).isSymbolicLink()) {
      panic(`Could not map workspace package ${name} to ${packageRoot}.`);
    }
    symlinkSync(packageRoot, destination, "dir");
  }
};

export const checkMigrationRequirement = async (
  root: string,
  baseRef: string,
) => {
  // Both the changed-file list and the baseline schema come from the merge
  // base: a base branch that moved on must not judge this branch's schema.
  const mergeBase = runGit(root, ["merge-base", baseRef, "HEAD"]).trim();
  // Only an added or modified migration provides one; a deleted migration
  // must not satisfy the check.
  const changedFiles = runGit(root, [
    "diff",
    "--name-only",
    "--diff-filter=AM",
    `${mergeBase}..HEAD`,
  ])
    .trim()
    .split("\n");
  if (
    changedFiles.some((file) =>
      /^apps\/api\/drizzle\/[^/]+\/migration\.sql$/u.test(file),
    )
  ) {
    return { status: "migration-present" } as const;
  }

  const baseRoot = mkdtempSync(path.join(tmpdir(), "migration-schema-base-"));
  let worktreeAdded = false;
  try {
    runGit(root, ["worktree", "add", "--detach", baseRoot, mergeBase]);
    worktreeAdded = true;
    linkBaseDependencies(root, baseRoot);
    const [baseSnapshot, headSnapshot] = await Promise.all([
      generateSchemaSnapshot(baseRoot),
      generateSchemaSnapshot(root),
    ]);
    if (baseSnapshot === headSnapshot) {
      return { status: "schema-unchanged" } as const;
    }
    return {
      status: "migration-missing",
      message: MISSING_MIGRATION_MESSAGE,
    } as const;
  } finally {
    if (worktreeAdded) {
      runGit(root, ["worktree", "remove", "--force", baseRoot]);
    }
    rmSync(baseRoot, { recursive: true, force: true });
  }
};

if (import.meta.main) {
  const baseRef = process.argv.at(2);
  if (!baseRef) {
    panic("Usage: bun scripts/check-migration-schema.ts <base-ref>");
  }
  const result = await checkMigrationRequirement(process.cwd(), baseRef);
  if (result.status === "migration-missing") {
    console.error(result.message);
    console.error(
      "Generate one with: cd apps/api && bun --bun drizzle-kit generate --name <change-name>",
    );
    process.exit(1);
  }
}
