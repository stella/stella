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
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const database = new Database(lockPath, { create: true });
  try {
    while (true) {
      const acquired = Result.try(() => database.exec("BEGIN IMMEDIATE"));
      if (acquired.isOk()) {
        break;
      }
      const cause = acquired.error.cause;
      if (!(cause instanceof SQLiteError) || cause.code !== "SQLITE_BUSY") {
        throw acquired.error;
      }
      await Bun.sleep(LOCK_POLL_MS);
    }
    await run();
  } finally {
    database.close(true);
  }
};
