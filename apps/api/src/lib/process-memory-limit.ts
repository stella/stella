import { readFileSync } from "node:fs";

import { LIMITS } from "@/api/lib/limits";

/** cgroup v2 first, then v1; the first readable file wins. */
const CGROUP_MEMORY_LIMIT_FILES = [
  "/sys/fs/cgroup/memory.max",
  "/sys/fs/cgroup/memory/memory.limit_in_bytes",
] as const;

/**
 * Limits at or above this are "no limit": cgroup v1 reports an unlimited
 * group as a page-aligned near-`2^63`, and no host this runs on has 1 PiB.
 */
const UNLIMITED_FLOOR_BYTES = 2 ** 50;

/** Returns a file's text, or `null` when it cannot be read. */
export type LimitFileReader = (path: string) => string | null;

const readLimitFile: LimitFileReader = (path) => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
};

/**
 * The memory limit the process's control group enforces, in bytes, or `null`
 * when none is readable or the group is unlimited. A container without a
 * limit of its own sees its task's limit here.
 */
export const readCgroupMemoryLimitBytes = (
  read: LimitFileReader = readLimitFile,
): number | null => {
  for (const path of CGROUP_MEMORY_LIMIT_FILES) {
    const text = read(path)?.trim();
    if (text === undefined || text === "") {
      continue;
    }
    if (text === "max") {
      return null;
    }
    const bytes = Number(text);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
      // Includes v1's unlimited sentinel, which is past 2^53.
      return null;
    }
    return bytes >= UNLIMITED_FLOOR_BYTES ? null : bytes;
  }
  return null;
};

/**
 * Resident set size at which the derivative worker defers jobs: a fraction
 * of the enforced memory limit, so it scales with the task size, or a fixed
 * fallback where no limit can be read.
 */
export const derivativeDeferRssBytes = (limitBytes: number | null): number =>
  limitBytes === null
    ? LIMITS.fileDerivativeDeferRssFallbackBytes
    : Math.floor(limitBytes * LIMITS.fileDerivativeDeferMemoryFraction);
