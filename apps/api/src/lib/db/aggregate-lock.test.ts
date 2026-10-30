import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { type SQL, TransactionRollbackError } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import ts from "typescript6";

import { rejectionOf } from "@stll/property-testing/rejection";

import type { Transaction } from "@/api/db/root";
import { HTTP_IDLE_TIMEOUT_S } from "@/api/http/timeout-policy";
import { createSafeId } from "@/api/lib/branded-types";
import { DatabaseError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { PG_ERROR } from "@/api/lib/pg-error";
import {
  DEFAULT_LEASE_MS,
  defaultHeartbeatIntervalMs,
} from "@/api/lib/scheduler/lease-timing";
import {
  aggregateExecutionRows,
  aggregateFences as fences,
} from "@/api/tests/fixtures/aggregate-lock-order";
import { mintAuthProviderId } from "@/api/tests/helpers/auth-provider-id";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";
import { createSelectQueryMock } from "@/api/tests/scoped-db-mock";

import { DEFAULT_LOCK_RETRY_CONFIG } from "../../db/lock-retry-ladder.ts";
import {
  AGGREGATE_CHAINS,
  AGGREGATE_LOCKS,
  lockCaseLawRepublication,
  lockInvoiceInStatus,
  lockRequestReceiptPrincipalRows,
  withAggregateLock,
  withAggregateTransaction,
  withAutomatedFlowRunCapLock,
  withInvoiceMatterLocks,
  withSkipLockedBatch,
} from "./aggregate-lock";
import namespaceLedger from "./aggregate-lock-namespaces.json" with { type: "json" };
import { AGGREGATE_TRANSACTION_BUDGETS } from "./aggregate-transaction-budget";
import { READ_BUDGETS } from "./read-budgets";

test.each(["present", "missing"] as const)(
  "invoice matter batches retain only visible sorted row locks (%s)",
  async (presence) => {
    const first = createSafeId<"workspace">();
    const second = createSafeId<"workspace">();
    const sorted = [first, second].toSorted();
    const visible = presence === "present" ? sorted : [];
    const organizationId = mintAuthProviderId<"organization">();
    const statements: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const dialect = new PgDialect();
    const tx = asTestRaw<Transaction>({
      execute: async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement);
        statements.push(query);
        return query.sql.includes('"workspaces"')
          ? visible
              .filter((id) => query.params.includes(id))
              .map((id) => ({ id }))
          : [];
      },
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => ({ for: async () => [] }) }),
        }),
      }),
    });
    await withInvoiceMatterLocks(tx, [second, first, second]);
    expect(statements.at(0)?.sql).toContain("pg_advisory_xact_lock");
    expect(statements.at(0)?.params).toEqual(sorted);
    expect(statements.at(1)?.params).toEqual(sorted);
    expect(statements.at(1)?.sql).toContain("FOR NO KEY UPDATE");
    expect(statements).toHaveLength(4);
    // Covered reacquisition keeps the full batch in the same rank history.
    await withInvoiceMatterLocks(tx, [first, second]);
    const count = statements.length;
    const earlierParent = withAggregateLock({
      tx,
      aggregate: "organization",
      id: organizationId,
      mode: "update",
    });
    if (presence === "present") {
      expect(await rejectionOf(earlierParent)).toMatchObject({
        message: "Aggregate lock rank inversion",
      });
      expect(statements).toHaveLength(count);
    } else {
      expect(await earlierParent).toEqual({ status: "missing" });
      expect(statements).toHaveLength(count + 1);
    }
  },
);

test("an empty invoice matter plan refuses before any lock query", async () => {
  let executions = 0;
  const tx = asTestRaw<Transaction>({
    execute: async () => {
      executions += 1;
      return [];
    },
  });
  expect(await rejectionOf(withInvoiceMatterLocks(tx, []))).toMatchObject({
    message: "Invoice matter locks require at least one matter",
  });
  expect(executions).toBe(0);
});

test.each(
  Object.values(AGGREGATE_TRANSACTION_BUDGETS).filter(
    (budget) => budget.kind === "aggregate",
  ),
)("budget setup preserves snapshot admission ($reason)", async (budget) => {
  const statements: string[] = [];
  const dialect = new PgDialect();
  const tx = {
    execute: async (statement: SQL) => {
      statements.push(dialect.sqlToQuery(statement).sql);
    },
  };
  await withAggregateTransaction(
    {
      transaction: async <Value>(
        run: (transaction: typeof tx) => Promise<Value>,
      ) => await run(tx),
    },
    budget,
    async () => {
      expect(statements).toEqual([
        `SET LOCAL transaction_timeout = ${budget.milliseconds}`,
      ]);
    },
  );
});

test("sitemap transaction budget covers atomic publication and its supporting statements", () => {
  const statementDeadlineMs =
    READ_BUDGETS["scheduled.caseLaw.refreshSitemapShards"].statementDeadlineMs;
  const publicationStatements = 4;
  const retirementStatements = 2;
  const setupFenceAndReadStatements = 6;
  const budgetSetupStatements = 1;
  expect(
    AGGREGATE_TRANSACTION_BUDGETS.sitemapRefresh.envelopeMs,
  ).toBeGreaterThanOrEqual(
    (publicationStatements +
      retirementStatements +
      setupFenceAndReadStatements +
      budgetSetupStatements) *
      statementDeadlineMs,
  );
});

test("ordinary transaction budgets end before the online-DDL retry ladder", () => {
  for (const budget of Object.values(AGGREGATE_TRANSACTION_BUDGETS)) {
    if (budget.kind === "aggregate") {
      expect(budget.milliseconds).toBeLessThan(
        DEFAULT_LOCK_RETRY_CONFIG.budgetMs,
      );
    }
  }
});

test("lease-coordinated envelopes fit within lease expiry and heartbeat detection", () => {
  const leaseDetectionWindow =
    DEFAULT_LEASE_MS + defaultHeartbeatIntervalMs(DEFAULT_LEASE_MS);
  for (const budget of Object.values(AGGREGATE_TRANSACTION_BUDGETS)) {
    if (budget.kind === "lease-coordinated") {
      expect(budget.envelopeMs).toBeLessThan(leaseDetectionWindow);
    }
  }
});

test("HTTP database budgets fit inside the transport idle window", () => {
  // Transport idle expiry is not an absolute handler deadline; the database budget is independent.
  for (const budget of [
    AGGREGATE_TRANSACTION_BUDGETS.scopedRequest,
    AGGREGATE_TRANSACTION_BUDGETS.publicReadRequest,
  ]) {
    expect(budget.milliseconds).toBeLessThanOrEqual(HTTP_IDLE_TIMEOUT_S * 1000);
  }
});

test("every transaction owner uses its registered budget classification", async () => {
  const root = new URL("../../..", import.meta.url).pathname;
  const glob = new Bun.Glob("{src,scripts}/**/*.ts");
  const aggregateBudgets = new Set(
    Object.entries(AGGREGATE_TRANSACTION_BUDGETS)
      .filter(([, budget]) => budget.kind !== "lease-coordinated")
      .map(([name]) => name),
  );
  const dedicatedBudgets = Object.values(AGGREGATE_TRANSACTION_BUDGETS).filter(
    (budget) => budget.kind === "lease-coordinated",
  );
  const dedicatedOwners = dedicatedBudgets.map((budget) => budget.owner);
  const uncappedBudgets = Object.values(AGGREGATE_TRANSACTION_BUDGETS).filter(
    (budget) => budget.kind === "uncapped-pending-measurement",
  );
  const observedUncappedCallers = new Map<string, Set<string>>(
    uncappedBudgets.map(
      (budget) => [budget.entryPoint, new Set<string>()] as const,
    ),
  );
  expect(observedUncappedCallers.size).toBe(uncappedBudgets.length);
  expect(new Set(dedicatedOwners).size).toBe(dedicatedOwners.length);
  const observedDedicatedOwners: string[] = [];
  const missing: string[] = [];
  for await (const path of glob.scan({ cwd: root })) {
    if (
      /\.(?:test|spec|fixture|type-test)\.|\/(?:__tests__|__fixtures__|fixtures|tests)\//u.test(
        path,
      )
    ) {
      continue;
    }
    const owner = `apps/api/${path}`;
    const dedicated = dedicatedBudgets.find((entry) => entry.owner === owner);
    const text = await Bun.file(`${root}${path}`).text();
    if (
      !dedicated &&
      !text.includes("withAggregateTransaction") &&
      !uncappedBudgets.some((entry) => text.includes(entry.entryPoint))
    ) {
      continue;
    }
    const source = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const budgetImports = new Set<string>();
    const transactionImports = new Set(["withAggregateTransaction"]);
    const uncappedImports = new Map<string, string>(
      uncappedBudgets.map((budget) => [budget.entryPoint, budget.entryPoint]),
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) {
        continue;
      }
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) {
        continue;
      }
      for (const binding of bindings.elements) {
        const imported = binding.propertyName?.text ?? binding.name.text;
        if (observedUncappedCallers.has(imported)) {
          uncappedImports.set(binding.name.text, imported);
        }
        switch (imported) {
          case "AGGREGATE_TRANSACTION_BUDGETS":
            budgetImports.add(binding.name.text);
            break;
          case "withAggregateTransaction":
            transactionImports.add(binding.name.text);
            break;
        }
      }
    }
    const namedBudgets = new Set<string>();
    const isAggregateBudget = (node: ts.Node): boolean =>
      (ts.isIdentifier(node) && namedBudgets.has(node.text)) ||
      (ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        budgetImports.has(node.expression.text) &&
        aggregateBudgets.has(node.name.text));
    for (const statement of source.statements) {
      if (!ts.isVariableStatement(statement)) {
        continue;
      }
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.initializer &&
          isAggregateBudget(declaration.initializer)
        ) {
          namedBudgets.add(declaration.name.text);
        }
      }
    }
    let directTransactions = 0;
    let aggregateTransactions = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "transaction"
        ) {
          directTransactions += 1;
        }
        if (ts.isIdentifier(node.expression)) {
          const uncappedEntryPoint = uncappedImports.get(node.expression.text);
          if (uncappedEntryPoint !== undefined) {
            const callers =
              observedUncappedCallers.get(uncappedEntryPoint) ??
              panic("Missing registered uncapped transaction entry point");
            callers.add(owner);
          }
          if (transactionImports.has(node.expression.text)) {
            aggregateTransactions += 1;
            const budget = node.arguments.at(1);
            if (
              node.arguments.length !== 3 ||
              !budget ||
              !isAggregateBudget(budget)
            ) {
              missing.push(
                `${owner}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`,
              );
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (dedicated) {
      observedDedicatedOwners.push(owner);
      expect({
        owner,
        directTransactions,
        aggregateTransactions,
      }).toEqual({
        owner,
        directTransactions: dedicated.transactionEntries,
        aggregateTransactions: 0,
      });
    }
  }
  expect(observedDedicatedOwners.toSorted()).toEqual(
    dedicatedOwners.toSorted(),
  );
  for (const budget of uncappedBudgets) {
    const observed =
      observedUncappedCallers.get(budget.entryPoint) ??
      panic("Missing uncapped transaction caller census");
    expect([...observed].toSorted()).toEqual([...budget.callers].toSorted());
  }
  expect(missing).toEqual([]);
});

test("an overflowing invoice matter plan refuses before acquiring any matter lock", async () => {
  const workspaceId = createSafeId<"workspace">();
  const lines = Array.from(
    { length: LIMITS.invoiceLinesPerInvoice + 1 },
    () => ({ workspaceId: createSafeId<"workspace">() }),
  );
  expect(new Set(lines.map((line) => line.workspaceId)).size).toBe(
    LIMITS.invoiceLinesPerInvoice + 1,
  );
  let executions = 0;
  const tx = asTestRaw<Transaction>({
    selectDistinct: () => createSelectQueryMock(lines),
    execute: async () => {
      executions += 1;
      return [];
    },
  });
  expect(
    await lockInvoiceInStatus(tx, {
      invoiceId: createSafeId<"invoice">(),
      workspaceId,
      status: "draft",
      matterLocks: { type: "acquire" },
    }),
  ).toBeUndefined();
  expect(executions).toBe(0);
});

test("case-law republication coordination preserves shared and exclusive modes", async () => {
  const dialect = new PgDialect();
  const statements: string[] = [];
  const transaction = () => ({
    execute: async (statement: SQL) => {
      statements.push(dialect.sqlToQuery(statement).sql);
      return aggregateExecutionRows(statement);
    },
  });
  await lockCaseLawRepublication({ tx: transaction(), mode: "shared" });
  await lockCaseLawRepublication({ tx: transaction(), mode: "exclusive" });
  expect(statements.at(0)).toContain("pg_advisory_xact_lock_shared");
  expect(statements.at(1)).toContain("pg_advisory_xact_lock(");
  expect(statements.at(1)).not.toContain("pg_advisory_xact_lock_shared");
});

test("the flow cap owner opens one transaction and awaits its fence before running the decision", async () => {
  const events: string[] = [];
  const tx = asTestRaw<Transaction>({
    execute: async (statement: SQL) => {
      events.push("locked");
      return aggregateExecutionRows(statement);
    },
  });
  const database = asTestRaw<
    Parameters<typeof withAutomatedFlowRunCapLock>[0]["database"]
  >({
    transaction: async (
      run: (transaction: Transaction) => Promise<unknown>,
    ) => {
      events.push("opened");
      const result = await run(tx);
      events.push("committed");
      return result;
    },
  });
  const result = await withAutomatedFlowRunCapLock(
    { definitionId: createSafeId<"flowDefinition">(), database },
    async (transaction) => {
      expect(transaction).toBe(tx);
      expect(events).toEqual(["opened", "locked", "locked"]);
      events.push("decision");
      return "started";
    },
  );
  expect(result).toBe("started");
  expect(events).toEqual([
    "opened",
    "locked",
    "locked",
    "decision",
    "committed",
  ]);
});

test("skip-locked batches preserve their bound and close the blocking acquisition path", async () => {
  const fixture = fences();
  const tx = {
    execute: async (statement: SQL) => aggregateExecutionRows(statement),
  };
  const database = {
    transaction: async <T>(run: (transaction: typeof tx) => Promise<T>) =>
      await run(tx),
  };
  let selectedLimit = 0;
  const result = await withSkipLockedBatch({
    database,
    limit: 3,
    select: () => ({
      toSQL: () => ({
        sql: "SELECT jti FROM desktop_device_proof_replays WHERE expires_at <= $1 ORDER BY expires_at",
      }),
      limit: (limit) => {
        selectedLimit = limit;
        return {
          for: async (mode, config) => {
            expect(mode).toBe("update");
            expect(config).toEqual({ skipLocked: true });
            return ["receipt"];
          },
        };
      },
    }),
    run: async (transaction, rows) => {
      expect(rows).toEqual(["receipt"]);
      expect(
        await rejectionOf(
          withAggregateLock({ ...fixture.workspace, tx: transaction }),
        ),
      ).toMatchObject({
        message:
          "Await each aggregate lock acquisition before starting another",
      });
      return rows.length;
    },
  });
  expect(selectedLimit).toBe(3);
  expect(result).toBe(1);
  expect(
    await rejectionOf(withAggregateLock({ ...fixture.workspace, tx })),
  ).toMatchObject({ message: "Aggregate savepoint transaction is closed" });
});

test("migrated fences retain workspace share mode, signal scope, and flow cap keys", async () => {
  const fixture = fences();
  const dialect = new PgDialect();
  const statements: ReturnType<typeof dialect.sqlToQuery>[] = [];
  const tx = {
    execute: async (statement: SQL) => {
      statements.push(dialect.sqlToQuery(statement));
      return aggregateExecutionRows(statement);
    },
  };
  await withAggregateLock({ ...fixture.workspace, mode: "share", tx });
  await withAggregateLock({ ...fixture.signal, tx });
  await withAggregateLock({ ...fixture.automatedFlowRunCap, tx });
  const workspace =
    statements.at(0) ?? panic("Workspace lock was not executed");
  expect(workspace.sql).toContain("FOR SHARE");
  expect(workspace.params).toEqual([
    fixture.workspace.id.id,
    fixture.workspace.id.organizationId,
  ]);
  const signal = statements.at(1) ?? panic("Signal lock was not executed");
  expect(signal.sql).toContain("FOR UPDATE");
  expect(signal.params).toEqual([
    fixture.signal.id.id,
    fixture.signal.id.organizationId,
  ]);
  const cap = statements.at(2) ?? panic("Flow cap lock was not executed");
  expect(cap.sql).toContain("pg_advisory_xact_lock");
  expect(cap.params).toEqual([
    0x0f_10_cc_a9,
    fixture.automatedFlowRunCap.id,
    0x0f_10_cc_a9,
    fixture.automatedFlowRunCap.id,
  ]);
});

test("definition admission and automated run caps use separate advisory namespaces", async () => {
  const fixture = fences();
  const dialect = new PgDialect();
  const statements: ReturnType<typeof dialect.sqlToQuery>[] = [];
  const tx = {
    execute: async (statement: SQL) => {
      statements.push(dialect.sqlToQuery(statement));
      return aggregateExecutionRows(statement);
    },
  };
  await withAggregateLock({ ...fixture.definitionCap, tx });
  await withAggregateLock({ ...fixture.automatedFlowRunCap, tx });
  expect(statements.at(0)?.params.at(0)).toBe(0x0f_10_cc_ab);
  expect(statements.at(1)?.params.at(0)).toBe(0x0f_10_cc_a9);
});

const assertUniqueAdvisoryNamespaces = (namespaces: readonly unknown[]) => {
  expect(
    new Set(namespaces).size,
    "Advisory first-key namespaces must be unique",
  ).toBe(namespaces.length);
};

/**
 * The first key of an advisory aggregate as its SQL renders it, with numeric
 * parameters written out and identity parameters named, so the deployed
 * namespace can be compared across revisions.
 */
const namespaceSignature = (expression: string, parameters: unknown[]) =>
  expression.replaceAll(/\$(\d+)/gu, (_, position: string) => {
    const value = parameters.at(Number(position) - 1);
    return typeof value === "number"
      ? `0x${value.toString(16).padStart(8, "0")}`
      : "<identity>";
  });

test("every advisory aggregate declares a distinct first-key namespace, recorded in its ledger", async () => {
  const fixture = fences();
  const dialect = new PgDialect();
  const namespaces: string[] = [];
  const signatures = new Map<string, string>();
  for (const options of Object.values(fixture)) {
    if ("mode" in options) {
      continue;
    }
    const tx = {
      execute: async (statement: SQL) => {
        const query = dialect.sqlToQuery(statement);
        const expression =
          /^SELECT (.*?) AS key1/u.exec(query.sql)?.at(1) ??
          panic("Missing advisory first key");
        const parameters = [...expression.matchAll(/\$(\d+)/gu)].map((match) =>
          query.params.at(Number(match.at(1)) - 1),
        );
        namespaces.push(JSON.stringify([expression, parameters]));
        signatures.set(
          options.aggregate,
          namespaceSignature(expression, query.params),
        );
        return aggregateExecutionRows(statement);
      },
    };
    await withAggregateLock({ ...options, tx });
  }
  expect([...signatures.keys()].toSorted()).toEqual(
    Object.entries(AGGREGATE_LOCKS)
      .filter(([, { kind }]) => kind === "advisory")
      .map(([aggregate]) => aggregate)
      .toSorted(),
  );
  assertUniqueAdvisoryNamespaces(namespaces);
  // scripts/check-aggregate-locks.ts holds this ledger to its base revision:
  // an existing aggregate keeps its namespace and a new one takes a fresh one.
  expect(Object.fromEntries(signatures)).toEqual(namespaceLedger);
});

test("the advisory namespace census rejects a duplicate", () => {
  expect(() =>
    assertUniqueAdvisoryNamespaces([0x0f_10_cc_ab, 0x0f_10_cc_ab]),
  ).toThrow("Advisory first-key namespaces must be unique");
});

describe("aggregate acquisition ordering", () => {
  test.each(["ready", "busy"] as const)(
    "receipt principal cleanup owns the NOWAIT set and savepoint history: %s",
    async (availability) => {
      const fixture = fences();
      const { organizationId, userId } = fixture.requestReceipt.id;
      const rows = [
        { id: fixture.requestReceipt.id.id },
        { id: createSafeId<"requestIdempotencyReceipt">() },
      ];
      const selectedPredicates: ReturnType<PgDialect["sqlToQuery"]>[] = [];
      const execute = async (statement: SQL) =>
        await Promise.resolve(aggregateExecutionRows(statement));
      const select = () => ({
        from: () => ({
          where: (predicate: SQL) => {
            selectedPredicates.push(new PgDialect().sqlToQuery(predicate));
            return {
              for: async (mode: string, config?: { noWait?: boolean }) => {
                expect(mode).toBe("update");
                expect(config).toEqual({ noWait: true });
                if (availability === "busy") {
                  return await Promise.reject(
                    new DatabaseError({
                      message: "The receipt row is locked",
                      code: PG_ERROR.LOCK_NOT_AVAILABLE,
                    }),
                  );
                }
                return await Promise.resolve(rows);
              },
            };
          },
        }),
      });
      const tx = asTestRaw<Transaction>({
        rollback: () => {
          throw new TransactionRollbackError();
        },
        execute,
        select,
        transaction: async (run: (child: Transaction) => Promise<unknown>) =>
          await run(
            asTestRaw<Transaction>({
              rollback: () => {
                throw new TransactionRollbackError();
              },
              execute,
              select,
            }),
          ),
      });
      await withAggregateLock({ ...fixture.workspace, tx });
      const result = await lockRequestReceiptPrincipalRows({
        tx,
        organizationId,
        userId,
      });
      expect(selectedPredicates).toHaveLength(1);
      expect(selectedPredicates.at(0)?.params).toEqual([
        organizationId,
        userId,
      ]);
      if (availability === "busy") {
        expect(result.status).toBe("busy");
        expect(
          await rejectionOf(
            withAggregateLock({ ...fixture.requestReceipt, tx }),
          ),
        ).toMatchObject({ message: "Aggregate lock rank inversion" });
        return;
      }
      expect(result).toEqual({ status: "locked", rows });
      for (const { id } of rows) {
        // Only retained coverage permits this earlier-ranked blocking request
        // after the workspace fence; a lost savepoint history would reject it.
        expect(
          await withAggregateLock({
            ...fixture.requestReceipt,
            id: { id, organizationId, userId },
            tx,
          }),
        ).toEqual({ status: "locked" });
      }
    },
  );

  test("a principal-scoped NOWAIT request receipt permits later handler aggregate locks", async () => {
    const fixture = fences();
    const statements: ReturnType<PgDialect["sqlToQuery"]>[] = [];
    const tx = asTestRaw<Transaction>({
      rollback: () => {
        throw new TransactionRollbackError();
      },
      execute: async (statement: SQL) => {
        statements.push(new PgDialect().sqlToQuery(statement));
        return aggregateExecutionRows(statement);
      },
      transaction: async (
        run: (transaction: Transaction) => Promise<unknown>,
      ) =>
        await run(
          asTestRaw<Transaction>({
            rollback: () => {
              throw new TransactionRollbackError();
            },
            execute: tx.execute,
          }),
        ),
    });
    expect(
      await withAggregateLock({
        ...fixture.requestReceipt,
        tx,
        wait: "nowait",
      }),
    ).toEqual({ status: "locked" });
    for (const fence of [
      fixture.organization,
      fixture.workspace,
      fixture.entity,
    ]) {
      expect(await withAggregateLock({ ...fence, tx })).toEqual({
        status: "locked",
      });
    }
    expect(statements.at(0)?.sql).toContain(
      'FROM "public"."request_idempotency_receipts"',
    );
    expect(statements.at(0)?.sql).toContain('"organization_id" =');
    expect(statements.at(0)?.sql).toContain('"user_id" =');
    expect(statements.at(0)?.sql).toContain("FOR UPDATE NOWAIT");
    expect(statements.at(0)?.params).toEqual([
      fixture.requestReceipt.id.id,
      fixture.requestReceipt.id.organizationId,
      fixture.requestReceipt.id.userId,
    ]);
    expect(statements).toHaveLength(4);
  });

  test("locks chat receipts in thread, interaction and receipt order", async () => {
    const fixture = fences();
    const statements: SQL[] = [];
    const tx = {
      execute: async (statement: SQL) => {
        statements.push(statement);
        return aggregateExecutionRows(statement);
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
      expect.stringContaining('"chat_threads"'),
      expect.stringContaining('"chat_turns"'),
      expect.stringContaining('"chat_secrets"'),
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

  test("every declared chain ascends and the chains cover every registered aggregate", () => {
    const exercised = new Set(Object.values(AGGREGATE_CHAINS).flat());
    expect(Object.keys(AGGREGATE_LOCKS).toSorted()).toEqual(
      [...exercised].toSorted(),
    );
    for (const chain of Object.values(AGGREGATE_CHAINS)) {
      for (const [index, aggregate] of chain.entries()) {
        const next = chain.at(index + 1);
        if (next !== undefined) {
          expect(AGGREGATE_LOCKS[aggregate].rank).toBeLessThan(
            AGGREGATE_LOCKS[next].rank,
          );
        }
      }
    }
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
          execute: async (statement: SQL) => {
            executions += 1;
            return aggregateExecutionRows(statement);
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
    const tx = {
      execute: async (statement: SQL) => aggregateExecutionRows(statement),
    };
    await withAggregateLock({ ...fixture.workspace, tx });
    await withAggregateLock({ ...fixture.entity, tx });
    expect(await withAggregateLock({ ...fixture.workspace, tx })).toEqual({
      status: "locked",
    });
    expect(
      await rejectionOf(withAggregateLock({ ...fixture.organization, tx })),
    ).toMatchObject({ message: "Aggregate lock rank inversion" });
    const retryTx = {
      execute: async (statement: SQL) => aggregateExecutionRows(statement),
    };
    expect(
      await withAggregateLock({ ...fixture.organization, tx: retryTx }),
    ).toEqual({ status: "locked" });
  });

  test("missing rows consume no rank and scoped reacquisition still executes its predicate", async () => {
    const fixture = fences();
    let found = false;
    const tx = {
      execute: async (statement: SQL) =>
        aggregateExecutionRows(statement, found),
    };
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
        mode: "update",
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
    const tx = {
      execute: async (statement: SQL) => aggregateExecutionRows(statement),
    };
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
    const pendingTx = {
      execute: async (statement: SQL) => {
        await gate.promise;
        return aggregateExecutionRows(statement);
      },
    };
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
