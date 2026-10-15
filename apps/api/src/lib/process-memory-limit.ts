import { readFileSync } from "node:fs";

import { LIMITS } from "@/api/lib/limits";

const CGROUP_MEMBERSHIP_FILE = "/proc/self/cgroup";
const CGROUP_V2_MOUNT = "/sys/fs/cgroup";
const CGROUP_V1_MEMORY_MOUNT = "/sys/fs/cgroup/memory";

/** Directory levels walked from a group to the hierarchy root. */
const CGROUP_DEPTH_MAX = 64;

/**
 * Limits at or above this are "no limit": cgroup v1 reports an unlimited
 * group as a page-aligned near-`2^63`, and no host this runs on has 1 PiB.
 */
const UNLIMITED_FLOOR_BYTES = 2n ** 50n;

const DECIMAL_PATTERN = /^\d+$/u;
const HIERARCHICAL_LIMIT_PATTERN =
  /^hierarchical_memory_limit (?<bytes>\d+)$/mu;

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
 * The memory limit that applies to this process. `unlimited` means at least
 * one level was read and none of them is finite; `unreadable` means no level
 * could be read at all.
 */
export type ProcessMemoryLimit =
  | { type: "limited"; bytes: number }
  | { type: "unlimited" }
  | { type: "unreadable" };

type LevelLimit = { type: "limited"; bytes: number } | { type: "unlimited" };

/** One limit file's value: `max` or a number at or past the floor is unlimited. */
const parseLimit = (text: string | null | undefined): LevelLimit | null => {
  const value = text?.trim();
  if (value === undefined || value === "") {
    return null;
  }
  if (value === "max") {
    return { type: "unlimited" };
  }
  if (!DECIMAL_PATTERN.test(value)) {
    return null;
  }
  const bytes = BigInt(value);
  if (bytes >= UNLIMITED_FLOOR_BYTES) {
    return { type: "unlimited" };
  }
  return bytes > 0n ? { type: "limited", bytes: Number(bytes) } : null;
};

/** The group directory and every ancestor up to (and including) `mount`. */
const groupAndAncestors = (mount: string, groupPath: string): string[] => {
  const segments = groupPath.split("/").filter((segment) => segment !== "");
  const directories: string[] = [];
  for (
    let depth = Math.min(segments.length, CGROUP_DEPTH_MAX);
    depth >= 0;
    depth -= 1
  ) {
    directories.push([mount, ...segments.slice(0, depth)].join("/"));
  }
  return directories;
};

/**
 * The membership path of this process in the v2 hierarchy (`0::<path>`) and
 * in the v1 memory controller (`<id>:<controllers incl. memory>:<path>`).
 * Without a membership file both default to the root, so the mounts' own
 * files (a namespaced group's own view) are still read.
 */
const readMembership = (read: LimitFileReader): { v1: string; v2: string } => {
  const membership = { v1: "/", v2: "/" };
  for (const line of (read(CGROUP_MEMBERSHIP_FILE) ?? "").split("\n")) {
    // `<id>:<controllers>:<path>`; the path itself may contain `:`.
    const afterId = line.indexOf(":");
    const afterControllers = line.indexOf(":", afterId + 1);
    if (afterId === -1 || afterControllers === -1) {
      continue;
    }
    const controllers = line.slice(afterId + 1, afterControllers);
    const path = line.slice(afterControllers + 1).trim();
    if (controllers === "") {
      membership.v2 = path;
    } else if (controllers.split(",").includes("memory")) {
      membership.v1 = path;
    }
  }
  return membership;
};

/** Fold the levels read into the effective limit: the smallest finite one. */
const effectiveLimit = (levels: readonly LevelLimit[]): ProcessMemoryLimit => {
  let smallest: number | null = null;
  for (const level of levels) {
    if (
      level.type === "limited" &&
      (smallest === null || level.bytes < smallest)
    ) {
      smallest = level.bytes;
    }
  }
  if (smallest !== null) {
    return { type: "limited", bytes: smallest };
  }
  return levels.length > 0 ? { type: "unlimited" } : { type: "unreadable" };
};

/**
 * The memory limit the kernel enforces on this process. A group's own
 * `memory.max` of `max` only means it sets no limit itself; an ancestor's
 * finite limit still applies, so the group and every ancestor are read and
 * the smallest finite limit wins (v2 `memory.max`; v1 `memory.limit_in_bytes`
 * plus `hierarchical_memory_limit` from `memory.stat`).
 */
export const readProcessMemoryLimit = (
  read: LimitFileReader = readLimitFile,
): ProcessMemoryLimit => {
  const membership = readMembership(read);
  const levels: LevelLimit[] = [];
  const collect = (level: LevelLimit | null) => {
    if (level !== null) {
      levels.push(level);
    }
  };
  for (const directory of groupAndAncestors(CGROUP_V2_MOUNT, membership.v2)) {
    collect(parseLimit(read(`${directory}/memory.max`)));
  }
  for (const directory of groupAndAncestors(
    CGROUP_V1_MEMORY_MOUNT,
    membership.v1,
  )) {
    collect(parseLimit(read(`${directory}/memory.limit_in_bytes`)));
    collect(
      parseLimit(
        HIERARCHICAL_LIMIT_PATTERN.exec(read(`${directory}/memory.stat`) ?? "")
          ?.groups?.["bytes"],
      ),
    );
  }
  return effectiveLimit(levels);
};

/**
 * Resident set size at which the derivative worker defers jobs: a fraction
 * of the enforced memory limit, so it scales with the memory the process
 * actually has, or a fixed fallback where no finite limit applies or none
 * can be read.
 */
export const derivativeDeferRssBytes = (limit: ProcessMemoryLimit): number =>
  limit.type === "limited"
    ? Math.floor(limit.bytes * LIMITS.fileDerivativeDeferMemoryFraction)
    : LIMITS.fileDerivativeDeferRssFallbackBytes;
