import { describe, expect, test } from "bun:test";

import { LIMITS } from "@/api/lib/limits";
import {
  derivativeDeferRssBytes,
  readProcessMemoryLimit,
} from "@/api/lib/observability/process-memory-limit";
import type { LimitFileReader } from "@/api/lib/observability/process-memory-limit";

const GIB = 1024 * 1024 * 1024;
const MEMBERSHIP = "/proc/self/cgroup";
const V2 = "/sys/fs/cgroup";
const V1 = "/sys/fs/cgroup/memory";
const V1_UNLIMITED = "9223372036854771712";

const files =
  (contents: Readonly<Record<string, string>>): LimitFileReader =>
  (path) =>
    contents[path] ?? null;

describe("process memory limit (cgroup v2)", () => {
  const member = { [MEMBERSHIP]: "0::/service/app/worker\n" };

  test("an unlimited group under a finite parent gets the parent's limit", () => {
    expect(
      readProcessMemoryLimit(
        files({
          ...member,
          [`${V2}/service/app/worker/memory.max`]: "max\n",
          [`${V2}/service/app/memory.max`]: `${4 * GIB}\n`,
          [`${V2}/service/memory.max`]: "max\n",
        }),
      ),
    ).toEqual({ type: "limited", bytes: 4 * GIB });
  });

  test("a finite group under a smaller ancestor gets the smaller limit", () => {
    expect(
      readProcessMemoryLimit(
        files({
          ...member,
          [`${V2}/service/app/worker/memory.max`]: `${3 * GIB}\n`,
          [`${V2}/service/memory.max`]: `${2 * GIB}\n`,
        }),
      ),
    ).toEqual({ type: "limited", bytes: 2 * GIB });
  });

  test("every level unlimited is unlimited", () => {
    expect(
      readProcessMemoryLimit(
        files({
          ...member,
          [`${V2}/service/app/worker/memory.max`]: "max\n",
          [`${V2}/service/app/memory.max`]: "max\n",
          [`${V2}/service/memory.max`]: "max",
        }),
      ),
    ).toEqual({ type: "unlimited" });
  });

  test("a namespaced view still reads the mount's own limit", () => {
    // The membership path is not visible under the mount; its root is the group.
    expect(
      readProcessMemoryLimit(
        files({
          [MEMBERSHIP]: "0::/\n",
          [`${V2}/memory.max`]: `${2 * GIB}\n`,
        }),
      ),
    ).toEqual({ type: "limited", bytes: 2 * GIB });
  });
});

describe("process memory limit (cgroup v1)", () => {
  const member = {
    [MEMBERSHIP]: "12:cpu,cpuacct:/other\n4:memory:/service/app\n",
  };

  test("the hierarchical limit from memory.stat bounds an unlimited group", () => {
    expect(
      readProcessMemoryLimit(
        files({
          ...member,
          [`${V1}/service/app/memory.limit_in_bytes`]: V1_UNLIMITED,
          [`${V1}/service/app/memory.stat`]: `cache 1\nhierarchical_memory_limit ${2 * GIB}\nrss 2\n`,
        }),
      ),
    ).toEqual({ type: "limited", bytes: 2 * GIB });
  });

  test("an ancestor's smaller limit applies", () => {
    expect(
      readProcessMemoryLimit(
        files({
          ...member,
          [`${V1}/service/app/memory.limit_in_bytes`]: `${8 * GIB}`,
          [`${V1}/memory.limit_in_bytes`]: `${GIB}`,
        }),
      ),
    ).toEqual({ type: "limited", bytes: GIB });
  });

  test("the v1 unlimited sentinel at every level is unlimited", () => {
    expect(
      readProcessMemoryLimit(
        files({
          ...member,
          [`${V1}/service/app/memory.limit_in_bytes`]: V1_UNLIMITED,
          [`${V1}/memory.limit_in_bytes`]: V1_UNLIMITED,
        }),
      ),
    ).toEqual({ type: "unlimited" });
  });
});

describe("process memory limit (unreadable)", () => {
  test.each([
    ["nothing readable", {}],
    ["membership only", { [MEMBERSHIP]: "0::/service\n" }],
    [
      "garbage values",
      { [`${V2}/memory.max`]: "lots", [`${V1}/memory.limit_in_bytes`]: "0" },
    ],
  ] as const)("%s reads as unreadable", (_name, contents) => {
    expect(readProcessMemoryLimit(files(contents))).toEqual({
      type: "unreadable",
    });
  });
});

describe("derivative defer threshold", () => {
  test("is a fraction of the effective limit, so it follows the memory available", () => {
    const fraction = LIMITS.fileDerivativeDeferMemoryFraction;
    expect(derivativeDeferRssBytes({ type: "limited", bytes: 2 * GIB })).toBe(
      Math.floor(2 * GIB * fraction),
    );
    expect(derivativeDeferRssBytes({ type: "limited", bytes: 4 * GIB })).toBe(
      Math.floor(4 * GIB * fraction),
    );
    expect(fraction).toBeGreaterThan(0);
    expect(fraction).toBeLessThan(1);
  });

  test.each([{ type: "unlimited" }, { type: "unreadable" }] as const)(
    "uses the fixed fallback when the limit is $type",
    (limit) => {
      expect(derivativeDeferRssBytes(limit)).toBe(
        LIMITS.fileDerivativeDeferRssFallbackBytes,
      );
    },
  );
});
