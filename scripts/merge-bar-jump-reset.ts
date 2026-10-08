import { Result, TaggedError } from "better-result";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { sha256Hex } from "../packages/sha256/src/node.ts";

// Queue cancellations within ten minutes of an accepted jump are correlated
// only within one repository. Real failures and incomplete jobs fail closed.
export const JUMP_RESET_WINDOW_MS = 10 * 60 * 1000;

export type JumpRecord = {
  repo: string;
  pr: number;
  head: string;
  at: string;
};

type CancelledJob = {
  conclusion: string | null;
  completedAt: string | null;
};

export type JumpResetEvidence =
  | { type: "unavailable" }
  | {
      type: "complete";
      jobs: readonly CancelledJob[];
      // Only GitHub's dequeue/cancellation reason, never a title or run name.
      cancellationReason: string | null;
    };

type ClassifyJumpResetOptions = {
  repo: string;
  evidence: JumpResetEvidence;
  jumps: readonly JumpRecord[];
};

export type JumpResetClassification =
  | { type: "not-reset" }
  | { type: "JUMP_RESET"; cause: "jump-record"; jump: JumpRecord }
  | { type: "JUMP_RESET"; cause: "priority-reason" };

export const classifyJumpReset = ({
  repo,
  evidence,
  jumps,
}: ClassifyJumpResetOptions): JumpResetClassification => {
  if (evidence.type === "unavailable") {
    return { type: "not-reset" };
  }
  const jobs = evidence.jobs.filter((job) => job.conclusion !== "skipped");
  if (!jobs.length || jobs.some((job) => job.conclusion !== "cancelled")) {
    return { type: "not-reset" };
  }
  const cancellations = jobs.map((job) => Date.parse(job.completedAt ?? ""));
  if (cancellations.some((at) => !Number.isFinite(at))) {
    return { type: "not-reset" };
  }
  const recent = jumps
    .filter((jump) => {
      const at = Date.parse(jump.at);
      return (
        jump.repo.toLowerCase() === repo.toLowerCase() &&
        Number.isFinite(at) &&
        cancellations.every(
          (cancelledAt) =>
            cancelledAt >= at && cancelledAt - at <= JUMP_RESET_WINDOW_MS,
        )
      );
    })
    .toSorted((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .at(0);
  if (recent) {
    return { type: "JUMP_RESET", cause: "jump-record", jump: recent };
  }
  if (
    /\bhigher[- ]priority (?:waiting )?request\b/iu.test(
      evidence.cancellationReason ?? "",
    )
  ) {
    return { type: "JUMP_RESET", cause: "priority-reason" };
  }
  return { type: "not-reset" };
};

export class JumpResetError extends TaggedError("JumpResetError")<{
  message: string;
}> {}

const validJumpRecord = (value: unknown): value is JumpRecord => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return (
    "repo" in value &&
    typeof value.repo === "string" &&
    "pr" in value &&
    typeof value.pr === "number" &&
    Number.isSafeInteger(value.pr) &&
    value.pr > 0 &&
    "head" in value &&
    typeof value.head === "string" &&
    /^[a-f0-9]{40}$/u.test(value.head) &&
    "at" in value &&
    typeof value.at === "string" &&
    Number.isFinite(Date.parse(value.at))
  );
};

/** Reservations survive uncertain mutations; a second attempt requires a new head. */
export const createJumpResetStore = (directory: string) => {
  const durableCreate = (filename: string, body: string) => {
    const created = mkdirSync(path.dirname(filename), { recursive: true });
    const descriptor = openSync(filename, "wx", 0o600);
    try {
      writeFileSync(descriptor, body);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    const parent = openSync(path.dirname(filename), "r");
    try {
      fsyncSync(parent);
    } finally {
      closeSync(parent);
    }
    if (created !== undefined) {
      let ancestor = path.dirname(filename);
      const stop = path.dirname(created);
      while (ancestor !== stop) {
        ancestor = path.dirname(ancestor);
        const ancestorDescriptor = openSync(ancestor, "r");
        try {
          fsyncSync(ancestorDescriptor);
        } finally {
          closeSync(ancestorDescriptor);
        }
      }
    }
  };
  const wrap = <T>(operation: () => T) =>
    Result.try({
      try: operation,
      catch: (cause) =>
        new JumpResetError({
          message: `Jump reset state unavailable: ${String(cause)}`,
        }),
    });
  const reservationPath = (key: string) =>
    path.join(directory, "rearms", sha256Hex(key));
  return {
    readJumps: () =>
      wrap(() => {
        const jumps = path.join(directory, "jumps");
        if (!existsSync(jumps)) {
          return [];
        }
        return readdirSync(jumps).map((name) => {
          const value: unknown = JSON.parse(
            readFileSync(path.join(jumps, name), "utf-8"),
          );
          if (!validJumpRecord(value)) {
            throw new JumpResetError({ message: "Invalid jump record" });
          }
          return value;
        });
      }),
    recordJump: (record: JumpRecord) =>
      wrap(() => {
        if (!validJumpRecord(record)) {
          throw new JumpResetError({ message: "Invalid jump record" });
        }
        const body = JSON.stringify(record);
        const filename = path.join(directory, "jumps", sha256Hex(body));
        if (existsSync(filename)) {
          if (readFileSync(filename, "utf-8") !== body) {
            throw new JumpResetError({ message: "Conflicting jump record" });
          }
          return;
        }
        durableCreate(filename, body);
      }),
    hasReservation: (key: string) =>
      wrap(() => existsSync(reservationPath(key))),
    reserve: (key: string) =>
      wrap(() => durableCreate(reservationPath(key), key)),
  };
};
