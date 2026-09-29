import { describe, expect, test } from "bun:test";

import { markRlsDatabase } from "@/api/db/scoped";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

import {
  createSanctionsPublicReadDb,
  SanctionsPublicRoleError,
  type SanctionsReadTransaction,
} from "./read-db";

describe("anonymous sanctions role preflight", () => {
  test("shares concurrent probes and retains a successful validation", async () => {
    let probes = 0;
    const tx = asTestRaw<SanctionsReadTransaction>({
      execute: async () => {
        probes += 1;
      },
    });
    const db = createSanctionsPublicReadDb(
      markRlsDatabase({
        transaction: async <T>(
          fn: (transaction: SanctionsReadTransaction) => Promise<T>,
        ) => await fn(tx),
      }),
    );

    await Promise.all([db.validateRole(), db.validateRole()]);
    expect((await db.validateRole()).isOk()).toBe(true);
    expect(probes).toBe(1);
  });

  test("rejects an unavailable role without leaking driver context and retries after repair", async () => {
    let availability: "missing" | "available" = "missing";
    let probes = 0;
    const privateDriverContext = "private-driver-connection-context";
    const tx = asTestRaw<SanctionsReadTransaction>({
      execute: async () => {
        probes += 1;
        if (availability === "missing") {
          throw new TypeError(privateDriverContext);
        }
      },
    });
    const db = createSanctionsPublicReadDb(
      markRlsDatabase({
        transaction: async <T>(
          fn: (transaction: SanctionsReadTransaction) => Promise<T>,
        ) => await fn(tx),
      }),
    );
    const failures = await Promise.all([db.validateRole(), db.validateRole()]);
    for (const failure of failures) {
      expect(failure.isErr()).toBe(true);
      if (failure.isErr()) {
        expect(failure.error).toBeInstanceOf(SanctionsPublicRoleError);
        expect(JSON.stringify(failure.error)).not.toContain(
          privateDriverContext,
        );
      }
    }
    expect(probes).toBe(1);

    availability = "available";
    expect((await db.validateRole()).isOk()).toBe(true);
    expect((await db.validateRole()).isOk()).toBe(true);
    expect(probes).toBe(2);
  });
});
