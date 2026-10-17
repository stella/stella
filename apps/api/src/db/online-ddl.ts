/**
 * The online phase's table-locking statements and the one way to run them.
 *
 * The phase's session keeps a one-second `lock_timeout` for its fast catalog
 * work. A statement that waits for a table lock, or for every transaction on
 * a table (each `CONCURRENTLY` form), can wait longer than that on a busy
 * table, and failing it fails the migrate run. Every such statement is built
 * here as an opaque `LockTakingStatement`, which no raw `execute` accepts, and
 * runs only inside `runGatedTableWork`: under the index gate, with the short
 * lock timeout lifted and the wait watched, so a busy table defers the phase
 * instead of failing it. The `confine-online-ddl` lint rule keeps the SQL text
 * of these statements out of every other database module.
 */

import { panic } from "better-result";

import type { RequiredMigrationIndex } from "../lib/db/migration-history";
import { readConstraintValidated } from "./online-constraint-completion";
import { createOnlineIndexGate } from "./online-index-gate";
import type { OnlineIndexGateOptions } from "./online-index-gate";
import type {
  OnlineMigrationConnection,
  OnlineMigrationOutcome,
} from "./online-migration-connection";

/** Module-private, so a statement is constructible and readable only here. */
const LOCK_TAKING: unique symbol = Symbol("stella.lockTakingStatement");

/**
 * A statement that takes a lock on `tableName` (or waits for every
 * transaction on it). It is not a string: `OnlineMigrationConnection.execute`
 * rejects it at compile time, and only a gated session's `run` executes it.
 */
export type LockTakingStatement = {
  readonly [LOCK_TAKING]: string;
  readonly tableName: string;
};

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const quoteIdentifier = (identifier: string): string => {
  if (!POSTGRES_IDENTIFIER.test(identifier)) {
    panic(`Invalid internal PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

const lockTaking = (tableName: string, text: string): LockTakingStatement => ({
  [LOCK_TAKING]: text,
  tableName,
});

/** An index declared for the online phase, with its own build statement. */
export type OnlineIndexDeclaration = RequiredMigrationIndex & {
  /**
   * The declared build, read only by `createIndexConcurrently`. Without it,
   * the build renders from `definitionBody`, PostgreSQL's own definition.
   */
  createSql?: string;
};

type IndexTarget = Pick<RequiredMigrationIndex, "name" | "tableName">;

/**
 * Whether the online phase may build the index. One without a declared build
 * belongs to a schema migration, so its absence is a broken deploy.
 */
export const declaresOnlineBuild = ({
  createSql,
}: OnlineIndexDeclaration): boolean => createSql !== undefined;

const createSqlTarget =
  /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY "?([A-Za-z_][A-Za-z0-9_]*)"? ON public\."?([A-Za-z_][A-Za-z0-9_]*)"? /u;

export const createIndexConcurrently = ({
  createSql,
  definitionBody,
  isUnique,
  name,
  tableName,
}: OnlineIndexDeclaration): LockTakingStatement => {
  if (createSql === undefined) {
    return lockTaking(
      tableName,
      `CREATE ${isUnique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${quoteIdentifier(name)} ${definitionBody}`,
    );
  }
  // The gate watches the declared table, so the build must be on it.
  const [, builtName, builtTable] = createSqlTarget.exec(createSql) ?? [];
  if (builtName !== name || builtTable !== tableName) {
    panic(
      `Online index ${name}: its create SQL must build it concurrently on public.${tableName}`,
    );
  }
  return lockTaking(tableName, createSql);
};

export const dropIndexConcurrently = (
  { name, tableName }: IndexTarget,
  { ifExists }: { ifExists: boolean },
): LockTakingStatement =>
  lockTaking(
    tableName,
    `DROP INDEX CONCURRENTLY ${ifExists ? "IF EXISTS " : ""}public.${quoteIdentifier(name)}`,
  );

export const reindexIndexConcurrently = ({
  name,
  tableName,
}: IndexTarget): LockTakingStatement =>
  lockTaking(
    tableName,
    `REINDEX INDEX CONCURRENTLY public.${quoteIdentifier(name)}`,
  );

/**
 * Takes SHARE UPDATE EXCLUSIVE on the index: no writer waits on it, but
 * another statement holding the index does, so it is gated like the rest.
 */
export const renameIndex = ({
  from,
  to,
}: {
  from: IndexTarget;
  to: IndexTarget;
}): LockTakingStatement => {
  if (from.tableName !== to.tableName) {
    panic(`Index ${from.name} cannot be renamed onto another table`);
  }
  return lockTaking(
    from.tableName,
    `ALTER INDEX public.${quoteIdentifier(from.name)} RENAME TO ${quoteIdentifier(to.name)}`,
  );
};

/** A NOT VALID CHECK or foreign key the online phase validates. */
export type OnlineConstraintValidation = {
  tableName: string;
  constraintName: string;
};

/**
 * Takes SHARE UPDATE EXCLUSIVE, so writers keep going while it scans, but it
 * queues behind an autovacuum or another maintenance statement on the table.
 * A no-op on an already validated constraint.
 */
export const validateConstraint = ({
  tableName,
  constraintName,
}: OnlineConstraintValidation): LockTakingStatement =>
  lockTaking(
    tableName,
    `ALTER TABLE public.${quoteIdentifier(tableName)} VALIDATE CONSTRAINT ${quoteIdentifier(constraintName)}`,
  );

/** Takes SHARE UPDATE EXCLUSIVE, the same lock as a validation. */
export const analyzeTable = (tableName: string): LockTakingStatement =>
  lockTaking(tableName, `ANALYZE public.${quoteIdentifier(tableName)}`);

/**
 * What gated work sees of its session: catalog and data reads, and the
 * statements it was gated for. No raw `execute`.
 */
export type GatedTableSession = {
  query: OnlineMigrationConnection["query"];
  run: (statement: LockTakingStatement) => Promise<void>;
};

/** Where gated work runs, and what the gate reports a deferral as. */
export type GatedTableTarget = {
  tableName: string;
  /** The index or constraint a deferral names. */
  name: string;
};

type GatedTableWorkRequest = {
  target: GatedTableTarget;
  kind: "index_build" | "index_repair";
  work: (session: GatedTableSession) => Promise<void>;
};

type GatedTableWorkOptions = GatedTableWorkRequest & {
  connection: OnlineMigrationConnection;
  gate: OnlineIndexGateOptions;
  reserveObserver: () => Promise<OnlineMigrationConnection>;
};

const sessionOn = (
  connection: Pick<OnlineMigrationConnection, "execute" | "query">,
  { tableName }: GatedTableTarget,
): GatedTableSession => ({
  query: async (query, params) => await connection.query(query, params),
  run: async (statement) => {
    // The gate read the health of this table only.
    if (statement.tableName !== tableName) {
      panic(
        `Gated work on ${tableName} cannot lock ${statement.tableName}; gate each table on its own`,
      );
    }
    await connection.execute(statement[LOCK_TAKING]);
  },
});

/**
 * The one way the online phase runs a `LockTakingStatement`. A gate that
 * holds the work, or cancels it on its watchdog or on health, defers the
 * phase at `target`; work cancelled into an INVALID index is repaired, with
 * repair priority, by the next run.
 */
export const runGatedTableWork = async ({
  connection,
  gate,
  reserveObserver,
  target,
  kind,
  work,
}: GatedTableWorkOptions): Promise<OnlineMigrationOutcome> => {
  const observer = await reserveObserver();
  try {
    const runtime = createOnlineIndexGate({
      ...gate,
      connection,
      observer,
      tableName: target.tableName,
      name: target.name,
      kind,
    });
    try {
      const outcome = await runtime.attempt(
        async (guardedConnection) =>
          await work(sessionOn(guardedConnection, target)),
      );
      switch (outcome) {
        case "done":
          return { type: "complete" };
        // Waiting here would hold the migrate run for as long as the database
        // stays unhealthy; the next run re-reads the ledger first.
        case "retry":
        case "wait":
          return {
            type: "deferred",
            step: target.name,
            retryAfterMs: runtime.retryAfterMs,
          };
        default:
          outcome satisfies never;
          return panic(`Online step ${target.name}: unexpected gate outcome`);
      }
    } finally {
      await runtime.close();
    }
  } finally {
    await observer.release();
  }
};

/** Gated table work as an online repair receives it. */
export type OnlineTableGate = {
  run: (request: GatedTableWorkRequest) => Promise<OnlineMigrationOutcome>;
};

export const createOnlineTableGate = ({
  connection,
  gate,
  reserveObserver,
}: Pick<
  GatedTableWorkOptions,
  "connection" | "gate" | "reserveObserver"
>): OnlineTableGate => ({
  run: async (request) =>
    await runGatedTableWork({ ...request, connection, gate, reserveObserver }),
});

/**
 * Runs the work at once on `connection`, with no gate and no deferral. For
 * tests of a repair's data work on a database that has no second session or
 * health source; `confine-online-ddl` rejects it anywhere else.
 */
export const createUngatedTableGateForTests = (
  connection: Pick<OnlineMigrationConnection, "execute" | "query">,
): OnlineTableGate => ({
  run: async ({ target, work }) => {
    await work(sessionOn(connection, target));
    return { type: "complete" };
  },
});

type ValidateOnlineConstraintsOptions = {
  connection: OnlineMigrationConnection;
  tables: OnlineTableGate;
  constraints: readonly OnlineConstraintValidation[];
  offset?: number;
};

/**
 * Validates each constraint the catalog still reports NOT VALID, in order,
 * each through the gate. A validated constraint costs one catalog read, so a
 * held gate never defers a repair over a validation already done, and a
 * deferred one leaves the rest for the next run.
 */
export const validateOnlineConstraints = async ({
  connection,
  tables,
  constraints,
  offset = 0,
}: ValidateOnlineConstraintsOptions): Promise<OnlineMigrationOutcome> => {
  const constraint = constraints.at(offset);
  if (!constraint) {
    return { type: "complete" };
  }
  if (
    !(await readConstraintValidated({
      connection,
      ...constraint,
      reader: "Online constraint validation",
    }))
  ) {
    const outcome = await tables.run({
      target: {
        tableName: constraint.tableName,
        name: constraint.constraintName,
      },
      kind: "index_build",
      work: async (session) => {
        await session.run(validateConstraint(constraint));
      },
    });
    if (outcome.type === "deferred") {
      return outcome;
    }
  }
  return await validateOnlineConstraints({
    connection,
    tables,
    constraints,
    offset: offset + 1,
  });
};
