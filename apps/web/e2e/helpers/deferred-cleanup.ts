import { panic, Result } from "better-result";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import * as v from "valibot";

const CLEANUP_DIRECTORY = "route-smoke-cleanup";
const CLEANUP_RECORD_EXTENSION = ".json";
const CLEANUP_TEMP_EXTENSION = ".tmp";

export const E2E_CLEANUP_TARGET_TYPE = {
  CONTACT: "contact",
  WORKSPACE: "workspace",
} as const;

const cleanupTargetSchema = v.variant("type", [
  v.object({
    type: v.literal(E2E_CLEANUP_TARGET_TYPE.CONTACT),
    id: v.pipe(v.string(), v.uuid()),
  }),
  v.object({
    type: v.literal(E2E_CLEANUP_TARGET_TYPE.WORKSPACE),
    id: v.pipe(v.string(), v.uuid()),
  }),
]);

export type E2eCleanupTarget = v.InferOutput<typeof cleanupTargetSchema>;

export type E2eCleanupReadResult = {
  failures: unknown[];
  targets: E2eCleanupTarget[];
};

const cleanupDirectory = (outputDirectory: string): string =>
  path.join(outputDirectory, CLEANUP_DIRECTORY);

export const registerDeferredE2eCleanup = async (
  outputDirectory: string,
  target: E2eCleanupTarget,
): Promise<void> => {
  const directory = cleanupDirectory(outputDirectory);
  await mkdir(directory, { recursive: true });
  const recordId = randomUUID();
  const temporaryPath = path.join(
    directory,
    `${recordId}${CLEANUP_TEMP_EXTENSION}`,
  );
  const recordPath = path.join(
    directory,
    `${recordId}${CLEANUP_RECORD_EXTENSION}`,
  );
  const published = await Result.tryPromise(async () => {
    await writeFile(temporaryPath, `${JSON.stringify(target)}\n`, {
      encoding: "utf-8",
      flag: "wx",
    });
    await rename(temporaryPath, recordPath);
  });
  if (Result.isOk(published)) {
    return;
  }

  const rolledBack = await Result.tryPromise(async () => {
    await rm(temporaryPath, { force: true });
  });
  if (Result.isError(rolledBack)) {
    throw new AggregateError(
      [published.error.cause, rolledBack.error.cause],
      "Deferred E2E cleanup registration and rollback failed",
    );
  }
  throw published.error.cause;
};

export const readDeferredE2eCleanup = async (
  outputDirectory: string,
): Promise<E2eCleanupReadResult> => {
  const directory = cleanupDirectory(outputDirectory);
  if (!existsSync(directory)) {
    return { failures: [], targets: [] };
  }
  const entries = await readdir(directory, {
    encoding: "utf-8",
    withFileTypes: true,
  });

  const results = await Promise.allSettled(
    entries.map(async (entry) => {
      if (
        !(
          entry.isFile() &&
          (entry.name.endsWith(CLEANUP_RECORD_EXTENSION) ||
            entry.name.endsWith(CLEANUP_TEMP_EXTENSION))
        )
      ) {
        return panic(`Unexpected deferred E2E cleanup entry: ${entry.name}`);
      }

      const serialized = await readFile(
        path.join(directory, entry.name),
        "utf-8",
      );
      const input = Result.try((): unknown => JSON.parse(serialized));
      if (Result.isError(input)) {
        return panic(`Invalid deferred E2E cleanup target: ${entry.name}`);
      }

      const parsed = v.safeParse(cleanupTargetSchema, input.value);
      if (!parsed.success) {
        return panic(`Invalid deferred E2E cleanup target: ${entry.name}`);
      }
      return parsed.output;
    }),
  );

  const failures: unknown[] = [];
  const targets: E2eCleanupTarget[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      targets.push(result.value);
      continue;
    }
    const reason: unknown = result.reason;
    failures.push(reason);
  }
  return { failures, targets };
};

export const clearDeferredE2eCleanup = async (
  outputDirectory: string,
): Promise<void> => {
  const directory = cleanupDirectory(outputDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) {
        panic(`Unexpected deferred E2E cleanup entry: ${entry.name}`);
      }
      await unlink(path.join(directory, entry.name));
    }),
  );
  await rmdir(directory);
};
