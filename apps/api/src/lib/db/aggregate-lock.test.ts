import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createSafeId } from "@/api/lib/branded-types";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";

import { AGGREGATE_LOCKS, withAggregateLock } from "./aggregate-lock";
import type { AggregateName } from "./aggregate-lock";

type Options = Parameters<typeof withAggregateLock>[0];
type FenceFixtures = {
  [Name in AggregateName]: Omit<Extract<Options, { aggregate: Name }>, "tx">;
};

const fences = () => {
  const organizationId = mintAuthProviderId<"organization">();
  const workspaceId = createSafeId<"workspace">();
  const threadId = createSafeId<"chatThread">();
  const userId = mintAuthProviderId<"user">();
  return {
    organization: { aggregate: "organization", id: organizationId },
    workspace: {
      aggregate: "workspace",
      id: { id: workspaceId, organizationId },
    },
    chatThread: {
      aggregate: "chatThread",
      id: { id: threadId, organizationId, userId },
    },
    chatTurn: {
      aggregate: "chatTurn",
      id: { threadId, organizationId, userId, toolCallId: "test-call" },
    },
    chatSecret: {
      aggregate: "chatSecret",
      id: { id: Bun.randomUUIDv7(), threadId, organizationId, userId },
    },
    run: {
      aggregate: "run",
      id: { id: createSafeId<"flowRun">(), workspaceId },
    },
    currentStep: {
      aggregate: "currentStep",
      id: { id: createSafeId<"flowRunStep">(), workspaceId },
    },
    obligation: {
      aggregate: "obligation",
      id: { id: createSafeId<"entity">(), workspaceId },
    },
    entity: {
      aggregate: "entity",
      id: { id: createSafeId<"entity">(), workspaceId },
    },
    contactCapacity: { aggregate: "contactCapacity", id: { organizationId } },
    personalCatalog: {
      aggregate: "personalCatalog",
      id: { organizationId, userId: mintAuthProviderId<"user">() },
    },
  } as const satisfies FenceFixtures;
};

describe("aggregate acquisition ordering", () => {
  test("locks chat receipts in thread, interaction and receipt order", async () => {
    const fixture = fences();
    const statements: SQL[] = [];
    const tx = {
      execute: async (statement: SQL) => {
        statements.push(statement);
        return [{ id: "locked" }];
      },
    };
    await withAggregateLock({ ...fixture.chatThread, tx });
    await withAggregateLock({ ...fixture.chatTurn, tx });
    await withAggregateLock({ ...fixture.chatSecret, tx });
    const dialect = new PgDialect();
    const queries = statements.map((statement) =>
      dialect.sqlToQuery(statement),
    );
    expect(queries.map(({ sql }) => sql)).toEqual([
      expect.stringContaining('FROM "chat_threads"'),
      expect.stringContaining('FROM "chat_turns"'),
      expect.stringContaining('FROM "chat_secrets"'),
    ]);
    expect(queries.map(({ params }) => params)).toEqual([
      [
        fixture.chatThread.id.id,
        fixture.chatThread.id.organizationId,
        fixture.chatThread.id.userId,
      ],
      [
        fixture.chatTurn.id.threadId,
        fixture.chatTurn.id.toolCallId,
        fixture.chatTurn.id.organizationId,
        fixture.chatTurn.id.userId,
      ],
      [
        fixture.chatSecret.id.id,
        fixture.chatSecret.id.threadId,
        fixture.chatSecret.id.organizationId,
        fixture.chatSecret.id.userId,
      ],
    ]);
  });

  test("every ordered rank pair acquires and every inverted pair fails before execution", async () => {
    const ordered = Object.values(fences()).toSorted((left, right) => {
      const rankDifference =
        AGGREGATE_LOCKS[left.aggregate].rank -
        AGGREGATE_LOCKS[right.aggregate].rank;
      if (rankDifference !== 0) {
        return rankDifference;
      }
      if (left.aggregate === right.aggregate) {
        return 0;
      }
      return left.aggregate < right.aggregate ? -1 : 1;
    });
    for (const [index, first] of ordered.entries()) {
      for (const [secondIndex, second] of ordered.entries()) {
        let executions = 0;
        const tx = {
          execute: async () => {
            executions += 1;
            return [{ id: "locked" }];
          },
        };
        expect(await withAggregateLock({ ...first, tx })).toEqual({
          status: "locked",
        });
        if (secondIndex < index) {
          expect(
            await rejectionOf(withAggregateLock({ ...second, tx })),
          ).toMatchObject({ message: "Aggregate lock rank inversion" });
          expect(executions).toBe(1);
          continue;
        }
        expect(await withAggregateLock({ ...second, tx })).toEqual({
          status: "locked",
        });
        expect(executions).toBe(2);
      }
    }
  });

  test("retains history across helper calls but isolates new transactions and reacquisition", async () => {
    const fixture = fences();
    const tx = { execute: async () => [{ id: "locked" }] };
    await withAggregateLock({ ...fixture.workspace, tx });
    await withAggregateLock({ ...fixture.entity, tx });
    expect(await withAggregateLock({ ...fixture.workspace, tx })).toEqual({
      status: "locked",
    });
    expect(
      await rejectionOf(withAggregateLock({ ...fixture.organization, tx })),
    ).toMatchObject({ message: "Aggregate lock rank inversion" });
    const retryTx = { execute: async () => [{ id: "locked" }] };
    expect(
      await withAggregateLock({ ...fixture.organization, tx: retryTx }),
    ).toEqual({ status: "locked" });
  });

  test("missing rows consume no rank and scoped reacquisition still executes its predicate", async () => {
    const fixture = fences();
    let found = false;
    const tx = { execute: async () => (found ? [{ id: "locked" }] : []) };
    expect(await withAggregateLock({ ...fixture.entity, tx })).toEqual({
      status: "missing",
    });
    found = true;
    await withAggregateLock({ ...fixture.organization, tx });
    await withAggregateLock({ ...fixture.workspace, tx });
    found = false;
    expect(
      await withAggregateLock({
        aggregate: "workspace",
        id: {
          id: fixture.workspace.id.id,
          organizationId: mintAuthProviderId<"organization">(),
        },
        tx,
      }),
    ).toEqual({ status: "missing" });
  });

  test("rejects descending identities and overlapping acquisitions on one transaction", async () => {
    const organizationIds = [
      mintAuthProviderId<"organization">(),
      mintAuthProviderId<"organization">(),
    ].toSorted();
    const first = organizationIds.at(0);
    const last = organizationIds.at(-1);
    if (first === undefined || last === undefined) {
      panic("Missing identity fixture");
    }
    const tx = { execute: async () => [] };
    await withAggregateLock({
      aggregate: "contactCapacity",
      id: { organizationId: last },
      tx,
    });
    expect(
      await rejectionOf(
        withAggregateLock({
          aggregate: "contactCapacity",
          id: { organizationId: first },
          tx,
        }),
      ),
    ).toMatchObject({ message: "Aggregate lock rank inversion" });

    const gate = Promise.withResolvers<unknown[]>();
    const pendingTx = { execute: async () => await gate.promise };
    const pending = withAggregateLock({
      aggregate: "contactCapacity",
      id: { organizationId: first },
      tx: pendingTx,
    });
    expect(
      await rejectionOf(
        withAggregateLock({
          aggregate: "contactCapacity",
          id: { organizationId: last },
          tx: pendingTx,
        }),
      ),
    ).toMatchObject({
      message: "Await each aggregate lock acquisition before starting another",
    });
    gate.resolve([]);
    expect(await pending).toEqual({ status: "locked" });
  });
});
