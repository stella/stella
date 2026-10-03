import { panic } from "better-result";
import { fillPlaceholders } from "drizzle-orm";
import { BunSQLSession } from "drizzle-orm/bun-sql/session";
import { PgAsyncPreparedQuery } from "drizzle-orm/pg-core/async/session";

export const FLOW_LOCK_RANKS = {
  workspace: 0,
  run: 1,
  currentStep: 2,
  obligation: 3,
  entity: 4,
} as const;

const FLOW_TABLE_AGGREGATES: Readonly<Record<string, string>> = {
  workspaces: "workspace",
  flow_runs: "run",
  flow_run_steps: "currentStep",
  work_obligations: "obligation",
  entities: "entity",
};

export type TransactionEvent = {
  type: "rowLock" | "advisoryLock" | "firstWrite";
  aggregate: string;
  table?: string;
  mode: string;
  sql: string;
  params: readonly unknown[];
};

export type TransactionTrace = { events: TransactionEvent[] };

type AdvisoryTarget = {
  sql: string;
  params: readonly unknown[];
  functionName: string;
};

type TransactionRecorderOptions = {
  tables?: Readonly<Record<string, string>>;
  resolveAdvisory?: (query: AdvisoryTarget) => string;
};

const IDENTIFIER = '(?:"(?:[^"]|"")+"|[a-zA-Z_][a-zA-Z_0-9$]*)';
const QUALIFIED_IDENTIFIER = `${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})?`;
const tableName = (identifier: string) =>
  identifier.split(".").at(-1)?.trim().replaceAll('"', "") ??
  panic("Missing table name in recorded statement");

// Literal contents cannot introduce a lock or write. Keep identifier quotes.
const statementShape = (statement: string) =>
  statement.replace(
    /'(?:[^']|'')*'|\$([a-zA-Z_0-9]*)\$[\s\S]*?\$\1\$|--[^\n]*|\/\*[\s\S]*?\*\//gu,
    " ",
  );

const isExecutor = (
  value: unknown,
): value is (params?: unknown[]) => Promise<unknown> =>
  typeof value === "function";

const isTransactionRunner = (
  value: unknown,
): value is <T>(work: (tx: object) => Promise<T>) => Promise<T> =>
  typeof value === "function";

const hasRows = (result: unknown) =>
  !Array.isArray(result) || result.length > 0;

const acquiredTryLock = (result: unknown, functionName: string) => {
  if (!Array.isArray(result)) {
    panic("Advisory try-lock result must contain rows");
  }
  const row: unknown = result.at(0);
  if (Array.isArray(row)) {
    if (row.length !== 1) {
      panic("Record advisory try-locks in a separate single-column statement");
    }
    return row.at(0) === true;
  }
  if (row !== null && typeof row === "object" && functionName in row) {
    return Reflect.get(row, functionName) === true;
  }
  panic("Record advisory try-locks without a result-column alias");
};

export const assertLockRanks = (
  { events }: TransactionTrace,
  ranks: Readonly<Record<string, number>> = FLOW_LOCK_RANKS,
) => {
  let previousRank = -Infinity;
  let previousAggregate = "";
  for (const event of events) {
    if (event.type === "firstWrite") {
      continue;
    }
    const rank = ranks[event.aggregate];
    if (rank === undefined) {
      panic(`No lock rank declared for ${event.aggregate}`);
    }
    if (rank < previousRank) {
      panic(
        `Lock rank inversion: ${previousAggregate} before ${event.aggregate}`,
      );
    }
    previousRank = rank;
    previousAggregate = event.aggregate;
  }
};

/** Instruments the transaction-local prepared executor, after acquisition. */
export const createTransactionRecorder = ({
  tables = FLOW_TABLE_AGGREGATES,
  resolveAdvisory,
}: TransactionRecorderOptions = {}) => {
  const transactions: TransactionTrace[] = [];

  const record = ({
    trace,
    sql,
    params,
    result,
  }: {
    trace: TransactionTrace;
    sql: string;
    params: readonly unknown[];
    result: unknown;
  }) => {
    const shape = statementShape(sql);
    const aggregateFor = (table: string) =>
      tables[table] ?? panic(`No aggregate declared for table ${table}`);
    for (const write of shape.matchAll(
      new RegExp(
        `\\b(insert\\s+into|delete\\s+from|update(?=\\s+${QUALIFIED_IDENTIFIER}\\s+(?:${IDENTIFIER}\\s+)?set\\b))\\s+(${QUALIFIED_IDENTIFIER})`,
        "giu",
      ),
    )) {
      const identifier = write.at(2);
      if (identifier === undefined) {
        panic("Missing write target");
      }
      const table = tableName(identifier);
      if (
        trace.events.some(
          (event) => event.type === "firstWrite" && event.table === table,
        )
      ) {
        continue;
      }
      trace.events.push({
        type: "firstWrite",
        aggregate: aggregateFor(table),
        table,
        mode: write.at(1) ?? "",
        sql,
        params,
      });
    }
    if (!hasRows(result)) {
      return;
    }
    const sources = new Map<string, string>();
    for (const source of shape.matchAll(
      new RegExp(
        `\\b(?:from|join)\\s+(${QUALIFIED_IDENTIFIER})(?:\\s+(?:as\\s+)?(${IDENTIFIER}))?`,
        "giu",
      ),
    )) {
      const identifier = source.at(1);
      if (identifier === undefined) {
        panic("Missing row-lock target");
      }
      const table = tableName(identifier);
      sources.set(table, table);
      const alias = source.at(2);
      if (alias !== undefined) {
        sources.set(tableName(alias), table);
      }
    }
    for (const lock of shape.matchAll(
      new RegExp(
        `\\bfor\\s+(no\\s+key\\s+update|key\\s+share|update|share)(?:\\s+of\\s+(${IDENTIFIER}(?:\\s*,\\s*${IDENTIFIER})*))?`,
        "giu",
      ),
    )) {
      const targets = lock.at(2);
      const lockedTables =
        targets === undefined
          ? [...new Set(sources.values())]
          : targets
              .split(",")
              .map(
                (target) =>
                  sources.get(tableName(target)) ??
                  panic(`Unknown lock target ${target}`),
              );
      if (lockedTables.length !== 1) {
        panic("Record row locks with one explicit table target per statement");
      }
      for (const table of lockedTables) {
        trace.events.push({
          type: "rowLock",
          aggregate: aggregateFor(table),
          table,
          mode: (lock.at(1) ?? "").toLowerCase().replace(/\s+/gu, " "),
          sql,
          params,
        });
      }
    }
    const advisoryCalls = [
      ...shape.matchAll(
        /\b(pg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?)\s*\(/giu,
      ),
    ];
    if (advisoryCalls.length > 1) {
      panic(
        "Record advisory locks in separate statements to preserve acquisition order",
      );
    }
    for (const advisory of advisoryCalls) {
      const functionName =
        advisory.at(1)?.toLowerCase() ?? panic("Missing advisory function");
      if (
        functionName.includes("try_") &&
        !acquiredTryLock(result, functionName)
      ) {
        continue;
      }
      if (resolveAdvisory === undefined) {
        panic("Advisory locks require an explicit aggregate resolver");
      }
      trace.events.push({
        type: "advisoryLock",
        aggregate: resolveAdvisory({ sql, params, functionName }),
        mode: functionName,
        sql,
        params,
      });
    }
  };

  const instrument = (tx: object, trace: TransactionTrace) => {
    const session: unknown = Reflect.get(tx, "session");
    if (!(session instanceof BunSQLSession)) {
      panic("Transaction recorder requires a real Bun SQL transaction");
    }
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      session,
      "prepareQuery",
    );
    const nestedDescriptor = Object.getOwnPropertyDescriptor(tx, "transaction");
    const nested: unknown = Reflect.get(tx, "transaction");
    if (!isTransactionRunner(nested)) {
      panic("Unsupported nested transaction primitive");
    }
    const prepare = session.prepareQuery.bind(session);
    Object.defineProperty(session, "prepareQuery", {
      configurable: true,
      value: new Proxy(prepare, {
        apply(target, receiver, args) {
          const prepared: unknown = Reflect.apply(target, receiver, args);
          if (!(prepared instanceof PgAsyncPreparedQuery)) {
            panic("Unsupported Drizzle prepared query");
          }
          const executor: unknown = Reflect.get(prepared, "executor");
          if (!isExecutor(executor)) {
            panic("Unsupported Drizzle executor");
          }
          const query = prepared.getQuery();
          Object.defineProperty(prepared, "executor", {
            configurable: true,
            value: async (params?: unknown[]) => {
              const result = await executor(params);
              record({
                trace,
                sql: query.sql,
                params: params ?? fillPlaceholders(query.params, {}),
                result,
              });
              return result;
            },
          });
          return prepared;
        },
      }),
    });
    Object.defineProperty(tx, "transaction", {
      configurable: true,
      value: async <T>(work: (nestedTx: object) => Promise<T>) =>
        await nested.call(tx, async (nestedTx) => {
          const restoreNested = instrument(nestedTx, trace);
          try {
            return await work(nestedTx);
          } finally {
            restoreNested();
          }
        }),
    });
    return () => {
      if (originalDescriptor === undefined) {
        Reflect.deleteProperty(session, "prepareQuery");
      } else {
        Object.defineProperty(session, "prepareQuery", originalDescriptor);
      }
      if (nestedDescriptor === undefined) {
        Reflect.deleteProperty(tx, "transaction");
      } else {
        Object.defineProperty(tx, "transaction", nestedDescriptor);
      }
    };
  };

  const wrap =
    <Tx extends object>(
      transaction: <T>(work: (tx: Tx) => Promise<T>) => Promise<T>,
    ) =>
    async <T>(work: (tx: Tx) => Promise<T>) =>
      await transaction(async (tx) => {
        const trace: TransactionTrace = { events: [] };
        transactions.push(trace);
        const restore = instrument(tx, trace);
        try {
          return await work(tx);
        } finally {
          restore();
        }
      });

  return { transactions, instrument, wrap };
};
