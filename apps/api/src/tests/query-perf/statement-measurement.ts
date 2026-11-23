import { panic } from "better-result";
import { fillPlaceholders, sql } from "drizzle-orm";
import type { PreparedQueryConfig } from "drizzle-orm/pg-core";
import { AsyncLocalStorage } from "node:async_hooks";

import type { TransactionOf } from "@/api/db/scoped";
import type { ExplainPlanDocument } from "@/api/tests/explain-as-stella";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import { explainOwnerStatement, metricsFromPlan } from "./measurement";
import { withQueryPerfRollback } from "./rollback";
import { confirmedExecutionTimes } from "./sampling";
import { applyPlannerSettings, assertPlannerSettings } from "./settings";

type Statement = { text: string; params: unknown[] };

const leadingKeyword = (text: string) =>
  /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/)*([a-z]+)/iu
    .exec(text)
    ?.at(1)
    ?.toLowerCase() ?? "";
const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  "set",
  "reset",
  "show",
  "lock",
]);
const PLAN_KEYWORDS: ReadonlySet<string> = new Set([
  "select",
  "with",
  "values",
  "insert",
  "update",
  "delete",
]);

export const capturedStatementQuery = ({
  text,
  params,
}: {
  text: string;
  params: readonly unknown[];
}) =>
  sql.join(
    text.split(/\$(\d+)/u).map((part, index) => {
      if (index % 2 === 0) {
        return sql.raw(part);
      }
      const position = Number(part) - 1;
      if (position < 0 || position >= params.length) {
        panic(`Missing statement parameter $${part}`);
      }
      return sql.param(params[position]);
    }),
    sql.raw(""),
  );

/** Intercept prepared queries, covering raw SQL, builders and relational reads alike. */
const instrumentSession = (
  database: Pick<GatedTestDb, "_">,
  before: (query: Statement) => Promise<() => void>,
) => {
  const session = database._.session;
  const prepare = session.prepareQuery.bind(session);
  let tail = Promise.resolve();
  session.prepareQuery = <T extends PreparedQueryConfig = PreparedQueryConfig>(
    ...args: Parameters<typeof session.prepareQuery>
  ) => {
    // Forward the caller's result type; it cannot be inferred from the SQL arguments.
    const prepared = prepare<T>(...args);
    const execute = prepared.execute.bind(prepared);
    prepared.execute = async (values) => {
      // Keep each probe/rollback/real-execute pair together when the job
      // issues concurrent queries on this connection.
      const next = tail.then(async () => {
        const query = prepared.getQuery();
        const after = await before({
          text: query.sql,
          params: fillPlaceholders(query.params, values ?? {}),
        });
        const value = await execute(values);
        after();
        return value;
      });
      // The caller receives next's rejection; later cleanup can still run.
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return await next;
    };
    return prepared;
  };
  return () => {
    session.prepareQuery = prepare;
  };
};

type MeasureJobStatementsOptions<T> = {
  database: GatedTestDb;
  run: (database: GatedTestDb) => Promise<T>;
  /** Whether one sample exceeds the statement's scaled-time allowance and needs confirming. */
  overTimeAllowance: (executionTimeMs: number) => boolean;
};

/**
 * Explain each statement immediately before its real execution, rolling back
 * only the explanation. Identity inserts can leave sequence gaps: sequences
 * are not transactional, and the job must receive its real generated id.
 */
export const measureJobStatements = async <T>({
  database,
  run,
  overTimeAllowance,
}: MeasureJobStatementsOptions<T>) => {
  // Keep EXPLAIN and planner setup outside the job's statement-ceiling
  // context. Its real queries and native transactions retain that context.
  const outsideJob = AsyncLocalStorage.snapshot();
  const issued: Statement[] = [];
  const executed: Statement[] = [];
  const statements: {
    query: Statement;
    plan: ExplainPlanDocument;
    executionTimesMs: number[];
  }[] = [];
  const measure = async (
    owner: Pick<GatedTestDb, "transaction">,
    query: Statement,
  ) =>
    await outsideJob(async () => {
      issued.push(query);
      const keyword = leadingKeyword(query.text);
      if (CONTROL_KEYWORDS.has(keyword)) {
        return () => {
          executed.push(query);
        };
      }
      if (!PLAN_KEYWORDS.has(keyword)) {
        panic(`No query-perf measurement for ${keyword || "blank"} statement`);
      }
      const explain = async () =>
        await withQueryPerfRollback(
          owner,
          async (savepoint) =>
            await explainOwnerStatement(
              savepoint,
              capturedStatementQuery(query),
            ),
        );
      const plan = await explain();
      // Every sample rolls back; the job's own execution follows them.
      const executionTimesMs = await confirmedExecutionTimes({
        first: metricsFromPlan(plan).executionTimeMs,
        overAllowance: overTimeAllowance,
        resample: async () => metricsFromPlan(await explain()).executionTimeMs,
      });
      statements.push({ query, plan, executionTimesMs });
      return () => {
        executed.push(query);
      };
    });
  const inTransaction = async <Value>(
    tx: TransactionOf<GatedTestDb>,
    work: (transaction: TransactionOf<GatedTestDb>) => Promise<Value>,
  ): Promise<Value> => {
    await outsideJob(async () => await applyPlannerSettings(tx));
    const nativeTransaction = tx.transaction.bind(tx);
    const restore = instrumentSession(
      tx,
      async (query) => await measure({ transaction: nativeTransaction }, query),
    );
    tx.transaction = async (nested) =>
      await nativeTransaction(
        async (child) => await inTransaction(child, nested),
      );
    try {
      const value = await work(tx);
      restore();
      await outsideJob(async () => await assertPlannerSettings(tx, "owner"));
      return value;
    } finally {
      restore();
      tx.transaction = nativeTransaction;
    }
  };
  const restore = instrumentSession(
    database,
    async (query) =>
      await outsideJob(
        async () =>
          await database.transaction(async (tx) => {
            await applyPlannerSettings(tx);
            const after = await measure(tx, query);
            await assertPlannerSettings(tx, "owner");
            return after;
          }),
      ),
  );
  const measuredDatabase = new Proxy(database, {
    get: (source, property) => {
      if (property === "transaction") {
        const transaction: typeof database.transaction = async (work, config) =>
          await source.transaction(
            async (tx) => await inTransaction(tx, work),
            config,
          );
        return transaction;
      }
      const value: unknown = Reflect.get(source, property, source);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]): unknown =>
        Reflect.apply(value, source, args);
    },
  });
  try {
    const value = await run(measuredDatabase);
    return { value, issued, executed, statements };
  } finally {
    restore();
  }
};
