/**
 * Usage:
 *   bun src/scripts/better-auth-migration-audit.ts pre-migration --baseline <path> --identity-map <path> --oauth-base-url <https-origin>
 *   bun src/scripts/better-auth-migration-audit.ts <post-mode> --baseline <path> --oauth-base-url <https-origin>
 *
 * The baseline belongs on the rehearsal task's private tmpfs. It contains
 * auth-table counts and primary-key digests, and must never be uploaded as an
 * artifact. The command itself emits only redacted named check results.
 */

import { Result, TaggedError } from "better-result";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";

import { hasSecureDatabaseTransport, resolveDatabaseUrl } from "@/api/db-url";
import { isRecord } from "@/api/lib/type-guards";
import {
  buildBetterAuthOAuthResources,
  normalizeBetterAuthOAuthBaseUrl,
} from "@/api/mcp/resource-policy-contract";
import {
  BETTER_AUTH_AUDIT_MODES,
  BetterAuthAuditError,
  parseBetterAuthAuditBaseline,
  parseBetterAuthTrustedIdentityMap,
  renderBetterAuthAuditReport,
  runBetterAuthMigrationAudit,
} from "@/api/scripts/better-auth-migration-audit.logic";
import type {
  BetterAuthAuditBaseline,
  BetterAuthAuditMode,
  BetterAuthTrustedIdentityMap,
} from "@/api/scripts/better-auth-migration-audit.logic";

const EXIT_CODE = {
  CONFIGURATION_OR_QUERY_FAILURE: 2,
  INVARIANT_FAILURE: 1,
  SUCCESS: 0,
} as const;

const TRANSACTION_TIMEOUT = "60s";
const LOCK_TIMEOUT = "2s";
const MAX_TRUSTED_IDENTITY_MAP_BYTES = 16 * 1024 * 1024;

export class BetterAuthAuditCommandError extends TaggedError(
  "BetterAuthAuditCommandError",
)<{
  code:
    | "baseline-conflict"
    | "baseline-read-failed"
    | "baseline-write-failed"
    | "identity-map-read-failed"
    | "invalid-arguments";
  message: string;
}> {}

type BetterAuthAuditCommandArgs =
  | {
      baselinePath: string;
      identityMapPath: string;
      mode: typeof BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION;
      oauthBaseUrl: string;
    }
  | {
      baselinePath: string;
      mode: Exclude<
        BetterAuthAuditMode,
        typeof BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION
      >;
      oauthBaseUrl: string;
    };

const isAuditMode = (value: string): value is BetterAuthAuditMode =>
  Object.values(BETTER_AUTH_AUDIT_MODES).some((mode) => mode === value);

export const parseBetterAuthAuditArgs = (
  args: readonly string[],
): Result<BetterAuthAuditCommandArgs, BetterAuthAuditCommandError> => {
  const mode = args.at(0);
  const baselineFlag = args.at(1);
  const baselinePath = args.at(2);
  const oauthBaseUrlFlag = args.at(
    mode === BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION ? 5 : 3,
  );
  const oauthBaseUrl = args.at(
    mode === BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION ? 6 : 4,
  );
  const invalidArguments = () =>
    Result.err(
      new BetterAuthAuditCommandError({
        code: "invalid-arguments",
        message:
          "Usage: better-auth-migration-audit pre-migration --baseline <private-path> --identity-map <private-path> --oauth-base-url <https-url> | <post-backfill|post-migration> --baseline <private-path> --oauth-base-url <https-url>",
      }),
    );
  if (
    mode === undefined ||
    !isAuditMode(mode) ||
    baselineFlag !== "--baseline" ||
    baselinePath === undefined ||
    baselinePath.length === 0 ||
    oauthBaseUrlFlag !== "--oauth-base-url" ||
    oauthBaseUrl === undefined
  ) {
    return invalidArguments();
  }
  const normalizedOAuthBaseUrl = normalizeBetterAuthOAuthBaseUrl(oauthBaseUrl);
  if (normalizedOAuthBaseUrl === null) {
    return invalidArguments();
  }
  if (mode === BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION) {
    const identityMapFlag = args.at(3);
    const identityMapPath = args.at(4);
    return identityMapFlag === "--identity-map" &&
      identityMapPath !== undefined &&
      identityMapPath.length > 0 &&
      args.length === 7
      ? Result.ok({
          baselinePath,
          identityMapPath,
          mode,
          oauthBaseUrl: normalizedOAuthBaseUrl,
        })
      : invalidArguments();
  }
  return args.length === 5
    ? Result.ok({
        baselinePath,
        mode,
        oauthBaseUrl: normalizedOAuthBaseUrl,
      })
    : invalidArguments();
};

const isNodeErrorCode = (value: unknown, code: string): boolean =>
  isRecord(value) && value["code"] === code;

export const readBetterAuthAuditBaseline = async (
  path: string,
): Promise<
  Result<
    BetterAuthAuditBaseline,
    BetterAuthAuditCommandError | BetterAuthAuditError
  >
> => {
  const loaded = await Result.tryPromise({
    try: async () => {
      const handle = await open(path, constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.mode % 0o100 !== 0) {
          throw new BetterAuthAuditCommandError({
            code: "baseline-read-failed",
            message: "Better Auth audit baseline is not a private regular file",
          });
        }
        const parsed: unknown = JSON.parse(await handle.readFile("utf-8"));
        return parsed;
      } finally {
        await handle.close();
      }
    },
    catch: () =>
      new BetterAuthAuditCommandError({
        code: "baseline-read-failed",
        message: "Better Auth audit baseline could not be read",
      }),
  });
  if (Result.isError(loaded)) {
    return loaded;
  }
  return parseBetterAuthAuditBaseline(loaded.value);
};

export const readBetterAuthTrustedIdentityMap = async (
  path: string,
): Promise<
  Result<
    BetterAuthTrustedIdentityMap,
    BetterAuthAuditCommandError | BetterAuthAuditError
  >
> => {
  const loaded = await Result.tryPromise({
    try: async () => {
      const handle = await open(path, constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          metadata.mode % 0o100 !== 0 ||
          metadata.size > MAX_TRUSTED_IDENTITY_MAP_BYTES
        ) {
          throw new BetterAuthAuditCommandError({
            code: "identity-map-read-failed",
            message:
              "Better Auth trusted identity map is not a private regular file",
          });
        }
        const parsed: unknown = JSON.parse(await handle.readFile("utf-8"));
        return parsed;
      } finally {
        await handle.close();
      }
    },
    catch: () =>
      new BetterAuthAuditCommandError({
        code: "identity-map-read-failed",
        message: "Better Auth trusted identity map could not be read",
      }),
  });
  if (Result.isError(loaded)) {
    return loaded;
  }
  return parseBetterAuthTrustedIdentityMap(loaded.value);
};

/**
 * Create once, or accept a byte-equivalent rerun. Never replace a different
 * baseline: that would erase the only row-set evidence the later phases use.
 */
export const persistBetterAuthAuditBaseline = async (
  path: string,
  baseline: BetterAuthAuditBaseline,
): Promise<
  Result<void, BetterAuthAuditCommandError | BetterAuthAuditError>
> => {
  const content = `${JSON.stringify(baseline)}\n`;
  const written = await Result.tryPromise({
    try: async () => {
      await writeFile(path, content, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      });
    },
    catch: (cause) => cause,
  });
  if (Result.isOk(written)) {
    return Result.ok(undefined);
  }
  if (!isNodeErrorCode(written.error, "EEXIST")) {
    return Result.err(
      new BetterAuthAuditCommandError({
        code: "baseline-write-failed",
        message: "Better Auth audit baseline could not be written",
      }),
    );
  }

  const existing = await readBetterAuthAuditBaseline(path);
  if (existing.status === "error") {
    return existing;
  }
  if (JSON.stringify(existing.value) !== JSON.stringify(baseline)) {
    return Result.err(
      new BetterAuthAuditCommandError({
        code: "baseline-conflict",
        message: "Better Auth audit baseline conflicts with the current census",
      }),
    );
  }
  return Result.ok(undefined);
};

const run = async (
  args: readonly string[],
): Promise<
  Result<number, BetterAuthAuditCommandError | BetterAuthAuditError>
> => {
  const parsed = parseBetterAuthAuditArgs(args);
  if (Result.isError(parsed)) {
    return parsed;
  }

  let baseline: BetterAuthAuditBaseline | null = null;
  let trustedIdentityMap: BetterAuthTrustedIdentityMap | null = null;
  if (parsed.value.mode !== BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION) {
    const loadedBaseline = await readBetterAuthAuditBaseline(
      parsed.value.baselinePath,
    );
    if (loadedBaseline.status === "error") {
      return loadedBaseline;
    }
    baseline = loadedBaseline.value;
  } else {
    const loadedIdentityMap = await readBetterAuthTrustedIdentityMap(
      parsed.value.identityMapPath,
    );
    if (Result.isError(loadedIdentityMap)) {
      return loadedIdentityMap;
    }
    trustedIdentityMap = loadedIdentityMap.value;
  }

  const databaseUrl = resolveDatabaseUrl();
  if (!databaseUrl || !hasSecureDatabaseTransport(databaseUrl)) {
    return Result.err(
      new BetterAuthAuditCommandError({
        code: "invalid-arguments",
        message: "Better Auth audit requires a secure database connection",
      }),
    );
  }

  const expectedOAuthResources = buildBetterAuthOAuthResources(
    parsed.value.oauthBaseUrl,
  );
  const client = new SQL({ url: databaseUrl, max: 1 });
  const database = drizzle({ client });
  const executed = await Result.tryPromise({
    try: async () =>
      await database.transaction(async (transaction) => {
        await transaction.execute(
          sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
        );
        await transaction.execute(
          sql`SELECT set_config('statement_timeout', ${TRANSACTION_TIMEOUT}, true)`,
        );
        await transaction.execute(
          sql`SELECT set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`,
        );
        await transaction.execute(
          sql`SELECT set_config('idle_in_transaction_session_timeout', ${TRANSACTION_TIMEOUT}, true)`,
        );
        return await runBetterAuthMigrationAudit({
          baseline,
          database: {
            execute: async (statement) => await transaction.execute(statement),
          },
          expectedOAuthResources,
          mode: parsed.value.mode,
          trustedIdentityMap,
        });
      }),
    catch: (cause) =>
      new BetterAuthAuditError({
        cause,
        code: "database-query-failed",
        message: "Better Auth audit transaction failed",
      }),
  });
  await client.end();
  if (Result.isError(executed)) {
    return executed;
  }
  if (Result.isError(executed.value)) {
    return executed.value;
  }

  const { report, baseline: nextBaseline } = executed.value.value;
  if (
    parsed.value.mode === BETTER_AUTH_AUDIT_MODES.PRE_MIGRATION &&
    report.status === "passed"
  ) {
    const persisted = await persistBetterAuthAuditBaseline(
      parsed.value.baselinePath,
      nextBaseline,
    );
    if (Result.isError(persisted)) {
      return persisted;
    }
  }

  process.stdout.write(renderBetterAuthAuditReport(report));
  return Result.ok(
    report.status === "passed"
      ? EXIT_CODE.SUCCESS
      : EXIT_CODE.INVARIANT_FAILURE,
  );
};

if (import.meta.main) {
  run(Bun.argv.slice(2))
    .then((result) => {
      if (Result.isError(result)) {
        process.stderr.write(
          `${JSON.stringify({ code: result.error.code, status: "error" })}\n`,
        );
        process.exitCode = EXIT_CODE.CONFIGURATION_OR_QUERY_FAILURE;
        return undefined;
      }
      process.exitCode = result.value;
      return undefined;
    })
    .catch(() => {
      process.stderr.write(
        `${JSON.stringify({ code: "audit-execution-failed", status: "error" })}\n`,
      );
      process.exitCode = EXIT_CODE.CONFIGURATION_OR_QUERY_FAILURE;
      return undefined;
    });
}
