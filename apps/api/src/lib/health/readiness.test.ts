import { describe, expect, test } from "bun:test";

import {
  API_READINESS_DEPENDENCIES,
  READINESS_DEPENDENCY,
  type ReadinessDependency,
  type ReadinessProbes,
  probeObjectStorageReadiness,
  runReadinessProbes,
} from "@/api/lib/health/readiness";

const successfulProbes = (calls: ReadinessDependency[]): ReadinessProbes => ({
  [READINESS_DEPENDENCY.database]: async () => {
    calls.push(READINESS_DEPENDENCY.database);
  },
  [READINESS_DEPENDENCY.documentConverter]: async () => {
    calls.push(READINESS_DEPENDENCY.documentConverter);
  },
  [READINESS_DEPENDENCY.objectStorage]: async () => {
    calls.push(READINESS_DEPENDENCY.objectStorage);
  },
  [READINESS_DEPENDENCY.redis]: async () => {
    calls.push(READINESS_DEPENDENCY.redis);
  },
  [READINESS_DEPENDENCY.scheduledJobs]: async () => {
    calls.push(READINESS_DEPENDENCY.scheduledJobs);
  },
});

describe("API dependency readiness", () => {
  test("provisions a readable marker without requiring bucket listing", async () => {
    const calls: string[] = [];
    let markerExists = false;

    await probeObjectStorageReadiness(
      {
        read: async () => {
          calls.push("read");
          if (!markerExists) {
            throw Object.assign(new Error("Access denied"), {
              name: "AccessDenied",
            });
          }
        },
        write: async () => {
          calls.push("write");
          markerExists = true;
        },
      },
      new AbortController().signal,
    );

    expect(calls).toEqual(["read", "write", "read"]);
  });

  test("reads an existing marker without rewriting it", async () => {
    const calls: string[] = [];
    await probeObjectStorageReadiness(
      {
        read: async () => {
          calls.push("read");
        },
        write: async () => {
          calls.push("write");
        },
      },
      new AbortController().signal,
    );
    expect(calls).toEqual(["read"]);
  });

  test("exercises the declared dependency set in both directions", async () => {
    const calls: ReadinessDependency[] = [];
    expect(await runReadinessProbes(successfulProbes(calls))).toEqual({
      status: "ready",
    });
    expect(calls.toSorted()).toEqual(API_READINESS_DEPENDENCIES.toSorted());
  });

  test.each(API_READINESS_DEPENDENCIES)(
    "reports a failed production dependency: %s",
    async (failedDependency) => {
      const calls: ReadinessDependency[] = [];
      const probes = successfulProbes(calls);
      probes[failedDependency] = async () => {
        calls.push(failedDependency);
        throw new Error("production dependency unavailable");
      };

      expect(await runReadinessProbes(probes)).toEqual({
        status: "not-ready",
        failed: [failedDependency],
      });
      expect(calls.toSorted()).toEqual(API_READINESS_DEPENDENCIES.toSorted());
    },
  );
});
