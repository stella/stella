import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { rejectionOf } from "@stll/property-testing/rejection";

import { withGatedTestClients } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { withInterleaving } from "@/api/tests/helpers/transaction-interleaving";

import {
  ADVISORY_LOCK_MODES,
  AggregateLockBusy,
  AggregateLockUpgradeRefused,
  withAggregateLock,
  withAggregateSavepoint,
} from "./aggregate-lock";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

if (!databaseUrl || !enabled) {
  describe.skip("shared aggregate advisory locks (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("shared aggregate advisory locks (postgres)", () => {
    for (const mode of ADVISORY_LOCK_MODES) {
      test(`shared advisory holds ${mode === "shared" ? "coexist with shared" : "block exclusive"} requests across sessions`, async () => {
        const fence = {
          aggregate: "orgFeatureAdmission",
          id: {
            organizationId: mintAuthProviderId<"organization">(),
            featureId: "flows",
          },
        } as const;
        await withInterleaving({
          databaseUrl,
          schedules: [["a.lock", "b.lock", "a.commit", "b.commit"]],
          a: {
            steps: [
              {
                name: "lock",
                run: async (tx) => {
                  expect(
                    await withAggregateLock({ ...fence, tx, mode: "shared" }),
                  ).toEqual({ status: "locked" });
                },
              },
            ],
          },
          b: {
            steps: [
              {
                name: "lock",
                run: async (tx) => {
                  expect(
                    await withAggregateLock({ ...fence, tx, mode }),
                  ).toEqual({ status: "locked" });
                },
              },
            ],
          },
          reset: async () => {},
          readState: async () => undefined,
          invariant: ({ blocked, outcomes }) => {
            expect(blocked).toEqual(mode === "shared" ? [] : ["b.lock"]);
            expect(outcomes).toEqual({
              a: { status: "committed" },
              b: { status: "committed" },
            });
          },
        });
      });
    }

    test("shared NOWAIT reports typed Busy behind an exclusive session and succeeds after release", async () => {
      const fence = {
        aggregate: "orgFeatureAdmission",
        id: {
          organizationId: mintAuthProviderId<"organization">(),
          featureId: "flows",
        },
      } as const;
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const holder = openClient();
        const contender = openClient();
        await holder.db.transaction(async (tx) => {
          await withAggregateLock({ ...fence, tx });
          await contender.db.transaction(async (other) => {
            const result = await withAggregateLock({
              ...fence,
              tx: other,
              mode: "shared",
              wait: "nowait",
            });
            if (result.status !== "busy") {
              panic("Expected shared contention");
            }
            expect(result.error).toBeInstanceOf(AggregateLockBusy);
            expect(
              (await other.execute(sql`SELECT 1 AS healthy`)).at(0),
            ).toEqual({ healthy: 1 });
          });
        });
        await contender.db.transaction(async (tx) => {
          expect(
            await withAggregateLock({
              ...fence,
              tx,
              mode: "shared",
              wait: "nowait",
            }),
          ).toEqual({ status: "locked" });
        });
      });
    });

    test("two shared sessions refuse upgrades while their transactions remain usable", async () => {
      const fence = {
        aggregate: "orgFeatureAdmission",
        id: {
          organizationId: mintAuthProviderId<"organization">(),
          featureId: "flows",
        },
      } as const;
      await withGatedTestClients(databaseUrl, async ({ openClient }) => {
        const a = openClient();
        const b = openClient();
        await a.db.transaction(async (tx) => {
          await withAggregateLock({ ...fence, tx, mode: "shared" });
          await b.db.transaction(async (other) => {
            await withAggregateLock({ ...fence, tx: other, mode: "shared" });
            for (const wait of ["block", "nowait"] as const) {
              await withAggregateSavepoint(tx, async (child) => {
                expect(
                  await rejectionOf(
                    withAggregateLock({
                      ...fence,
                      tx: child,
                      mode: "exclusive",
                      wait,
                    }),
                  ),
                ).toBeInstanceOf(AggregateLockUpgradeRefused);
              });
              expect(
                await rejectionOf(
                  withAggregateLock({
                    ...fence,
                    tx: other,
                    mode: "exclusive",
                    wait,
                  }),
                ),
              ).toBeInstanceOf(AggregateLockUpgradeRefused);
            }
            expect(
              (await other.execute(sql`SELECT 1 AS healthy`)).at(0),
            ).toEqual({ healthy: 1 });
          });
          expect((await tx.execute(sql`SELECT 1 AS healthy`)).at(0)).toEqual({
            healthy: 1,
          });
        });
      });
    });
  });
}
