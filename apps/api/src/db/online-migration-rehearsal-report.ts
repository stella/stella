import { panic, Result } from "better-result";
import {
  accessSync,
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import nodePath from "node:path";

import type { OnlineRepairRehearsalRecord } from "./online-migration-rehearsal-guard";

const assertDestinationMissing = (destination: string): void => {
  // lstat also catches dangling symlinks, which an existence check follows.
  if (lstatSync(destination, { throwIfNoEntry: false }) !== undefined) {
    panic("Online repair rehearsal report destination already exists");
  }
};

/** Validate before connecting; publish only after the upgrade and coverage pass. */
export const prepareOnlineRepairRehearsalReport = (report: string) => {
  const destination = nodePath.resolve(report);
  const parent = nodePath.dirname(destination);
  assertDestinationMissing(destination);
  if (!statSync(parent).isDirectory()) {
    panic("Online repair rehearsal report parent must be a directory");
  }
  accessSync(parent, constants.W_OK);
  accessSync(parent, constants.X_OK);

  return {
    publish: (records: readonly OnlineRepairRehearsalRecord[]): void => {
      assertDestinationMissing(destination);
      const stage = nodePath.join(
        parent,
        `.${nodePath.basename(destination)}.${Bun.randomUUIDv7()}.tmp`,
      );
      const descriptor = openSync(stage, "wx", 0o600);
      const publication = Result.try({
        try: () => {
          try {
            writeFileSync(
              descriptor,
              `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
            );
            fsyncSync(descriptor);
          } finally {
            closeSync(descriptor);
          }
          // A same-filesystem hard link publishes the complete file atomically;
          // unlike rename, it cannot replace a competing file or follow a symlink.
          linkSync(stage, destination);
        },
        catch: (error: unknown) => error,
      });
      const cleanup = Result.try({
        try: () => unlinkSync(stage),
        catch: (error: unknown) => error,
      });
      if (Result.isError(cleanup)) {
        // A cleanup failure must not leave our successful-looking receipt.
        if (Result.isOk(publication)) {
          unlinkSync(destination);
        }
        throw cleanup.error;
      }
      if (Result.isError(publication)) {
        throw publication.error;
      }
    },
  };
};
