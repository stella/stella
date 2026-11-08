import { panic } from "better-result";

import { createSha256 } from "@stll/sha256/bun";

export type MigrationIdentityChanges = {
  addedDirectories: readonly string[];
  removedDirectories: readonly string[];
};

export type MigrationChanges = MigrationIdentityChanges & {
  modifiedFiles: readonly string[];
};

export type StaleMigrationStamp = {
  type: "stale-timestamp";
  directory: string;
  newestBaseDirectory: string;
};

export const MIGRATION_TIMESTAMP = /(?:^|\/)([0-9]{14})_[^/]+$/u;
export const MIGRATION_FILE = /^apps\/api\/drizzle\/[^/]+\/migration\.sql$/u;
export const MIGRATION_FOLDER_FILE = /^apps\/api\/drizzle\/[^/]+\/.+$/u;
export const ALIAS_INVENTORY_PATH =
  "apps/api/src/lib/db/migration-alias-inventory.json";

export const runGit = ({
  arguments_,
  cwd,
}: {
  arguments_: readonly string[];
  cwd: string;
}): Uint8Array => {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    panic(
      `git ${arguments_.join(" ")} failed (${result.exitCode}): ${result.stderr.toString()}`,
    );
  }
  return result.stdout;
};

export const readMigrationChanges = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}): MigrationChanges => {
  const addedDirectories: string[] = [];
  const removedDirectories: string[] = [];
  const modifiedFiles: string[] = [];
  const output = new TextDecoder().decode(
    runGit({
      arguments_: [
        "diff",
        "--no-renames",
        "--name-status",
        baseRef,
        "--",
        "apps/api/drizzle",
      ],
      cwd,
    }),
  );
  const untracked = new TextDecoder().decode(
    runGit({
      arguments_: [
        "ls-files",
        "--others",
        "--exclude-standard",
        "--",
        "apps/api/drizzle",
      ],
      cwd,
    }),
  );
  const entries = [
    ...output.split("\n").map((line) => line.split("\t")),
    ...untracked
      .split("\n")
      .filter(Boolean)
      .map((file) => ["A", file]),
  ];
  for (const [status, filename] of entries) {
    if (filename === undefined) {
      continue;
    }
    if (status !== "A" && status !== "D" && status !== "M") {
      panic(
        `Unsupported migration change status ${String(status)} for ${filename}`,
      );
    }
    if (status === "M" && MIGRATION_FOLDER_FILE.test(filename)) {
      modifiedFiles.push(filename);
      continue;
    }
    if (!MIGRATION_FILE.test(filename)) {
      continue;
    }
    const directory = filename.slice(0, -"/migration.sql".length);
    if (status === "A") {
      addedDirectories.push(directory);
    } else if (status === "D") {
      removedDirectories.push(directory);
    }
  }
  return {
    addedDirectories: [...new Set(addedDirectories)],
    removedDirectories,
    modifiedFiles,
  };
};

export const findMigrationTimestampViolations = ({
  addedDirectories,
  baseDirectories,
}: {
  addedDirectories: readonly string[];
  baseDirectories: readonly string[];
}): StaleMigrationStamp[] => {
  let newestBase: { directory: string; stamp: string } | undefined;
  for (const directory of baseDirectories) {
    const stamp = MIGRATION_TIMESTAMP.exec(directory)?.at(1);
    if (
      stamp !== undefined &&
      (newestBase === undefined || stamp > newestBase.stamp)
    ) {
      newestBase = { directory, stamp };
    }
  }
  if (newestBase === undefined) {
    return [];
  }
  return addedDirectories.flatMap((directory) => {
    const stamp = MIGRATION_TIMESTAMP.exec(directory)?.at(1);
    return stamp !== undefined && stamp <= newestBase.stamp
      ? [
          {
            type: "stale-timestamp" as const,
            directory,
            newestBaseDirectory: newestBase.directory,
          },
        ]
      : [];
  });
};

const readGitFile = ({
  ref,
  file,
  cwd,
}: {
  ref: string;
  file: string;
  cwd: string;
}) => runGit({ arguments_: ["show", `${ref}:${file}`], cwd });

const readBaseInventory = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}): unknown => {
  const files = new TextDecoder()
    .decode(
      runGit({
        arguments_: [
          "ls-tree",
          "--name-only",
          baseRef,
          "--",
          ALIAS_INVENTORY_PATH,
        ],
        cwd,
      }),
    )
    .trim();
  if (files === "") {
    return [];
  }
  if (files !== ALIAS_INVENTORY_PATH) {
    panic(`Unexpected base inventory path: ${files}`);
  }
  return JSON.parse(
    new TextDecoder().decode(
      readGitFile({ ref: baseRef, file: ALIAS_INVENTORY_PATH, cwd }),
    ),
  );
};

export const readMigrationBaseSnapshot = ({
  baseRef,
  cwd,
}: {
  baseRef: string;
  cwd: string;
}) => {
  const mergeBase = new TextDecoder()
    .decode(runGit({ arguments_: ["merge-base", baseRef, "HEAD"], cwd }))
    .trim();
  const changes = readMigrationChanges({ baseRef: mergeBase, cwd });
  const baseInventory = readBaseInventory({ baseRef: mergeBase, cwd });
  const baseHashes = Object.fromEntries(
    changes.modifiedFiles
      .filter((candidate) => MIGRATION_FILE.test(candidate))
      .map((file) => [
        file,
        createSha256()
          .update(readGitFile({ ref: mergeBase, file, cwd }))
          .digest("hex"),
      ]),
  );
  const baseDirectories = new TextDecoder()
    .decode(
      runGit({
        arguments_: [
          "ls-tree",
          "--name-only",
          baseRef,
          "--",
          "apps/api/drizzle/",
        ],
        cwd,
      }),
    )
    .split("\n")
    .filter((directory) => MIGRATION_TIMESTAMP.test(directory));
  return { mergeBase, changes, baseInventory, baseHashes, baseDirectories };
};
