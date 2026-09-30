import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { withActionAdmission } from "./action-admission";

const organizationId = toSafeId<"organization">("background_org");
const userId = toSafeId<"user">("background_user");
const policy = {
  organizationConcurrency: 2,
  userConcurrency: 2,
  leaseMs: 120_000,
};

describe("background action admission", () => {
  test("uses its separate two-key pool without period accounting", async () => {
    const calls: string[][] = [];
    const redis = {
      send: async (_command: string, args: string[]) => {
        calls.push(args);
        return 1;
      },
    };

    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      execution: "background-job",
      periodPolicy: { periodMs: 86_400_000, limit: 1 },
      redis,
      run: async () => "done",
    });

    expect(result).toEqual(Result.ok("done"));
    const acquire = calls.find((args) =>
      args.at(0)?.includes("ZREMRANGEBYSCORE"),
    );
    expect(acquire?.at(1)).toBe("2");
    expect(acquire?.at(2)).toContain("background:organization");
    expect(acquire?.at(3)).toContain("background:user:");
    expect(acquire?.some((arg) => arg.includes(":period:"))).toBe(false);
  });

  test("a queued kickoff nested inside interactive admission acquires a fresh lease", async () => {
    const acquisitions: string[][] = [];
    const redis = {
      send: async (_command: string, args: string[]) => {
        if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
          acquisitions.push(args);
        }
        return 1;
      },
    };
    const periodIdentity = {
      actionKind: "workflow.start",
      logicalPhaseId: "server-run-1",
    };
    const periodPolicy = { periodMs: 86_400_000, limit: 10 };

    const outer = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      redis,
      run: async () =>
        await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          execution: "queued-kickoff",
          periodIdentity,
          periodPolicy,
          redis,
          run: async () => "queued",
        }),
    });

    expect(Result.isOk(outer)).toBe(true);
    if (Result.isOk(outer)) {
      expect(outer.value).toEqual(Result.ok("queued"));
    }
    expect(acquisitions).toHaveLength(2);
    expect(acquisitions.at(0)?.at(2)).not.toContain("background:");
    expect(acquisitions.at(1)?.at(2)).not.toContain("background:");
  });

  test("an explicit background job nested inside the same pool acquires a fresh lease", async () => {
    const acquisitions: string[][] = [];
    const redis = {
      send: async (_command: string, args: string[]) => {
        if (args.at(0)?.includes("ZREMRANGEBYSCORE")) {
          acquisitions.push(args);
        }
        return 1;
      },
    };

    const outer = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      execution: "background-job",
      redis,
      run: async () =>
        await withActionAdmission({
          organizationId,
          userId,
          enabled: true,
          policy,
          execution: "background-job",
          redis,
          run: async () => "nested background",
        }),
    });

    expect(Result.isOk(outer)).toBe(true);
    if (Result.isOk(outer)) {
      expect(outer.value).toEqual(Result.ok("nested background"));
    }
    expect(acquisitions).toHaveLength(2);
    expect(
      acquisitions.every((args) =>
        args.at(2)?.includes("background:organization"),
      ),
    ).toBe(true);
  });

  test("queued kickoff fails closed without a configured period", async () => {
    let ran = false;
    const result = await withActionAdmission({
      organizationId,
      userId,
      enabled: true,
      policy,
      execution: "queued-kickoff",
      periodIdentity: {
        actionKind: "workflow.start",
        logicalPhaseId: "server-run-1",
      },
      redisReady: async () => {
        throw new Error("admission store should not be opened");
      },
      run: async () => {
        ran = true;
      },
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isError(result)) {
      expect(result.error).toMatchObject({ reason: "unavailable" });
    }
    expect(ran).toBe(false);
  });
});
