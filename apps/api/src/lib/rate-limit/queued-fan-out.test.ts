import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { drainFanOut } from "@stll/concurrency";

import { toSafeId } from "@/api/lib/branded-types";

import { withActionAdmission } from "./action-admission";

const organizationId = toSafeId<"organization">("fanout_org");
const userId = toSafeId<"user">("fanout_user");
const policy = {
  organizationConcurrency: 1,
  userConcurrency: 1,
  leaseMs: 120_000,
};

const deferred = () => {
  const { promise, resolve } = Promise.withResolvers<undefined>();
  return { promise, resolve: () => resolve(undefined) };
};

describe("queued fan-out admission ownership", () => {
  test("retains the background slot until every aborted sibling finishes cleanup", async () => {
    const members = new Map<string, Set<string>>();
    let releases = 0;
    const redis = {
      send: async (_command: string, args: string[]) => {
        const script = args.at(0) ?? "";
        const organizationKey = args.at(2);
        const userKey = args.at(3);
        if (organizationKey === undefined || userKey === undefined) {
          throw new Error("Expected both action admission keys");
        }
        const organization = members.get(organizationKey) ?? new Set<string>();
        const user = members.get(userKey) ?? new Set<string>();
        members.set(organizationKey, organization);
        members.set(userKey, user);

        if (script.includes("ZREMRANGEBYSCORE")) {
          const leaseId = args.at(7);
          if (leaseId === undefined) {
            throw new Error("Expected lease ID in acquisition arguments");
          }
          if (organization.size >= 1 || user.size >= 1) {
            return 0;
          }
          organization.add(leaseId);
          user.add(leaseId);
          return 1;
        }
        if (script.includes("ZSCORE")) {
          const leaseId = args.at(4);
          return leaseId !== undefined &&
            organization.has(leaseId) &&
            user.has(leaseId)
            ? 1
            : 0;
        }
        if (script.includes("ZREM")) {
          releases += 1;
          const leaseId = args.at(4);
          if (leaseId !== undefined) {
            organization.delete(leaseId);
            user.delete(leaseId);
          }
          return 1;
        }
        throw new Error("Unexpected admission command");
      },
    };
    const timing = {
      now: () => 0,
      schedule: () => () => undefined,
    };
    const siblingStarted = deferred();
    const siblingAborted = deferred();
    const finishSiblingCleanup = deferred();
    const firstFailure = new Error("first fan-out operation failed");
    const parent = new AbortController();

    const withBackgroundLease = async <T>(
      signal: AbortSignal,
      run: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const admitted = await withActionAdmission({
        organizationId,
        userId,
        enabled: true,
        policy,
        execution: "background-job",
        redis,
        timing,
        run: async (leaseSignal) =>
          await run(AbortSignal.any([signal, leaseSignal])),
      });
      if (Result.isError(admitted)) {
        throw admitted.error;
      }
      return admitted.value;
    };

    const fanOut = withBackgroundLease(
      parent.signal,
      async (admissionSignal) => {
        const drained = await drainFanOut({
          items: ["fails", "cleans-up"],
          signal: admissionSignal,
          operation: async (item, signal) => {
            if (item === "fails") {
              await siblingStarted.promise;
              throw firstFailure;
            }

            signal.addEventListener("abort", siblingAborted.resolve, {
              once: true,
            });
            siblingStarted.resolve();
            await finishSiblingCleanup.promise;
            return "cleaned";
          },
        });
        if (Result.isError(drained)) {
          throw drained.error;
        }
        return drained.value;
      },
    );

    await siblingAborted.promise;
    expect(releases).toBe(0);

    let thirdHandlerRan = false;
    const contending = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      execution: "background-job",
      redis,
      timing,
      run: async () => {
        thirdHandlerRan = true;
      },
    });
    expect(Result.isError(contending)).toBe(true);
    if (Result.isError(contending)) {
      expect(contending.error).toMatchObject({ reason: "busy" });
    }
    expect(thirdHandlerRan).toBe(false);
    expect(releases).toBe(0);

    finishSiblingCleanup.resolve();
    await expect(fanOut).rejects.toBe(firstFailure);
    expect(releases).toBe(1);

    const third = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      execution: "background-job",
      redis,
      timing,
      run: async () => "next job",
    });
    expect(third).toEqual(Result.ok("next job"));
    expect(releases).toBe(2);
  });
});
