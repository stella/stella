import { describe, expect, test } from "bun:test";

import {
  API_READINESS_DEPENDENCIES,
  READINESS_DEPENDENCY,
  type ReadinessDependency,
  type ReadinessProbes,
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
