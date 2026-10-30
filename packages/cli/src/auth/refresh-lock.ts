import { Result } from "better-result";
import { open, unlink } from "node:fs/promises";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

import { TokenRefreshError } from "./errors.js";

const LOCK_WAIT_MS = 15_000;
const LOCK_POLL_MS = 50;

/**
 * The lock covers the re-read, exchange and persistence, across CLI processes.
 * Never steal a lock by age: a suspended owner could still rotate the token.
 * A crashed owner's lock fails closed with an explicit recovery instruction.
 */
export const acquireRefreshLock = async (
  configDir: string,
): Promise<Result<() => Promise<void>, TokenRefreshError>> => {
  const lockPath = path.join(configDir, "credentials.refresh.lock");
  const deadline = performance.now() + LOCK_WAIT_MS;
  while (true) {
    const opened = await Result.tryPromise({
      try: async () => await open(lockPath, "wx", 0o600),
      catch: (cause) => cause,
    });
    if (Result.isOk(opened)) {
      const initialized = await Result.tryPromise(async () => {
        await opened.value.chmod(0o600);
        await opened.value.writeFile(`${process.pid}\n`);
        await opened.value.close();
      });
      if (Result.isError(initialized)) {
        const cleanup = await Result.tryPromise(async () => {
          await opened.value.close();
          await unlink(lockPath);
        });
        return Result.err(
          new TokenRefreshError({
            message: `Could not initialize refresh lock ${lockPath}. Check its permissions and remove it after confirming no stella command is refreshing credentials.`,
            cause: Result.isError(cleanup) ? cleanup.error : initialized.error,
          }),
        );
      }
      return Result.ok(async () => await unlink(lockPath));
    }
    if (
      typeof opened.error !== "object" ||
      opened.error === null ||
      !("code" in opened.error) ||
      opened.error.code !== "EEXIST"
    ) {
      return Result.err(
        new TokenRefreshError({
          message: `Could not acquire refresh lock ${lockPath}. Check that the credential directory is writable.`,
          cause: opened.error,
        }),
      );
    }
    if (performance.now() >= deadline) {
      return Result.err(
        new TokenRefreshError({
          message: `Timed out waiting for refresh lock ${lockPath}. If its owner process (PID recorded in the file) has stopped, remove this lock and retry.`,
        }),
      );
    }
    await setTimeout(LOCK_POLL_MS);
  }
};
