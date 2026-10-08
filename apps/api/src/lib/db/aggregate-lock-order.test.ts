import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  AggregateLockBusy,
  ROW_LOCK_MODES,
  withAggregateLock,
} from "./aggregate-lock";
import {
  aggregateExecutionRows,
  aggregateFences,
  aggregateRecorder,
  plantedDescendingBlockingAcquisition,
  plantedWeakerHeldModeReuse,
} from "./aggregate-lock-order.fixture";

describe("blocking aggregate order regressions", () => {
  test("a planted descending blocking request never reaches its SQL acquisition", async () => {
    const { tx, statements } = aggregateRecorder();
    expect(
      await rejectionOf(plantedDescendingBlockingAcquisition(tx)),
    ).toMatchObject({
      message: "Aggregate lock rank inversion",
    });
    expect(statements).toHaveLength(1);
    expect(statements.at(0)?.sql).toContain('FROM "workspaces"');
    expect(statements.at(0)?.sql).not.toContain("advisory_xact_lock");
  });

  test("a planted stronger request cannot reuse an earlier weaker fence after a higher rank", async () => {
    const { tx, statements } = aggregateRecorder();
    expect(await rejectionOf(plantedWeakerHeldModeReuse(tx))).toMatchObject({
      message: "Aggregate lock rank inversion",
    });
    expect(statements).toHaveLength(2);
    expect(statements.at(0)?.sql).toContain("FOR KEY SHARE");
    expect(statements.at(1)?.sql).toContain('FROM "entities"');
  });

  test("all sixteen held/requested mode pairs preserve SQL strength and reject unfenced upgrades", async () => {
    for (const [heldIndex, heldMode] of ROW_LOCK_MODES.entries()) {
      for (const [requestedIndex, requestedMode] of ROW_LOCK_MODES.entries()) {
        const fixture = aggregateFences();
        const { tx, statements } = aggregateRecorder();
        await withAggregateLock({ ...fixture.workspace, mode: heldMode, tx });
        await withAggregateLock({ ...fixture.entity, tx });
        const requested = withAggregateLock({
          ...fixture.workspace,
          mode: requestedMode,
          tx,
        });
        // PostgreSQL row-mode exclusion dominance increases in the declared mode order.
        if (requestedIndex > heldIndex) {
          expect(await rejectionOf(requested)).toMatchObject({
            message: "Aggregate lock rank inversion",
          });
          expect(statements).toHaveLength(2);
          continue;
        }
        expect(await requested).toEqual({ status: "locked" });
        expect(statements).toHaveLength(3);
        expect(statements.at(0)?.sql).toContain(
          `FOR ${heldMode.toUpperCase()}`,
        );
        expect(statements.at(2)?.sql).toContain(
          `FOR ${requestedMode.toUpperCase()}`,
        );
      }
    }
  });

  test("an upgrade before higher ranks establishes a fence reusable after them", async () => {
    const fixture = aggregateFences();
    const { tx, statements } = aggregateRecorder();
    await withAggregateLock({ ...fixture.workspace, mode: "key share", tx });
    await withAggregateLock({ ...fixture.workspace, mode: "update", tx });
    await withAggregateLock({ ...fixture.entity, tx });
    expect(
      await withAggregateLock({ ...fixture.workspace, mode: "share", tx }),
    ).toEqual({ status: "locked" });
    expect(statements).toHaveLength(4);
    expect(statements.at(1)?.sql).toContain("FOR UPDATE");
    expect(statements.at(3)?.sql).toContain("FOR SHARE");
  });

  test("a busy nonblocking lower-rank advisory preserves the transaction high-water", async () => {
    const fixture = aggregateFences();
    const statements: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const tx = {
      execute: async (statement: SQL) => {
        const built = new PgDialect().sqlToQuery(statement);
        statements.push(built);
        if (built.sql.includes("pg_try_advisory_xact_lock")) {
          return [{ key1: 1, key2: 2, acquired: false }];
        }
        return aggregateExecutionRows(statement);
      },
    };
    await withAggregateLock({ ...fixture.entity, tx });
    const refused = await withAggregateLock({
      ...fixture.orgFeatureAdmission,
      wait: "nowait",
      tx,
    });
    expect(refused.status).toBe("busy");
    expect(refused).toMatchObject({ error: expect.any(AggregateLockBusy) });
    expect(statements.at(1)?.sql).toContain("pg_try_advisory_xact_lock");
    expect(
      await rejectionOf(withAggregateLock({ ...fixture.workspace, tx })),
    ).toMatchObject({ message: "Aggregate lock rank inversion" });
    expect(statements).toHaveLength(2);
    expect(await withAggregateLock({ ...fixture.processingClaim, tx })).toEqual(
      { status: "locked" },
    );
    expect(statements).toHaveLength(3);
  });

  test("closed receipt and membership variants lock their physical composite identities", async () => {
    const fixture = aggregateFences();
    const receipt = {
      aggregate: "scoutCensus",
      id: {
        type: "receipt",
        organizationId: fixture.organization.id,
        sourceKind: "document-review",
        sourceId: "review-source",
      },
      mode: "update",
    } as const;
    const workspaceMember = {
      aggregate: "memberCleanup",
      id: {
        type: "workspace-member",
        id: "matter-member",
        workspaceId: fixture.workspace.id.id,
      },
      mode: "key share",
    } as const;
    const { tx, statements } = aggregateRecorder();
    expect(await withAggregateLock({ ...receipt, tx })).toEqual({
      status: "locked",
    });
    expect(await withAggregateLock({ ...workspaceMember, tx })).toEqual({
      status: "locked",
    });
    expect(statements.at(0)?.sql).toContain('FROM "pending_scout_emissions"');
    expect(statements.at(0)?.params).toEqual([
      fixture.organization.id,
      "document-review",
      "review-source",
    ]);
    expect(statements.at(1)?.sql).toContain('FROM "workspace_members"');
    expect(statements.at(1)?.params).toEqual([
      "matter-member",
      fixture.workspace.id.id,
    ]);
    expect(statements.at(1)?.sql).toContain("FOR KEY SHARE");
  });
});
