import { panic, Result, TaggedError } from "better-result";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { sha256Hex } from "../packages/sha256/src/node.ts";

export class BranchUpdateError extends TaggedError("BranchUpdateError")<{
  message: string;
}> {}

type BranchUpdateSnapshot = {
  state: string;
  headSha: string;
  headRepository: string | null;
  baseRepository: string;
};

type BranchUpdateResponse =
  | { type: "accepted" }
  | { type: "rejected"; message: string }
  | { type: "unknown"; message: string };

type BranchUpdateStore = {
  recorded: (key: string) => Result<boolean, BranchUpdateError>;
  acquire: (key: string) => Result<{ release: () => void }, BranchUpdateError>;
  record: (key: string) => void;
};

type UpdatePullRequestBranchOptions = {
  repo: string;
  pullNumber: number;
  expectedHeadSha: string;
  dryRun: boolean;
  readPullRequest: () => BranchUpdateSnapshot;
  update: (expectedHeadSha: string) => BranchUpdateResponse;
  store: BranchUpdateStore;
};

/** Pin the update to one same-repository head, with a durable accepted receipt. */
export const updatePullRequestBranch = ({
  repo,
  pullNumber,
  expectedHeadSha,
  dryRun,
  readPullRequest,
  update,
  store,
}: UpdatePullRequestBranchOptions) =>
  Result.try(() => {
    const key = `${repo.toLowerCase()}#${pullNumber}@${expectedHeadSha}`;
    const recorded = store.recorded(key);
    if (recorded.isErr()) {
      return recorded;
    }
    if (recorded.value) {
      return Result.ok({ status: "already-updated", key } as const);
    }
    const current = readPullRequest();
    if (
      current.headRepository?.toLowerCase() !== repo.toLowerCase() ||
      current.baseRepository.toLowerCase() !== repo.toLowerCase()
    ) {
      return Result.err(
        new BranchUpdateError({
          message:
            "NOT UPDATED: head and base must belong to the requested repository",
        }),
      );
    }
    if (current.state !== "open" || current.headSha !== expectedHeadSha) {
      return Result.err(
        new BranchUpdateError({
          message: "NOT UPDATED: pull request is closed or its head moved",
        }),
      );
    }
    if (dryRun) {
      return Result.ok({ status: "dry-run", key } as const);
    }
    const lease = store.acquire(key);
    if (lease.isErr()) {
      return lease;
    }
    // Another invocation may have completed between the first read and lock acquisition.
    const recordedAfterAcquire = store.recorded(key);
    if (recordedAfterAcquire.isErr()) {
      return recordedAfterAcquire;
    }
    if (recordedAfterAcquire.value) {
      lease.value.release();
      return Result.ok({ status: "already-updated", key } as const);
    }
    const response = update(expectedHeadSha);
    switch (response.type) {
      case "accepted":
        store.record(key);
        lease.value.release();
        return Result.ok({ status: "update-requested", key } as const);
      case "rejected":
        lease.value.release();
        return Result.err(new BranchUpdateError({ message: response.message }));
      case "unknown":
        // A lost response may follow an accepted write. Retain the lock until
        // the operator reconciles it, rather than issuing the same write twice.
        return Result.err(new BranchUpdateError({ message: response.message }));
      default:
        response satisfies never;
        return panic("Unknown branch-update response");
    }
  })
    .mapError(
      (error) =>
        new BranchUpdateError({ message: `NOT UPDATED: ${error.message}` }),
    )
    .andThen((result) => result);

type BranchUpdateResponseOptions = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

/** The retry wrapper suppresses failed payloads but preserves sanitized status metadata. */
export const branchUpdateResponse = ({
  stdout,
  stderr,
  exitCode,
}: BranchUpdateResponseOptions) => {
  const includedStatus = /^HTTP\/\S+\s+(\d{3})\b/mu.exec(stdout)?.at(1);
  const failureStatus =
    /^GitHub command failed: HTTP (\d{3}), attempt [1-4]\/4 \(exit \d+\)$/mu
      .exec(stderr)
      ?.at(1);
  const status = Number(includedStatus ?? failureStatus);
  if (status === 202) {
    return { type: "accepted" } as const;
  }
  if (status >= 400 && status < 500) {
    return {
      type: "rejected",
      message: `NOT UPDATED: GitHub rejected the update (HTTP ${status}); resolve the rejection before retrying`,
    } as const;
  }
  return {
    type: "unknown",
    message: `NOT UPDATED: update outcome is unknown (gh exit ${exitCode}); reconcile the per-head lock before proceeding`,
  } as const;
};

/** Accepted receipts and crash-persistent locks are separate files. */
export const createBranchUpdateStore = (
  directory: string,
): BranchUpdateStore => {
  const receiptPath = (key: string) =>
    path.join(directory, `${sha256Hex(key)}.json`);
  return {
    recorded: (key) =>
      Result.try(() => {
        const receipt = receiptPath(key);
        if (!existsSync(receipt)) {
          return Result.ok(false);
        }
        const raw: unknown = JSON.parse(readFileSync(receipt, "utf-8"));
        if (
          typeof raw !== "object" ||
          raw === null ||
          !("key" in raw) ||
          raw.key !== key
        ) {
          return Result.err(
            new BranchUpdateError({
              message:
                "Invalid branch-update receipt; refusing a repeated update",
            }),
          );
        }
        return Result.ok(true);
      })
        .mapError(
          (error) =>
            new BranchUpdateError({
              message: `Cannot read branch-update receipt: ${error.message}`,
            }),
        )
        .andThen((result) => result),
    acquire: (key) =>
      Result.try(() => {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const lock = `${receiptPath(key)}.lock`;
        mkdirSync(lock, { mode: 0o700 });
        return { release: () => rmdirSync(lock) };
      }).mapError(
        (error) =>
          new BranchUpdateError({
            message: `NOT UPDATED: cannot acquire the per-head lock (${error.message}); another update may be in flight or need reconciliation`,
          }),
      ),
    record: (key) => {
      const receipt = receiptPath(key);
      const temporary = `${receipt}.${randomUUID()}`;
      const descriptor = openSync(temporary, "wx", 0o600);
      // Leave an incomplete temporary file and lock on failure; neither is an
      // accepted receipt, and neither permits an uncertain write to repeat.
      const written = Result.try(() => {
        writeFileSync(
          descriptor,
          `${JSON.stringify({ key, acceptedAt: new Date().toISOString() })}\n`,
        );
        fsyncSync(descriptor);
      });
      closeSync(descriptor);
      if (written.isErr()) {
        throw new BranchUpdateError({
          message: `Cannot persist branch-update receipt: ${written.error.message}`,
        });
      }
      renameSync(temporary, receipt);
      const parent = openSync(directory, "r");
      const synced = Result.try(() => fsyncSync(parent));
      closeSync(parent);
      if (synced.isErr()) {
        throw new BranchUpdateError({
          message: `Cannot sync branch-update receipt directory: ${synced.error.message}`,
        });
      }
    },
  };
};
