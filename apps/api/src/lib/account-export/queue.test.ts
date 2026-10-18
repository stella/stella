import { panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";
import { Temporal } from "@stll/time";

import { AccountExportArchiveError } from "@/api/lib/account-export/archive";
import type { AccountExportDataDb } from "@/api/lib/account-export/pages";
import { processAccountExport } from "@/api/lib/account-export/queue";
import type { AccountExportProcessDeps } from "@/api/lib/account-export/queue";
import type {
  AccountExportClaim,
  AccountExportDb,
} from "@/api/lib/account-export/store";
import { toSafeId } from "@/api/lib/branded-types";

const db = {
  select: () => panic("Injected export worker must not select rows"),
  transaction: async () =>
    panic("Injected export worker must not open transactions"),
} satisfies AccountExportDataDb & AccountExportDb;

const claim = {
  id: "export",
  userId: toSafeId<"user">("queue-account"),
  token: "attempt-token",
  objectKey: "account-exports/attempt.zip",
  leaseExpiresAt: new Date(
    Temporal.Instant.from("2099-01-01T00:00:00Z").epochMilliseconds,
  ),
} satisfies AccountExportClaim;

const fixture = () => {
  const built: string[] = [];
  const deleted: string[][] = [];
  const failures: unknown[] = [];
  const deps = {
    claim: async () => claim,
    build: async ({ objectKey }) => {
      built.push(objectKey);
    },
    complete: async () => true,
    fail: async () => true,
    canReclaim: async () => false,
    deleteObjects: async (keys) => {
      deleted.push(keys);
      return Result.ok();
    },
    capture: (error) => {
      failures.push(error);
    },
  } satisfies AccountExportProcessDeps;
  return { deps, built, deleted, failures };
};

describe("account export worker", () => {
  test("an already expired claim never begins a fresh build", async () => {
    const { deps, built, deleted, failures } = fixture();
    const injected = {
      ...deps,
      claim: async () => ({ ...claim, leaseExpiresAt: new Date(0) }),
      complete: async () => panic("Expired claim must not complete"),
    } satisfies AccountExportProcessDeps;
    const error = await rejectionOf(
      processAccountExport({ id: claim.id, db, deps: injected }),
    );
    expect(error).toBeInstanceOf(AccountExportArchiveError);
    expect(error).toMatchObject({
      message: "Account export lease expired before build",
    });
    expect(built).toEqual([]);
    expect(deleted).toEqual([]);
    expect(failures).toEqual([error]);
  });
  test("replaying an unclaimable export does not rebuild or remove its object", async () => {
    const { deps, built, deleted, failures } = fixture();
    const injected = {
      ...deps,
      claim: async () => null,
    } satisfies AccountExportProcessDeps;
    await processAccountExport({ id: claim.id, db, deps: injected });
    expect(built).toEqual([]);
    expect(deleted).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("a lost completion fence preserves a current winning object", async () => {
    const { deps, built, deleted, failures } = fixture();
    const injected = {
      ...deps,
      complete: async () => false,
      canReclaim: async () => false,
    } satisfies AccountExportProcessDeps;
    await processAccountExport({ id: claim.id, db, deps: injected });
    expect(built).toEqual([claim.objectKey]);
    expect(deleted).toEqual([]);
    expect(failures).toEqual([]);
  });

  test("a revoked attempt removes only its own uploaded key", async () => {
    const { deps, deleted } = fixture();
    const injected = {
      ...deps,
      complete: async () => false,
      canReclaim: async () => true,
    } satisfies AccountExportProcessDeps;
    await processAccountExport({ id: claim.id, db, deps: injected });
    expect(deleted).toEqual([[claim.objectKey]]);
  });

  test("a failed build persists retry state and reports the original failure", async () => {
    const { deps, deleted, failures } = fixture();
    const failure = new AccountExportArchiveError({ message: "Build failed" });
    const durable: { status: "processing" | "requested" } = {
      status: "processing",
    };
    const injected = {
      ...deps,
      build: async () => {
        throw failure;
      },
      complete: async () => panic("Failed builds must not complete"),
      fail: async () => {
        durable.status = "requested";
        return true;
      },
      canReclaim: async () => true,
    } satisfies AccountExportProcessDeps;
    expect(
      await rejectionOf(
        processAccountExport({ id: claim.id, db, deps: injected }),
      ),
    ).toBe(failure);
    expect(durable.status).toBe("requested");
    expect(failures).toEqual([failure]);
    expect(deleted).toEqual([[claim.objectKey]]);
  });

  test("an ambiguous completion preserves a committed ready winner", async () => {
    const { deps, deleted, failures } = fixture();
    const failure = new AccountExportArchiveError({
      message: "Completion response lost",
    });
    const durable: { status: "processing" | "ready" } = {
      status: "processing",
    };
    const injected = {
      ...deps,
      complete: async () => {
        durable.status = "ready";
        throw failure;
      },
      fail: async () => false,
      canReclaim: async () => durable.status !== "ready",
    } satisfies AccountExportProcessDeps;
    expect(
      await rejectionOf(
        processAccountExport({ id: claim.id, db, deps: injected }),
      ),
    ).toBe(failure);
    expect(durable.status).toBe("ready");
    expect(failures).toEqual([failure]);
    expect(deleted).toEqual([]);
  });
});
