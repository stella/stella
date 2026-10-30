import { panic } from "better-result";
import { generateDrizzleJson } from "drizzle-kit/api-postgres";
import {
  existsSync,
  mkdtempSync,
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
  const snapshot = await generateDrizzleJson(schema, undefined, ["public"]);
  return JSON.stringify({ ...snapshot, id: "generated" });
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

export const checkMigrationRequirement = async (
  root: string,
  baseRef: string,
) => {
  const changedFiles = runGit(root, [
    "diff",
    "--name-only",
    `${baseRef}...HEAD`,
  ])
    .trim()
    .split("\n");
  if (changedFiles.some((file) => file.startsWith("apps/api/drizzle/"))) {
    return { status: "migration-present" } as const;
  }

  const baseRoot = mkdtempSync(path.join(tmpdir(), "migration-schema-base-"));
  try {
    runGit(root, ["worktree", "add", "--detach", baseRoot, baseRef]);
    if (!existsSync(path.join(baseRoot, "node_modules"))) {
      symlinkSync(
        path.join(root, "node_modules"),
        path.join(baseRoot, "node_modules"),
        "dir",
      );
    }
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
    runGit(root, ["worktree", "remove", "--force", baseRoot]);
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
