import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { MEMBER_REMOVAL_BUSY_CODE } from "@stll/api-contract";
import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { abortTransaction } from "@/api/db/safe-db";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { withGatedTestClients } from "@/api/tests/gated-test-database";
import type { GatedTestDb } from "@/api/tests/gated-test-database";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import {
  AggregateLockBusy,
  ROW_LOCK_MODES,
  withAggregateLock,
} from "./aggregate-lock";
import type { RowLockMode } from "./aggregate-lock";

const databaseUrl = process.env["DATABASE_URL"];
const enabled = process.env["STELLA_RUN_POSTGRES_TESTS"] === "true";

const conflicts = {
  "key share": ["update"],
  share: ["no key update", "update"],
  "no key update": ["share", "no key update", "update"],
  update: ROW_LOCK_MODES,
} as const satisfies Record<RowLockMode, readonly RowLockMode[]>;
const modePairs = ROW_LOCK_MODES.flatMap((held) =>
  ROW_LOCK_MODES.map((requested) => [held, requested] as const),
);

type LockFixture = {
  holder: GatedTestDb;
  contender: GatedTestDb;
  organizationId: SafeId<"organization">;
  otherOrganizationId: SafeId<"organization">;
  workspaceId: SafeId<"workspace">;
  schema: string;
  holderStatements: string[];
};

const inFixture = async (
  tx: Pick<Transaction, "execute">,
  schema: string,
): Promise<void> => {
  // No public fallback: every unqualified owner query stays in this fixture.
  await tx.execute(sql`SET LOCAL search_path TO ${sql.identifier(schema)}`);
};

const withLockFixture = async (
  url: string,
  run: (fixture: LockFixture) => Promise<void>,
): Promise<void> => {
  await withGatedTestClients(url, async ({ openClient }) => {
    const holderStatements: string[] = [];
    const holder = openClient({
      logger: {
        logQuery: (query) => {
          holderStatements.push(query);
        },
      },
    }).db;
    const contender = openClient({
      connection: { lock_timeout: 1000, statement_timeout: 5000 },
    }).db;
    const organizationId = mintAuthProviderId<"organization">();
    const otherOrganizationId = mintAuthProviderId<"organization">();
    const workspaceId = createSafeId<"workspace">();
    const schema = `aggregate_extension_${workspaceId.replaceAll("-", "")}`;
    await holder.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
    try {
      await holder.execute(sql`CREATE TABLE ${sql.identifier(schema)}.organization (
        id text PRIMARY KEY
      )`);
      await holder.execute(sql`CREATE TABLE ${sql.identifier(schema)}.workspaces (
        id uuid PRIMARY KEY,
        organization_id text NOT NULL REFERENCES ${sql.identifier(schema)}.organization(id)
      )`);
      await holder.execute(sql`CREATE TABLE ${sql.identifier(schema)}.effects (
        id uuid PRIMARY KEY
      )`);
      await holder.execute(sql`INSERT INTO ${sql.identifier(schema)}.organization (id)
        VALUES (${organizationId}), (${otherOrganizationId})`);
      await holder.execute(sql`INSERT INTO ${sql.identifier(schema)}.workspaces (id, organization_id)
        VALUES (${workspaceId}::uuid, ${organizationId})`);
      await run({
        holder,
        contender,
        organizationId,
        otherOrganizationId,
        workspaceId,
        schema,
        holderStatements,
      });
    } finally {
      await holder.execute(sql`DROP SCHEMA ${sql.identifier(schema)} CASCADE`);
    }
  });
};

if (!databaseUrl || !enabled) {
  describe.skip("aggregate lock extension (postgres)", () => {
    test("requires STELLA_RUN_POSTGRES_TESTS=true and DATABASE_URL", () => {});
  });
} else {
  describe("aggregate lock extension (postgres)", () => {
    test.each(modePairs)(
      "held %s handles requested %s with PostgreSQL row-lock compatibility",
      async (held, requested) => {
        await withLockFixture(
          databaseUrl,
          async ({ holder, contender, organizationId, schema }) => {
            await holder.transaction(async (holdingTx) => {
              await inFixture(holdingTx, schema);
              expect(
                await withAggregateLock({
                  aggregate: "organization",
                  id: organizationId,
                  mode: held,
                  tx: holdingTx,
                }),
              ).toEqual({ status: "locked" });
              await contender.transaction(async (tx) => {
                await inFixture(tx, schema);
                const acquisition = await withAggregateLock({
                  aggregate: "organization",
                  id: organizationId,
                  mode: requested,
                  wait: "nowait",
                  tx,
                });
                const contended = conflicts[held].some(
                  (mode) => mode === requested,
                );
                expect(acquisition.status).toBe(contended ? "busy" : "locked");
                if (acquisition.status === "busy") {
                  expect(AggregateLockBusy.is(acquisition.error)).toBe(true);
                }
                const healthy = await tx.execute(sql`SELECT 1 AS healthy`);
                expect(healthy.at(0)?.["healthy"]).toBe(1);
              });
            });
          },
        );
      },
    );

    test("organization feature admission preserves legacy keys and independent features and organizations", async () => {
      await withLockFixture(
        databaseUrl,
        async ({ holder, contender, organizationId, otherOrganizationId }) => {
          await holder.transaction(async (tx) => {
            expect(
              await withAggregateLock({
                aggregate: "orgFeatureAdmission",
                id: { organizationId, featureId: "flows" },
                tx,
              }),
            ).toEqual({ status: "locked" });
            await contender.transaction(async (otherTx) => {
              const legacy =
                await otherTx.execute(sql`SELECT pg_try_advisory_xact_lock(
              ${0x0f_10_cc_aa}::integer, hashtext(${`flows:${organizationId}`})) AS acquired`);
              expect(legacy.at(0)?.["acquired"]).toBe(false);
            });
            await contender.transaction(async (otherTx) => {
              expect(
                await withAggregateLock({
                  aggregate: "orgFeatureAdmission",
                  id: { organizationId, featureId: "signals" },
                  wait: "nowait",
                  tx: otherTx,
                }),
              ).toEqual({ status: "locked" });
            });
            await contender.transaction(async (otherTx) => {
              expect(
                await withAggregateLock({
                  aggregate: "orgFeatureAdmission",
                  id: {
                    organizationId: otherOrganizationId,
                    featureId: "flows",
                  },
                  wait: "nowait",
                  tx: otherTx,
                }),
              ).toEqual({ status: "locked" });
            });
          });
        },
      );
    });

    test("legacy admission contention returns typed busy and a successful nonblocking backedge retains the high-water", async () => {
      await withLockFixture(
        databaseUrl,
        async ({ holder, contender, organizationId, workspaceId, schema }) => {
          await holder.transaction(async (holdingTx) => {
            await holdingTx.execute(sql`SELECT pg_advisory_xact_lock(
            ${0x0f_10_cc_aa}::integer, hashtext(${`flows:${organizationId}`}))`);
            await contender.transaction(async (tx) => {
              await inFixture(tx, schema);
              expect(
                await withAggregateLock({
                  aggregate: "workspace",
                  id: { id: workspaceId, organizationId },
                  mode: "update",
                  tx,
                }),
              ).toEqual({ status: "locked" });
              const acquisition = await withAggregateLock({
                aggregate: "orgFeatureAdmission",
                id: { organizationId, featureId: "flows" },
                wait: "nowait",
                tx,
              });
              expect(acquisition.status).toBe("busy");
              if (acquisition.status !== "busy") {
                panic(
                  "The legacy writer must hold the same physical admission key",
                );
              }
              expect(AggregateLockBusy.is(acquisition.error)).toBe(true);
              expect(
                await withAggregateLock({
                  aggregate: "orgFeatureAdmission",
                  id: { organizationId, featureId: "signals" },
                  wait: "nowait",
                  tx,
                }),
              ).toEqual({ status: "locked" });
              const healthy = await tx.execute(sql`SELECT 1 AS healthy`);
              expect(healthy.at(0)?.["healthy"]).toBe(1);
              expect(
                await rejectionOf(
                  withAggregateLock({
                    aggregate: "organization",
                    id: organizationId,
                    mode: "update",
                    tx,
                  }),
                ),
              ).toMatchObject({ message: "Aggregate lock rank inversion" });
            });
          });
        },
      );
    });

    test("row NOWAIT contention returns typed busy without poisoning the parent or recording a held lock", async () => {
      await withLockFixture(
        databaseUrl,
        async ({ holder, contender, organizationId, workspaceId, schema }) => {
          await holder.transaction(async (holdingTx) => {
            await inFixture(holdingTx, schema);
            expect(
              await withAggregateLock({
                aggregate: "organization",
                id: organizationId,
                mode: "update",
                tx: holdingTx,
              }),
            ).toEqual({ status: "locked" });
            await contender.transaction(async (tx) => {
              await inFixture(tx, schema);
              const refusal = await withAggregateLock({
                aggregate: "organization",
                id: organizationId,
                mode: "update",
                wait: "nowait",
                tx,
              });
              expect(refusal.status).toBe("busy");
              if (refusal.status !== "busy") {
                panic("The other session must contend on the organization row");
              }
              expect(AggregateLockBusy.is(refusal.error)).toBe(true);
              const healthy = await tx.execute(sql`SELECT 1 AS healthy`);
              expect(healthy.at(0)?.["healthy"]).toBe(1);
              expect(
                await withAggregateLock({
                  aggregate: "workspace",
                  id: { id: workspaceId, organizationId },
                  mode: "update",
                  tx,
                }),
              ).toEqual({ status: "locked" });
              expect(
                await rejectionOf(
                  withAggregateLock({
                    aggregate: "organization",
                    id: organizationId,
                    mode: "update",
                    tx,
                  }),
                ),
              ).toMatchObject({ message: "Aggregate lock rank inversion" });
            });
          });
        },
      );
    });

    test("a caller's typed 409 abort rolls back earlier writes after row NOWAIT contention", async () => {
      await withLockFixture(
        databaseUrl,
        async ({ holder, contender, organizationId, schema }) => {
          await holder.transaction(async (holdingTx) => {
            await inFixture(holdingTx, schema);
            await withAggregateLock({
              aggregate: "organization",
              id: organizationId,
              mode: "update",
              tx: holdingTx,
            });
            const refusal = await rejectionOf(
              contender.transaction(async (tx) => {
                await inFixture(tx, schema);
                await tx.execute(
                  sql`INSERT INTO effects (id) VALUES (${createSafeId<"entity">()}::uuid)`,
                );
                const acquisition = await withAggregateLock({
                  aggregate: "organization",
                  id: organizationId,
                  mode: "update",
                  wait: "nowait",
                  tx,
                });
                if (acquisition.status !== "busy") {
                  panic("The other session must contend before the abort");
                }
                expect(AggregateLockBusy.is(acquisition.error)).toBe(true);
                abortTransaction(
                  new HandlerError({
                    status: 409,
                    code: MEMBER_REMOVAL_BUSY_CODE,
                    retryable: true,
                    message:
                      "Other work is in progress. Please try again shortly.",
                  }),
                );
              }),
            );
            expect(refusal).toMatchObject({
              status: 409,
              code: MEMBER_REMOVAL_BUSY_CODE,
              retryable: true,
            });
            await contender.transaction(async (tx) => {
              await inFixture(tx, schema);
              const effects = await tx.execute(
                sql`SELECT count(*)::int AS count FROM effects`,
              );
              expect(effects.at(0)?.["count"]).toBe(0);
            });
          });
        },
      );
    });

    test.each(["available", "contended"] as const)(
      "KEY SHARE upgrade below the high-water rejects blocking acquisition and handles NOWAIT when %s",
      async (availability) => {
        await withLockFixture(
          databaseUrl,
          async ({
            holder,
            contender,
            organizationId,
            otherOrganizationId,
            workspaceId,
            schema,
          }) => {
            await contender.transaction(async (tx) => {
              await inFixture(tx, schema);
              expect(
                await withAggregateLock({
                  aggregate: "organization",
                  id: organizationId,
                  mode: "key share",
                  tx,
                }),
              ).toEqual({ status: "locked" });
              expect(
                await withAggregateLock({
                  aggregate: "workspace",
                  id: { id: workspaceId, organizationId },
                  mode: "update",
                  tx,
                }),
              ).toEqual({ status: "locked" });
              expect(
                await rejectionOf(
                  withAggregateLock({
                    aggregate: "organization",
                    id: organizationId,
                    mode: "update",
                    tx,
                  }),
                ),
              ).toMatchObject({ message: "Aggregate lock rank inversion" });

              const upgrade = async () => {
                const acquisition = await withAggregateLock({
                  aggregate: "organization",
                  id: organizationId,
                  mode: "update",
                  wait: "nowait",
                  tx,
                });
                expect(acquisition.status).toBe(
                  availability === "contended" ? "busy" : "locked",
                );
                if (acquisition.status === "busy") {
                  expect(AggregateLockBusy.is(acquisition.error)).toBe(true);
                }
                const healthy = await tx.execute(sql`SELECT 1 AS healthy`);
                expect(healthy.at(0)?.["healthy"]).toBe(1);
                expect(
                  await rejectionOf(
                    withAggregateLock({
                      aggregate: "organization",
                      id: otherOrganizationId,
                      mode: "update",
                      tx,
                    }),
                  ),
                ).toMatchObject({ message: "Aggregate lock rank inversion" });
              };
              if (availability === "available") {
                await upgrade();
                return;
              }
              await holder.transaction(async (holdingTx) => {
                await inFixture(holdingTx, schema);
                expect(
                  await withAggregateLock({
                    aggregate: "organization",
                    id: organizationId,
                    mode: "no key update",
                    tx: holdingTx,
                  }),
                ).toEqual({ status: "locked" });
                await upgrade();
              });
            });
          },
        );
      },
    );

    test("NO KEY UPDATE permits an actual foreign-key insert from another session", async () => {
      await withLockFixture(
        databaseUrl,
        async ({ holder, contender, organizationId, schema }) => {
          await holder.transaction(async (tx) => {
            await inFixture(tx, schema);
            expect(
              await withAggregateLock({
                aggregate: "organization",
                id: organizationId,
                mode: "no key update",
                tx,
              }),
            ).toEqual({ status: "locked" });
            const insertedId = createSafeId<"workspace">();
            await contender.transaction(async (otherTx) => {
              await inFixture(otherTx, schema);
              const inserted = await otherTx.execute(sql`
              INSERT INTO workspaces (id, organization_id)
              VALUES (${insertedId}::uuid, ${organizationId}) RETURNING id`);
              expect(inserted.at(0)?.["id"]).toBe(insertedId);
            });
            const committed = await tx.execute(
              sql`SELECT id FROM workspaces WHERE id = ${insertedId}::uuid`,
            );
            expect(committed.at(0)?.["id"]).toBe(insertedId);
          });
        },
      );
    });

    test("held NO KEY UPDATE covers SHARE reentry below the high-water while retaining the original physical exclusion", async () => {
      await withLockFixture(
        databaseUrl,
        async ({
          holder,
          contender,
          organizationId,
          workspaceId,
          schema,
          holderStatements,
        }) => {
          await holder.transaction(async (tx) => {
            await inFixture(tx, schema);
            expect(
              await withAggregateLock({
                aggregate: "organization",
                id: organizationId,
                mode: "no key update",
                tx,
              }),
            ).toEqual({ status: "locked" });
            expect(
              await withAggregateLock({
                aggregate: "workspace",
                id: { id: workspaceId, organizationId },
                mode: "update",
                tx,
              }),
            ).toEqual({ status: "locked" });
            const beforeReentry = holderStatements.length;
            expect(
              await withAggregateLock({
                aggregate: "organization",
                id: organizationId,
                mode: "share",
                tx,
              }),
            ).toEqual({ status: "locked" });
            expect(
              holderStatements
                .slice(beforeReentry)
                .some((query) => /\bFOR SHARE\b/iu.test(query)),
            ).toBe(true);
            await contender.transaction(async (otherTx) => {
              await inFixture(otherTx, schema);
              expect(
                await withAggregateLock({
                  aggregate: "organization",
                  id: organizationId,
                  mode: "key share",
                  wait: "nowait",
                  tx: otherTx,
                }),
              ).toEqual({ status: "locked" });
              const refusal = await withAggregateLock({
                aggregate: "organization",
                id: organizationId,
                mode: "share",
                wait: "nowait",
                tx: otherTx,
              });
              expect(refusal.status).toBe("busy");
              if (refusal.status !== "busy") {
                panic(
                  "SHARE reentry must retain the stronger original exclusion",
                );
              }
              expect(AggregateLockBusy.is(refusal.error)).toBe(true);
            });
          });
        },
      );
    });
  });
}
