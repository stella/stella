import { Result } from "better-result";
import { Database, SQLiteError } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const LOCK_POLL_MS = 100;

type GenerationLockOptions = {
  lockPath: string;
  run: () => void | Promise<void>;
};

// SQLite's process-owned write lock releases even on SIGKILL. Keep the file:
// unlinking it would let another caller lock a different inode at the same path.
export const withGenerationLock = async ({
  lockPath,
  run,
}: GenerationLockOptions) => {
  const opened = Result.try(() => {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    return new Database(lockPath, { create: true });
  });
  if (opened.isErr()) {
    return opened;
  }
  const database = opened.value;
  try {
    while (true) {
      const acquired = Result.try(() => database.run("BEGIN IMMEDIATE"));
      if (acquired.isOk()) {
        break;
      }
      const cause = acquired.error.cause;
      if (!(cause instanceof SQLiteError) || cause.code !== "SQLITE_BUSY") {
        return acquired;
      }
      await Bun.sleep(LOCK_POLL_MS);
    }
    return await Result.tryPromise(async () => {
      await run();
    });
  } finally {
    database.close(true);
  }
};
