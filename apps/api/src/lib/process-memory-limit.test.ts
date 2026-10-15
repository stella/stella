import { describe, expect, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";
import {
  derivativeDeferRssBytes,
  readCgroupMemoryLimitBytes,
} from "@/api/lib/process-memory-limit";
import type { LimitFileReader } from "@/api/lib/process-memory-limit";

const V2 = "/sys/fs/cgroup/memory.max";
const V1 = "/sys/fs/cgroup/memory/memory.limit_in_bytes";
const GIB = 1024 * 1024 * 1024;

const files =
  (contents: Readonly<Record<string, string>>): LimitFileReader =>
  (path) =>
    contents[path] ?? null;

describe("process memory limit", () => {
  test("reads a cgroup v2 limit", () => {
    expect(readCgroupMemoryLimitBytes(files({ [V2]: `${4 * GIB}\n` }))).toBe(
      4 * GIB,
    );
  });

  test("falls back to the cgroup v1 file when v2 is absent", () => {
    expect(readCgroupMemoryLimitBytes(files({ [V1]: `${2 * GIB}\n` }))).toBe(
      2 * GIB,
    );
  });

  test.each([
    ["v2 max", { [V2]: "max\n" }],
    ["v1 unlimited sentinel", { [V1]: "9223372036854771712\n" }],
    ["implausibly large", { [V2]: String(2 ** 51) }],
  ] as const)("%s reads as unlimited", (_name, contents) => {
    expect(readCgroupMemoryLimitBytes(files(contents))).toBeNull();
  });

  test.each([
    ["no file", {}],
    ["empty", { [V2]: "" }],
    ["garbage", { [V2]: "lots" }],
    ["zero", { [V2]: "0" }],
  ] as const)("an unreadable limit (%s) reads as none", (_name, contents) => {
    expect(readCgroupMemoryLimitBytes(files(contents))).toBeNull();
  });
});

describe("derivative defer threshold", () => {
  test("is a fraction of the enforced limit, so it follows the task size", () => {
    const fraction = LIMITS.fileDerivativeDeferMemoryFraction;
    expect(derivativeDeferRssBytes(2 * GIB)).toBe(
      Math.floor(2 * GIB * fraction),
    );
    expect(derivativeDeferRssBytes(4 * GIB)).toBe(
      Math.floor(4 * GIB * fraction),
    );
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);
  });

  test("uses the fixed fallback only without a readable limit", () => {
    expect(derivativeDeferRssBytes(null)).toBe(
      LIMITS.fileDerivativeDeferRssFallbackBytes,
    );
  });
});
