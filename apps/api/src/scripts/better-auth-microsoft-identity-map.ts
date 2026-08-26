/**
 * Usage:
 *   bun src/scripts/better-auth-microsoft-identity-map.ts --output <private-path> --writes-frozen
 *
 * Derives the Better Auth 1.7 Microsoft sub-to-oid map from cryptographically
 * verified stored ID tokens. The private output file is consumed by the
 * migration audit and backfill in the same isolated task. No identity or token
 * value is written to stdout.
 */

import { Result, TaggedError } from "better-result";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import {
  createRemoteJWKSet,
  customFetch,
  type FetchImplementation,
} from "jose";
import { constants } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import * as v from "valibot";

import { hasSecureDatabaseTransport, resolveDatabaseUrl } from "@/api/db-url";
import { safeOutboundFetchBytes } from "@/api/lib/safe-outbound-fetch";
import { isRecord } from "@/api/lib/type-guards";
import {
  BetterAuthMicrosoftIdentityMapError,
  deriveBetterAuthMicrosoftIdentityMap,
} from "@/api/scripts/better-auth-microsoft-identity-map.logic";
import type { BetterAuthMicrosoftIdentitySource } from "@/api/scripts/better-auth-microsoft-identity-map.logic";
import type { BetterAuthTrustedIdentityMap } from "@/api/scripts/better-auth-migration-audit.logic";

const EXIT_CODE = {
  CONFIGURATION_OR_QUERY_FAILURE: 2,
  INVARIANT_FAILURE: 1,
  SUCCESS: 0,
} as const;
const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
const JWKS_FETCH_TIMEOUT_MS = 10_000;
const JWKS_MAX_BYTES = 1024 * 1024;
const TRANSACTION_TIMEOUT = "60s";
const LOCK_TIMEOUT = "2s";
const commandArgsSchema = v.strictTuple([
  v.literal("--output"),
  v.pipe(v.string(), v.minLength(1)),
  v.literal("--writes-frozen"),
]);

class BetterAuthMicrosoftIdentityMapCommandError extends TaggedError(
  "BetterAuthMicrosoftIdentityMapCommandError",
)<{
  cause?: unknown;
  code:
    | "database-query-failed"
    | "invalid-arguments"
    | "output-conflict"
    | "output-write-failed";
  message: string;
}> {}

export const parseBetterAuthMicrosoftIdentityMapArgs = (
  args: readonly string[],
) => {
  const parsed = v.safeParse(commandArgsSchema, args);
  if (!parsed.success) {
    return Result.err(
      new BetterAuthMicrosoftIdentityMapCommandError({
        code: "invalid-arguments",
        message:
          "Usage: better-auth-microsoft-identity-map --output <private-path> --writes-frozen",
      }),
    );
  }
  return Result.ok({ outputPath: parsed.output[1] });
};

const readSources = async (database: ReturnType<typeof drizzle>) => {
  const queried = await Result.tryPromise({
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
        return await transaction.execute(sql`
          SELECT id AS "accountRowId",
                 account_id AS "legacyAccountId",
                 id_token AS "idToken"
            FROM account
           WHERE provider_id = 'microsoft'
           ORDER BY id
        `);
      }),
    catch: (cause) =>
      new BetterAuthMicrosoftIdentityMapCommandError({
        cause,
        code: "database-query-failed",
        message: "Microsoft identity sources could not be read",
      }),
  });
  if (Result.isError(queried)) {
    return queried;
  }
  let rows: unknown[] | null = null;
  if (Array.isArray(queried.value)) {
    rows = queried.value;
  } else if (isRecord(queried.value) && Array.isArray(queried.value["rows"])) {
    rows = queried.value["rows"];
  }
  if (rows === null) {
    return Result.err(
      new BetterAuthMicrosoftIdentityMapCommandError({
        code: "database-query-failed",
        message: "Microsoft identity query returned invalid data",
      }),
    );
  }

  const sources: BetterAuthMicrosoftIdentitySource[] = [];
  for (const row of rows) {
    const accountRowId = isRecord(row) ? row["accountRowId"] : null;
    const legacyAccountId = isRecord(row) ? row["legacyAccountId"] : null;
    const idToken = isRecord(row) ? row["idToken"] : undefined;
    if (
      typeof accountRowId !== "string" ||
      typeof legacyAccountId !== "string" ||
      (typeof idToken !== "string" && idToken !== null)
    ) {
      return Result.err(
        new BetterAuthMicrosoftIdentityMapCommandError({
          code: "database-query-failed",
          message: "Microsoft identity query returned invalid data",
        }),
      );
    }
    sources.push({ accountRowId, idToken, legacyAccountId });
  }
  return Result.ok(sources);
};

const readPrivateFile = async (path: string) =>
  await Result.tryPromise({
    try: async () => {
      const handle = await open(path, constants.O_NOFOLLOW);
      try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || metadata.mode % 0o100 !== 0) {
          throw new BetterAuthMicrosoftIdentityMapCommandError({
            code: "output-conflict",
            message:
              "Microsoft identity map output conflicts with an existing file",
          });
        }
        return await handle.readFile("utf-8");
      } finally {
        await handle.close();
      }
    },
    catch: () =>
      new BetterAuthMicrosoftIdentityMapCommandError({
        code: "output-conflict",
        message:
          "Microsoft identity map output conflicts with an existing file",
      }),
  });

const persistIdentityMap = async (
  path: string,
  identityMap: BetterAuthTrustedIdentityMap,
) => {
  const content = `${JSON.stringify(identityMap)}\n`;
  const written = await Result.tryPromise({
    try: async () =>
      await writeFile(path, content, {
        encoding: "utf-8",
        flag: "wx",
        mode: 0o600,
      }),
    catch: (cause) => cause,
  });
  if (Result.isOk(written)) {
    return Result.ok(undefined);
  }
  if (!isRecord(written.error) || written.error["code"] !== "EEXIST") {
    return Result.err(
      new BetterAuthMicrosoftIdentityMapCommandError({
        code: "output-write-failed",
        message: "Microsoft identity map could not be written",
      }),
    );
  }
  const existing = await readPrivateFile(path);
  if (Result.isError(existing)) {
    return existing;
  }
  return existing.value === content
    ? Result.ok(undefined)
    : Result.err(
        new BetterAuthMicrosoftIdentityMapCommandError({
          code: "output-conflict",
          message:
            "Microsoft identity map output conflicts with an existing file",
        }),
      );
};

const microsoftJwksFetch: FetchImplementation = async (url, options) => {
  const response = await safeOutboundFetchBytes({
    headers: new Headers(options.headers),
    maxBytes: JWKS_MAX_BYTES,
    method: options.method,
    redirect: "error",
    timeoutMs: JWKS_FETCH_TIMEOUT_MS,
    url,
  });
  if (Result.isError(response)) {
    throw new BetterAuthMicrosoftIdentityMapCommandError({
      cause: response.error,
      code: "database-query-failed",
      message: "Microsoft signing keys could not be fetched",
    });
  }
  return new Response(response.value.body, {
    headers: response.value.headers,
    status: response.value.status,
  });
};

const run = async (args: readonly string[]) => {
  const parsed = parseBetterAuthMicrosoftIdentityMapArgs(args);
  if (Result.isError(parsed)) {
    return parsed;
  }
  const clientId = process.env["MICROSOFT_AUTH_CLIENT_ID"];
  const tenantId = process.env["MICROSOFT_AUTH_TENANT_ID"];
  const databaseUrl = resolveDatabaseUrl();
  if (
    !clientId ||
    !tenantId ||
    !databaseUrl ||
    !hasSecureDatabaseTransport(databaseUrl)
  ) {
    return Result.err(
      new BetterAuthMicrosoftIdentityMapCommandError({
        code: "invalid-arguments",
        message:
          "Microsoft identity derivation requires provider configuration and a secure database connection",
      }),
    );
  }

  const client = new SQL({ max: 1, url: databaseUrl });
  const database = drizzle({ client });
  const sources = await readSources(database);
  if (Result.isError(sources)) {
    await client.end();
    return sources;
  }
  const jwks = createRemoteJWKSet(
    new URL(`${MICROSOFT_AUTHORITY}/${tenantId}/discovery/v2.0/keys`),
    {
      timeoutDuration: JWKS_FETCH_TIMEOUT_MS,
      [customFetch]: microsoftJwksFetch,
    },
  );
  const identityMap = await deriveBetterAuthMicrosoftIdentityMap({
    clientId,
    getSigningKey: jwks,
    now: new Date(),
    sources: sources.value,
    tenantId,
  });
  await client.end();
  if (Result.isError(identityMap)) {
    return identityMap;
  }
  return await persistIdentityMap(parsed.value.outputPath, identityMap.value);
};

if (import.meta.main) {
  run(Bun.argv.slice(2))
    .then((result) => {
      if (result.status === "error") {
        process.stderr.write(
          `${JSON.stringify({ code: result.error.code, status: "error" })}\n`,
        );
        process.exitCode =
          result.error instanceof BetterAuthMicrosoftIdentityMapError
            ? EXIT_CODE.INVARIANT_FAILURE
            : EXIT_CODE.CONFIGURATION_OR_QUERY_FAILURE;
        return undefined;
      }
      process.stdout.write(
        `${JSON.stringify({ check: "microsoft-identity-map", status: "passed" })}\n`,
      );
      process.exitCode = EXIT_CODE.SUCCESS;
      return undefined;
    })
    .catch(() => {
      process.stderr.write(
        `${JSON.stringify({ code: "unexpected-failure", status: "error" })}\n`,
      );
      process.exitCode = EXIT_CODE.CONFIGURATION_OR_QUERY_FAILURE;
    });
}
