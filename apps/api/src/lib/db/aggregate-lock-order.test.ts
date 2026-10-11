import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import { toSafeId } from "@/api/lib/branded-types";

import {
  AGGREGATE_LOCKS,
  AggregateLockBusy,
  ROW_LOCK_MODES,
  withAggregateLock,
  withAggregateTransaction,
} from "./aggregate-lock";
import {
  aggregateExecutionRows,
  aggregateFences,
  aggregateRecorder,
  plantedDescendingBlockingAcquisition,
  plantedBlockingUpgradeAtHighWater,
  plantedWeakerHeldModeReuse,
} from "./aggregate-lock-order.fixture";

describe("blocking aggregate order regressions", () => {
  test("all list row registrations share physical coverage across UUID case aliases after a higher rank", async () => {
    type Registry = typeof AGGREGATE_LOCKS;
    type ListRowName = {
      [Name in keyof Registry]: Registry[Name]["rank"] extends
        | 530
        | 540
        | 550
        | 560
        | 570
        | 580
        | 590
        ? Name
        : never;
    }[keyof Registry];
    type LockOptions = Parameters<typeof withAggregateLock>[0];
    type CaseFixtures = {
      [Name in ListRowName]: {
        upper: Omit<Extract<LockOptions, { aggregate: Name }>, "tx">;
        lower: Omit<Extract<LockOptions, { aggregate: Name }>, "tx">;
        table: string;
      };
    };
    const upperWorkspaceId = toSafeId<"workspace">(
      "ABCDABCD-ABCD-4ABC-8ABC-ABCDEFABCDEF",
    );
    const lowerWorkspaceId = toSafeId<"workspace">(
      "abcdabcd-abcd-4abc-8abc-abcdefabcdef",
    );
    expect(upperWorkspaceId).not.toBe(lowerWorkspaceId);
    const fixtures = {
      legalList: {
        upper: {
          aggregate: "legalList",
          id: {
            id: toSafeId<"legalList">("ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF"),
            workspaceId: upperWorkspaceId,
          },
          mode: "update",
        },
        lower: {
          aggregate: "legalList",
          id: {
            id: toSafeId<"legalList">("abcdefab-abcd-4abc-8abc-abcdefabcdef"),
            workspaceId: lowerWorkspaceId,
          },
          mode: "update",
        },
        table: "legal_lists",
      },
      listGenerationRun: {
        upper: {
          aggregate: "listGenerationRun",
          id: {
            id: toSafeId<"legalListGenerationRun">(
              "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF",
            ),
            workspaceId: upperWorkspaceId,
          },
          mode: "update",
        },
        lower: {
          aggregate: "listGenerationRun",
          id: {
            id: toSafeId<"legalListGenerationRun">(
              "abcdefab-abcd-4abc-8abc-abcdefabcdef",
            ),
            workspaceId: lowerWorkspaceId,
          },
          mode: "update",
        },
        table: "legal_list_generation_runs",
      },
      listGenerationCandidate: {
        upper: {
          aggregate: "listGenerationCandidate",
          id: {
            id: toSafeId<"legalListGenerationCandidate">(
              "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF",
            ),
            workspaceId: upperWorkspaceId,
          },
          mode: "update",
        },
        lower: {
          aggregate: "listGenerationCandidate",
          id: {
            id: toSafeId<"legalListGenerationCandidate">(
              "abcdefab-abcd-4abc-8abc-abcdefabcdef",
            ),
            workspaceId: lowerWorkspaceId,
          },
          mode: "update",
        },
        table: "legal_list_generation_candidates",
      },
      listGenerationSource: {
        upper: {
          aggregate: "listGenerationSource",
          id: {
            id: toSafeId<"legalListGenerationCandidateSource">(
              "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF",
            ),
            workspaceId: upperWorkspaceId,
          },
          mode: "update",
        },
        lower: {
          aggregate: "listGenerationSource",
          id: {
            id: toSafeId<"legalListGenerationCandidateSource">(
              "abcdefab-abcd-4abc-8abc-abcdefabcdef",
            ),
            workspaceId: lowerWorkspaceId,
          },
          mode: "update",
        },
        table: "legal_list_generation_candidate_sources",
      },
      listVerificationRun: {
        upper: {
          aggregate: "listVerificationRun",
          id: {
            id: toSafeId<"legalListVerificationRun">(
              "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF",
            ),
            workspaceId: upperWorkspaceId,
          },
          mode: "update",
        },
        lower: {
          aggregate: "listVerificationRun",
          id: {
            id: toSafeId<"legalListVerificationRun">(
              "abcdefab-abcd-4abc-8abc-abcdefabcdef",
            ),
            workspaceId: lowerWorkspaceId,
          },
          mode: "update",
        },
        table: "legal_list_verification_runs",
      },
      listVerificationClaim: {
        upper: {
          aggregate: "listVerificationClaim",
          id: {
            id: toSafeId<"legalListClaim">(
              "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF",
            ),
            workspaceId: upperWorkspaceId,
          },
          mode: "update",
        },
        lower: {
          aggregate: "listVerificationClaim",
          id: {
            id: toSafeId<"legalListClaim">(
              "abcdefab-abcd-4abc-8abc-abcdefabcdef",
            ),
            workspaceId: lowerWorkspaceId,
          },
          mode: "update",
        },
        table: "legal_list_claims",
      },
      listFactDetails: {
        upper: {
          aggregate: "listFactDetails",
          id: {
            itemEntityId: toSafeId<"entity">(
              "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF",
            ),
            workspaceId: upperWorkspaceId,
          },
          mode: "update",
        },
        lower: {
          aggregate: "listFactDetails",
          id: {
            itemEntityId: toSafeId<"entity">(
              "abcdefab-abcd-4abc-8abc-abcdefabcdef",
            ),
            workspaceId: lowerWorkspaceId,
          },
          mode: "update",
        },
        table: "legal_list_fact_details",
      },
    } as const satisfies CaseFixtures;
    expect(Object.keys(fixtures).toSorted()).toEqual(
      Object.entries(AGGREGATE_LOCKS)
        .filter(([, entry]) => entry.rank >= 530 && entry.rank <= 590)
        .map(([name]) => name)
        .toSorted(),
    );
    for (const fixture of Object.values(fixtures)) {
      const { tx, statements } = aggregateRecorder();
      expect(await withAggregateLock({ ...fixture.upper, tx })).toEqual({
        status: "locked",
      });
      await withAggregateLock({
        aggregate: "signal",
        id: {
          id: toSafeId<"signal">("01234567-abcd-4abc-8abc-abcdefabcdef"),
          organizationId: toSafeId<"organization">("CaseSensitiveOrganization"),
        },
        mode: "update",
        tx,
      });
      expect(await withAggregateLock({ ...fixture.lower, tx })).toEqual({
        status: "locked",
      });
      expect(statements).toHaveLength(3);
      for (const statement of [statements.at(0), statements.at(2)]) {
        expect(statement?.sql).toContain(`FROM "public"."${fixture.table}"`);
        expect(statement?.params).toEqual([
          "abcdefab-abcd-4abc-8abc-abcdefabcdef",
          "abcdabcd-abcd-4abc-8abc-abcdefabcdef",
        ]);
      }
      expect(statements.at(1)?.params).toEqual([
        "01234567-abcd-4abc-8abc-abcdefabcdef",
        "CaseSensitiveOrganization",
      ]);
    }
  });

  test("chat revision locks scope the thread to its principal and the message to its thread", async () => {
    const fixture = aggregateFences();
    const { tx, statements } = aggregateRecorder();

    expect(await withAggregateLock({ ...fixture.chatThread, tx })).toEqual({
      status: "locked",
    });
    expect(await withAggregateLock({ ...fixture.chatMessage, tx })).toEqual({
      status: "locked",
    });

    expect(statements).toHaveLength(2);
    expect(statements.at(0)?.sql).toContain('FROM "public"."chat_threads"');
    expect(statements.at(0)?.sql).toContain('"organization_id" =');
    expect(statements.at(0)?.sql).toContain('"user_id" =');
    expect(statements.at(0)?.params).toEqual([
      fixture.chatThread.id.id,
      fixture.chatThread.id.organizationId,
      fixture.chatThread.id.userId,
    ]);
    expect(statements.at(1)?.sql).toContain('FROM "public"."chat_messages"');
    expect(statements.at(1)?.sql).toContain('"thread_id" =');
    expect(statements.at(1)?.params).toEqual([
      fixture.chatMessage.id.id,
      fixture.chatThread.id.id,
    ]);
  });

  test("a planted descending blocking request never reaches its SQL acquisition", async () => {
    const { tx, statements } = aggregateRecorder();
    expect(
      await rejectionOf(plantedDescendingBlockingAcquisition(tx)),
    ).toMatchObject({
      message: "Aggregate lock rank inversion",
    });
    expect(statements).toHaveLength(1);
    expect(statements.at(0)?.sql).toContain('FROM "public"."workspaces"');
    expect(statements.at(0)?.sql).not.toContain("advisory_xact_lock");
  });

  test("a planted stronger request cannot reuse an earlier weaker fence after a higher rank", async () => {
    const { tx, statements } = aggregateRecorder();
    expect(await rejectionOf(plantedWeakerHeldModeReuse(tx))).toMatchObject({
      message:
        "Take the strongest aggregate row mode first; use NOWAIT for upgrades",
    });
    expect(statements).toHaveLength(2);
    expect(statements.at(0)?.sql).toContain("FOR KEY SHARE");
    expect(statements.at(1)?.sql).toContain('FROM "public"."entities"');
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
            message:
              "Take the strongest aggregate row mode first; use NOWAIT for upgrades",
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

  test("a planted blocking upgrade at the high-water never issues upgrade SQL", async () => {
    const { tx, statements } = aggregateRecorder();
    expect(
      await rejectionOf(plantedBlockingUpgradeAtHighWater(tx)),
    ).toMatchObject({
      message:
        "Take the strongest aggregate row mode first; use NOWAIT for upgrades",
    });
    expect(statements).toHaveLength(1);
    expect(statements.at(0)?.sql).toContain("FOR KEY SHARE");
    expect(statements.at(0)?.sql).not.toContain("FOR UPDATE");
  });

  test("a strongest initial fence permits weaker requests after higher ranks", async () => {
    const fixture = aggregateFences();
    const { tx, statements } = aggregateRecorder();
    await withAggregateLock({ ...fixture.workspace, mode: "update", tx });
    await withAggregateLock({ ...fixture.entity, tx });
    expect(
      await withAggregateLock({ ...fixture.workspace, mode: "share", tx }),
    ).toEqual({ status: "locked" });
    expect(statements).toHaveLength(3);
    expect(statements.at(0)?.sql).toContain("FOR UPDATE");
    expect(statements.at(2)?.sql).toContain("FOR SHARE");
  });

  test("an empty tracked root rejects an escaped handle after completion", async () => {
    const { tx, statements } = aggregateRecorder();
    const database = {
      transaction: async <Value>(
        run: (transaction: typeof tx) => Promise<Value>,
      ) => await run(tx),
    };
    const escaped = await withAggregateTransaction(
      database,
      async (transaction) => transaction,
    );
    const fixture = aggregateFences();
    expect(
      await rejectionOf(
        withAggregateLock({ ...fixture.workspace, tx: escaped }),
      ),
    ).toMatchObject({ message: "Aggregate savepoint transaction is closed" });
    expect(statements).toHaveLength(0);
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

  test("workspace membership locks preserve their physical key and tenant scope", async () => {
    const fixture = aggregateFences();
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
    expect(await withAggregateLock({ ...workspaceMember, tx })).toEqual({
      status: "locked",
    });
    expect(statements.at(0)?.sql).toContain(
      'FROM "public"."workspace_members"',
    );
    expect(statements.at(0)?.params).toEqual([
      "matter-member",
      fixture.workspace.id.id,
    ]);
    expect(statements.at(0)?.sql).toContain("FOR KEY SHARE");
  });
});
