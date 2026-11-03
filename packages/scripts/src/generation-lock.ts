import { Result, TaggedError } from "better-result";
import { Database, SQLiteError } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

const LOCK_POLL_MS = 100;

class GenerationLockTimeoutError extends TaggedError(
  "GenerationLockTimeoutError",
)<{
  message: string;
}> {}

type GenerationLockOptions<T> = {
  lockPath: string;
  run: () => T | Promise<T>;
  waitTimeoutMs?: number;
};

// SQLite's process-owned write lock releases even on SIGKILL. Keep the file:
// unlinking it would let another caller lock a different inode at the same path.
export const withGenerationLock = async <T>({
  lockPath,
  run,
  waitTimeoutMs = Number.POSITIVE_INFINITY,
}: GenerationLockOptions<T>) => {
  const opened = Result.try(() => {
    mkdirSync(path.dirname(lockPath), { recursive: true });
    return new Database(lockPath, { create: true });
  });
  if (opened.isErr()) {
    return opened;
  }
  const database = opened.value;
  const deadline = performance.now() + waitTimeoutMs;
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
      if (performance.now() >= deadline) {
        return Result.err(
          new GenerationLockTimeoutError({
            message: "Timed out waiting for the generation lock.",
          }),
        );
      }
      await Bun.sleep(LOCK_POLL_MS);
    }
    return await Result.tryPromise(async () => await run());
  } finally {
    database.close(true);
  }
};
