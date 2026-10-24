/**
 * The online phase's table-locking statements and the one way to run them.
 *
 * The phase's session keeps a one-second `lock_timeout` for its fast catalog
 * work. A statement that waits for a table lock, or for every transaction on
 * a table (each `CONCURRENTLY` form), can wait longer than that on a busy
 * table, and failing it fails the migrate run. Every such statement is built
 * here as an opaque `LockTakingStatement`, which no raw `execute` accepts, and
 * runs only inside `runGatedTableWork`: under the index gate, with watched
 * waits beside writers or bounded lock requests for writer-blocking work.
 * A busy table defers the phase instead of failing it. The `confine-online-ddl`
 * lint rule keeps the SQL text of these statements out of every other database module. A database function
 * whose body runs such DDL is declared in `online-ddl-functions.ts` and called
 * only through `callDeclaredFunction`.
 */

import { panic, Result, TaggedError } from "better-result";

import { declareFingerprintFields } from "@stll/errors";

import type { RequiredMigrationIndex } from "../lib/db/migration-history";
import { isRecord } from "../lib/type-guards";
import {
  DEFAULT_LOCK_RETRY_CONFIG,
  DEFAULT_LOCK_RETRY_RUNTIME,
  runLockRetryLadder,
} from "./lock-retry-ladder";
import type { LockRetryConfig, LockRetryRuntime } from "./lock-retry-ladder";
import {
  createMigrationLockTelemetry,
  observeMigrationLockAttempt,
} from "./migration-lock-observation";
import { readConstraintValidated } from "./online-constraint-completion";
import { readDdlFunctionDeclaration } from "./online-ddl-functions";
import type { OnlineDdlFunctionName } from "./online-ddl-functions";
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
  /**
   * `beside_writers` takes SHARE UPDATE EXCLUSIVE or weaker and uses the
   * gate's watched wait. `blocks_writers` takes SHARE, SHARE ROW EXCLUSIVE,
   * EXCLUSIVE or ACCESS EXCLUSIVE and uses bounded lock requests with retries.
   * Keep this discriminator stable: execution budgets depend on this class.
   */
  readonly lockQueue: "beside_writers" | "blocks_writers";
};

const POSTGRES_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

const quoteIdentifier = (identifier: string): string => {
  if (!POSTGRES_IDENTIFIER.test(identifier)) {
    panic(`Invalid internal PostgreSQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
};

type LockTakingOptions = {
  tableName: string;
  text: string;
  lockQueue: LockTakingStatement["lockQueue"];
};

const setDedicatedLockTimeout = async (
  connection: Pick<OnlineMigrationConnection, "execute">,
  lockTimeoutMs: number,
): Promise<void> => {
  if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    return panic("lockTimeoutMs must be a safe non-negative integer");
  }
  await connection.execute(
    lockTimeoutMs === 0
      ? "SET lock_timeout = '0'"
      : `SET lock_timeout = '${lockTimeoutMs}ms'`,
  );
};

const lockTaking = ({
  tableName,
  text,
  lockQueue,
}: LockTakingOptions): LockTakingStatement => ({
  [LOCK_TAKING]: text,
  tableName,
  lockQueue,
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
    return lockTaking({
      tableName,
      text: `CREATE ${isUnique ? "UNIQUE " : ""}INDEX CONCURRENTLY ${quoteIdentifier(name)} ${definitionBody}`,
      lockQueue: "beside_writers",
    });
  }
  // The gate watches the declared table, so the build must be on it.
  const match = createSqlTarget.exec(createSql);
  const builtName = match?.at(1);
  const builtTable = match?.at(2);
  if (builtName !== name || builtTable !== tableName) {
    panic(
      `Online index ${name}: its create SQL must build it concurrently on public.${tableName}`,
    );
  }
  return lockTaking({
    tableName,
    text: createSql,
    lockQueue: "beside_writers",
  });
};

export const dropIndexConcurrently = (
  { name, tableName }: IndexTarget,
  { ifExists }: { ifExists: boolean },
): LockTakingStatement =>
  lockTaking({
    tableName,
    text: `DROP INDEX CONCURRENTLY ${ifExists ? "IF EXISTS " : ""}public.${quoteIdentifier(name)}`,
    lockQueue: "beside_writers",
  });

export const reindexIndexConcurrently = ({
  name,
  tableName,
}: IndexTarget): LockTakingStatement =>
  lockTaking({
    tableName,
    text: `REINDEX INDEX CONCURRENTLY public.${quoteIdentifier(name)}`,
    lockQueue: "beside_writers",
  });

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
  return lockTaking({
    tableName: from.tableName,
    text: `ALTER INDEX public.${quoteIdentifier(from.name)} RENAME TO ${quoteIdentifier(to.name)}`,
    lockQueue: "beside_writers",
  });
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
  lockTaking({
    tableName,
    text: `ALTER TABLE public.${quoteIdentifier(tableName)} VALIDATE CONSTRAINT ${quoteIdentifier(constraintName)}`,
    lockQueue: "beside_writers",
  });

/** Takes SHARE UPDATE EXCLUSIVE, the same lock as a validation. */
export const analyzeTable = (tableName: string): LockTakingStatement =>
  lockTaking({
    tableName,
    text: `ANALYZE public.${quoteIdentifier(tableName)}`,
    lockQueue: "beside_writers",
  });

const BLOCK_TAG = "$online_ddl$";

/** SQL text spliced into a block: one expression or statement, nothing more. */
const spliced = (text: string): string => {
  if (text.includes(";") || text.includes(BLOCK_TAG)) {
    panic(`Online DDL text must be a single statement or expression: ${text}`);
  }
  return text;
};

/**
 * One transaction per attempt, so a statement list is atomic: a cancelled
 * or timed-out block leaves the table as it was.
 */
const accessExclusive = (
  tableName: string,
  statements: readonly string[],
): LockTakingStatement =>
  lockTaking({
    tableName,
    text: `DO ${BLOCK_TAG} BEGIN ${statements
      .map((statement) => `${spliced(statement)};`)
      .join(" ")} END ${BLOCK_TAG}`,
    lockQueue: "blocks_writers",
  });

/** A row-level security policy, with its expressions as rendered SQL. */
export type PolicyDefinition = {
  tableName: string;
  name: string;
  as: "permissive" | "restrictive";
  for: "all" | "select" | "insert" | "update" | "delete";
  role: string;
  using?: string;
  withCheck?: string;
};

const policyTarget = ({ tableName, name }: PolicyDefinition): string =>
  `${quoteIdentifier(name)} ON "public".${quoteIdentifier(tableName)}`;

const policyExpressions = ({ using, withCheck }: PolicyDefinition): string =>
  [
    using === undefined ? "" : ` USING (${spliced(using)})`,
    withCheck === undefined ? "" : ` WITH CHECK (${spliced(withCheck)})`,
  ].join("");

const createPolicyText = (policy: PolicyDefinition): string =>
  `CREATE POLICY ${policyTarget(policy)} AS ${policy.as.toUpperCase()} FOR ${policy.for.toUpperCase()} TO ${quoteIdentifier(policy.role)}${policyExpressions(policy)}`;

const dropPolicyText = (
  { tableName, name }: Pick<PolicyDefinition, "tableName" | "name">,
  { ifExists }: { ifExists: boolean },
): string =>
  `DROP POLICY ${ifExists ? "IF EXISTS " : ""}${quoteIdentifier(name)} ON "public".${quoteIdentifier(tableName)}`;

/** Policy DDL takes ACCESS EXCLUSIVE on its table. */
export const createPolicy = (policy: PolicyDefinition): LockTakingStatement =>
  accessExclusive(policy.tableName, [createPolicyText(policy)]);

/** Changes the expressions of an existing policy; its role stays. */
export const alterPolicy = (policy: PolicyDefinition): LockTakingStatement => {
  if (policy.using === undefined && policy.withCheck === undefined) {
    panic(`Policy ${policy.name} alteration changes no expression`);
  }
  return accessExclusive(policy.tableName, [
    `ALTER POLICY ${policyTarget(policy)}${policyExpressions(policy)}`,
  ]);
};

export const dropPolicy = (
  policy: Pick<PolicyDefinition, "tableName" | "name">,
  options: { ifExists: boolean },
): LockTakingStatement =>
  accessExclusive(policy.tableName, [dropPolicyText(policy, options)]);

/**
 * Drops the policy of that name, if any, and creates `policy`, in one
 * transaction: the table keeps its old policy or gets the new one, never
 * neither, whichever way the statement ends.
 */
export const replacePolicy = (policy: PolicyDefinition): LockTakingStatement =>
  accessExclusive(policy.tableName, [
    dropPolicyText(policy, { ifExists: true }),
    createPolicyText(policy),
  ]);

/** ENABLE or FORCE ROW LEVEL SECURITY, each an ACCESS EXCLUSIVE ALTER TABLE. */
export const setRowLevelSecurity = (
  tableName: string,
  mode: "enable" | "force",
): LockTakingStatement =>
  accessExclusive(tableName, [
    `ALTER TABLE "public".${quoteIdentifier(tableName)} ${mode.toUpperCase()} ROW LEVEL SECURITY`,
  ]);

const quoteLiteral = (value: string): string =>
  `'${value.replaceAll("'", "''")}'`;

/**
 * A call to a function declared `online` in `DDL_FUNCTIONS`, gated on the
 * table it locks, under the same retry ladder as the policy statements: its
 * body's DDL is ACCESS EXCLUSIVE work the type cannot see.
 */
export const callDeclaredFunction = ({
  name,
  tableName,
}: {
  name: OnlineDdlFunctionName;
  tableName: string;
}): LockTakingStatement => {
  const declaration = readDdlFunctionDeclaration(name);
  if (!declaration.online) {
    return panic(
      `Function ${String(name)} is not callable from the online phase`,
    );
  }
  const { locks } = declaration;
  switch (locks.type) {
    case "table":
      if (locks.tableName !== tableName) {
        return panic(
          `Function ${String(name)} locks ${locks.tableName}, not ${tableName}`,
        );
      }
      return accessExclusive(tableName, [
        `PERFORM "public".${quoteIdentifier(name)}()`,
      ]);
    case "table-argument":
      quoteIdentifier(tableName);
      return accessExclusive(tableName, [
        `PERFORM "public".${quoteIdentifier(name)}(${quoteLiteral(tableName)})`,
      ]);
    default:
      locks satisfies never;
      return panic(`Function ${String(name)}: unexpected lock declaration`);
  }
};

/**
 * What gated work sees of its session: catalog and data reads, and the
 * statements it was gated for. No raw `execute`.
 */
export type GatedTableSession = {
  query: OnlineMigrationConnection["query"];
  run: (statement: LockTakingStatement) => Promise<void>;
};

/** Where gated work runs, and what the gate reports a deferral as. */
type GatedTableTarget = {
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
  lockRetry?: { config: LockRetryConfig; runtime: LockRetryRuntime };
};

class OnlineLockRetryDeferred extends TaggedError("OnlineLockRetryDeferred")<{
  message: string;
  reason: "exhausted" | "budget_spent";
  attempts: number;
  lockTimeoutMs: number;
  cause: unknown;
}> {
  static {
    declareFingerprintFields(this, ["reason"]);
  }
}

type GatedTableSessionOptions = {
  connection: Pick<OnlineMigrationConnection, "execute" | "query">;
  target: GatedTableTarget;
  lockRetry: GatedTableWorkOptions["lockRetry"];
  onRetry: () => void;
};

const sessionOn = ({
  connection,
  target: { tableName },
  lockRetry,
  onRetry,
}: GatedTableSessionOptions): GatedTableSession => ({
  query: async (query, params) => await connection.query(query, params),
  run: async (statement) => {
    // The gate read the health of this table only.
    if (statement.tableName !== tableName) {
      panic(
        `Gated work on ${tableName} cannot lock ${statement.tableName}; gate each table on its own`,
      );
    }
    switch (statement.lockQueue) {
      case "beside_writers":
        await connection.execute(statement[LOCK_TAKING]);
        return undefined;
      case "blocks_writers": {
        const outcome = await runLockRetryLadder({
          config: lockRetry?.config ?? DEFAULT_LOCK_RETRY_CONFIG,
          now: lockRetry?.runtime.now ?? DEFAULT_LOCK_RETRY_RUNTIME.now,
          sleep: lockRetry?.runtime.sleep ?? DEFAULT_LOCK_RETRY_RUNTIME.sleep,
          random:
            lockRetry?.runtime.random ?? DEFAULT_LOCK_RETRY_RUNTIME.random,
          attempt: async (lockTimeoutMs, attempt) => {
            if (attempt > 1) {
              onRetry();
            }
            await setDedicatedLockTimeout(connection, lockTimeoutMs);
            try {
              await connection.execute(statement[LOCK_TAKING]);
            } finally {
              await setDedicatedLockTimeout(connection, 0);
            }
          },
        });
        if (outcome.type === "stop") {
          throw new OnlineLockRetryDeferred({
            message: "Online statement lock retry budget exhausted",
            reason: outcome.reason,
            attempts: outcome.attempts,
            lockTimeoutMs: outcome.lockTimeoutMs,
            cause: outcome.cause,
          });
        }
        return undefined;
      }
      default:
        statement.lockQueue satisfies never;
        return panic("Unexpected online DDL lock queue class");
    }
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
  lockRetry,
}: GatedTableWorkOptions): Promise<OnlineMigrationOutcome> => {
  const observer = await reserveObserver();
  let statementRetries = 0;
  const onRetry = () => {
    statementRetries += 1;
  };
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
      const backend = (
        await connection.query("SELECT pg_backend_pid() AS pid")
      ).at(0);
      const pid = isRecord(backend) ? backend["pid"] : null;
      if (typeof pid !== "number") {
        panic("Invalid migration backend pid response");
      }
      const outcome = await observeMigrationLockAttempt({
        observer,
        pid,
        phase: "online",
        step: target.name,
        table: target.tableName,
        telemetry: gate.lockTelemetry ?? createMigrationLockTelemetry(),
        cancelWork: connection.terminate,
        additionalRetries: () => statementRetries,
        work: async () => {
          const attempt = await Result.tryPromise({
            try: async () =>
              await runtime.attempt(
                async (guardedConnection) =>
                  await work(
                    sessionOn({
                      connection: guardedConnection,
                      target,
                      lockRetry,
                      onRetry,
                    }),
                  ),
              ),
            catch: (cause) => cause,
          });
          if (attempt.isOk()) {
            return attempt.value;
          }
          if (attempt.error instanceof OnlineLockRetryDeferred) {
            return "retry";
          }
          throw attempt.error;
        },
        outcome: (result) => (result === "done" ? "done" : "deferred"),
      });

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
  lockRetry?: GatedTableWorkOptions["lockRetry"],
): OnlineTableGate => ({
  run: async ({ target, work }) => {
    await work(
      sessionOn({ connection, target, lockRetry, onRetry: () => undefined }),
    );
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
