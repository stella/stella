/**
 * Usage:
 *   bun src/scripts/better-auth-17-backfill.ts --baseline <path> --identity-map <path> --batch-size <1..1000> --oauth-base-url <https-origin> --writes-frozen
 *
 * The command refuses to mutate until the private baseline is reproduced
 * exactly from the same trusted Microsoft map and public OAuth resource policy.
 * It emits only named audit checks and a coarse changed/fixed-point result.
 */

import { Result, TaggedError } from "better-result";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import { hasSecureDatabaseTransport, resolveDatabaseUrl } from "@/api/db-url";
import {
  buildBetterAuthOAuthResources,
  normalizeBetterAuthOAuthBaseUrl,
} from "@/api/mcp/resource-policy-contract";
import {
  BetterAuthBackfillError,
  lockBetterAuth17BackfillTables,
  runBetterAuth17BackfillInTransaction,
} from "@/api/scripts/better-auth-17-backfill.logic";
import type {
  BetterAuthBackfillResult,
  BetterAuthBackfillTransaction,
} from "@/api/scripts/better-auth-17-backfill.logic";
import {
  type BetterAuthAuditCommandError,
  readBetterAuthAuditBaseline,
  readBetterAuthTrustedIdentityMap,
} from "@/api/scripts/better-auth-migration-audit";
import {
  BETTER_AUTH_AUDIT_MODES,
  BetterAuthAuditError,
  renderBetterAuthAuditReport,
  runBetterAuthMigrationAudit,
} from "@/api/scripts/better-auth-migration-audit.logic";
import type {
  BetterAuthAuditBaseline,
  BetterAuthExpectedOAuthResource,
  BetterAuthTrustedIdentityMap,
} from "@/api/scripts/better-auth-migration-audit.logic";

const EXIT_CODE = {
  CONFIGURATION_OR_QUERY_FAILURE: 2,
  INVARIANT_FAILURE: 1,
  SUCCESS: 0,
} as const;

const TRANSACTION_TIMEOUT = "5min";
const LOCK_TIMEOUT = "2s";

class BetterAuthBackfillCommandError extends TaggedError(
  "BetterAuthBackfillCommandError",
)<{
  code: "invalid-arguments" | "preflight-mismatch";
  message: string;
}> {}

type BetterAuthBackfillCommandArgs = {
  baselinePath: string;
  batchSize: number;
  identityMapPath: string;
  oauthBaseUrl: string;
};

export const parseBetterAuthBackfillArgs = (
  args: readonly string[],
): Result<BetterAuthBackfillCommandArgs, BetterAuthBackfillCommandError> => {
  const baselinePath = args.at(1);
  const identityMapPath = args.at(3);
  const batchSize = Number(args.at(5));
  const oauthBaseUrl = args.at(7);
  if (
    args.at(0) !== "--baseline" ||
    !baselinePath ||
    args.at(2) !== "--identity-map" ||
    !identityMapPath ||
    args.at(4) !== "--batch-size" ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 1000 ||
    args.at(6) !== "--oauth-base-url" ||
    !oauthBaseUrl ||
    args.at(8) !== "--writes-frozen" ||
    args.length !== 9
  ) {
    return Result.err(
      new BetterAuthBackfillCommandError({
        code: "invalid-arguments",
        message:
          "Usage: better-auth-17-backfill --baseline <private-path> --identity-map <private-path> --batch-size <1..1000> --oauth-base-url <https-url> --writes-frozen",
      }),
    );
  }
  const normalizedOAuthBaseUrl = normalizeBetterAuthOAuthBaseUrl(oauthBaseUrl);
  if (normalizedOAuthBaseUrl === null) {
    return Result.err(
      new BetterAuthBackfillCommandError({
        code: "invalid-arguments",
        message: "Better Auth backfill OAuth base URL is invalid",
      }),
    );
  }
  return Result.ok({
    baselinePath,
    batchSize,
    identityMapPath,
    oauthBaseUrl: normalizedOAuthBaseUrl,
  });
};

const runAuditInTransaction = async ({
  baseline,
  expectedOAuthResources,
  mode,
  transaction,
  trustedIdentityMap,
}: {
  baseline: BetterAuthAuditBaseline | null;
  expectedOAuthResources: readonly BetterAuthExpectedOAuthResource[];
  mode:
    | typeof BETTER_AUTH_AUDIT_MODES.POST_BACKFILL
    | typeof BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION;
  transaction: BetterAuthBackfillTransaction;
  trustedIdentityMap: BetterAuthTrustedIdentityMap | null;
}) =>
  await runBetterAuthMigrationAudit({
    baseline,
    database: {
      execute: async (statement) => await transaction.execute(statement),
    },
    expectedOAuthResources,
    mode,
    trustedIdentityMap,
  });

const sameBaseline = (
  expected: BetterAuthAuditBaseline,
  actual: BetterAuthAuditBaseline,
) => JSON.stringify(expected) === JSON.stringify(actual);

const executeBackfill = async ({
  baseline,
  batchSize,
  client,
  expectedOAuthResources,
  trustedIdentityMap,
}: {
  baseline: BetterAuthAuditBaseline;
  batchSize: number;
  client: SQL;
  expectedOAuthResources: readonly BetterAuthExpectedOAuthResource[];
  trustedIdentityMap: BetterAuthTrustedIdentityMap;
}) => {
  const database = drizzle({ client });
  const executed = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`,
        );
        await transaction.execute(
          sql`SELECT set_config('statement_timeout', ${TRANSACTION_TIMEOUT}, true)`,
        );
        await transaction.execute(
          sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`,
        );
        const backfillTransaction: BetterAuthBackfillTransaction = {
          execute: async (statement) => await transaction.execute(statement),
        };
        const locked =
          await lockBetterAuth17BackfillTables(backfillTransaction);
        if (Result.isError(locked)) {
          throw locked.error;
        }

        const preflight = await runAuditInTransaction({
          baseline: null,
          expectedOAuthResources,
          mode: BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION,
          transaction: backfillTransaction,
          trustedIdentityMap,
        });
        if (Result.isError(preflight)) {
          throw preflight.error;
        }
        if (
          preflight.value.report.status !== "passed" ||
          !sameBaseline(baseline, preflight.value.baseline)
        ) {
          throw new BetterAuthBackfillCommandError({
            code: "preflight-mismatch",
            message:
              "Better Auth backfill preflight does not match its baseline",
          });
        }

        const backfilled = await runBetterAuth17BackfillInTransaction({
          batchSize,
          expectedOAuthResources,
          transaction: backfillTransaction,
          trustedIdentityMap,
        });
        if (Result.isError(backfilled)) {
          throw backfilled.error;
        }

        const postBackfill = await runAuditInTransaction({
          baseline,
          expectedOAuthResources,
          mode: BETTER_AUTH_AUDIT_MODES.POST_BACKFILL,
          transaction: backfillTransaction,
          trustedIdentityMap: null,
        });
        if (Result.isError(postBackfill)) {
          throw postBackfill.error;
        }
        if (postBackfill.value.report.status !== "passed") {
          throw new BetterAuthBackfillCommandError({
            code: "preflight-mismatch",
            message: "Better Auth post-backfill audit failed",
          });
        }
        return {
          backfilled: backfilled.value,
          postBackfillReport: postBackfill.value.report,
          preflightReport: preflight.value.report,
        };
      }),
    catch: (cause) => {
      if (
        cause instanceof BetterAuthAuditError ||
        cause instanceof BetterAuthBackfillError ||
        cause instanceof BetterAuthBackfillCommandError
      ) {
        return cause;
      }
      return new BetterAuthBackfillError({
        cause,
        code: "database-query-failed",
        message: "Better Auth backfill transaction failed",
      });
    },
  });
  if (Result.isError(executed)) {
    return executed;
  }
  process.stdout.write(
    renderBetterAuthAuditReport(executed.value.preflightReport),
  );
  process.stdout.write(
    renderBetterAuthAuditReport(executed.value.postBackfillReport),
  );
  return Result.ok(executed.value.backfilled);
};

type BetterAuthBackfillRunError =
  | BetterAuthAuditCommandError
  | BetterAuthAuditError
  | BetterAuthBackfillCommandError
  | BetterAuthBackfillError;

const run = async (
  args: readonly string[],
): Promise<Result<BetterAuthBackfillResult, BetterAuthBackfillRunError>> => {
  const parsed = parseBetterAuthBackfillArgs(args);
  if (Result.isError(parsed)) {
    return parsed;
  }
  const [baseline, trustedIdentityMap] = await Promise.all([
    readBetterAuthAuditBaseline(parsed.value.baselinePath),
    readBetterAuthTrustedIdentityMap(parsed.value.identityMapPath),
  ]);
  if (Result.isError(baseline)) {
    return baseline;
  }
  if (Result.isError(trustedIdentityMap)) {
    return trustedIdentityMap;
  }
  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl || !hasSecureDatabaseTransport(databaseUrl)) {
    return Result.err(
      new BetterAuthBackfillCommandError({
        code: "invalid-arguments",
        message: "Better Auth backfill requires a secure database connection",
      }),
    );
  }
  const client = new SQL({ max: 1, url: databaseUrl });
  const result = await executeBackfill({
    baseline: baseline.value,
    batchSize: parsed.value.batchSize,
    client,
    expectedOAuthResources: buildBetterAuthOAuthResources(
      parsed.value.oauthBaseUrl,
    ),
    trustedIdentityMap: trustedIdentityMap.value,
  });
  await client.end();
  return result;
};

if (import.meta.main) {
  run(Bun.argv.slice(2))
    .then((result) => {
      if (Result.isError(result)) {
        process.stderr.write(
          `${JSON.stringify({ code: result.error.code, status: "error" })}\n`,
        );
        process.exitCode =
          result.error instanceof BetterAuthBackfillCommandError &&
          result.error.code === "preflight-mismatch"
            ? EXIT_CODE.INVARIANT_FAILURE
            : EXIT_CODE.CONFIGURATION_OR_QUERY_FAILURE;
        return undefined;
      }
      process.stdout.write(
        `${JSON.stringify({ changed: result.value.changed, status: "passed" })}\n`,
      );
      process.exitCode = EXIT_CODE.SUCCESS;
      return undefined;
    })
    .catch(() => {
      process.stderr.write(
        `${JSON.stringify({ code: "backfill-execution-failed", status: "error" })}\n`,
      );
      process.exitCode = EXIT_CODE.CONFIGURATION_OR_QUERY_FAILURE;
      return undefined;
    });
}
