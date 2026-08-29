/**
 * Usage:
 *   bun src/scripts/better-auth-sign-in-replay.ts --oauth-base-url <https-origin> --session-sample <n>
 *
 * Replays, against a migrated database, what the auth runtime will do on the
 * first sign-in of every stored Microsoft account and on the next request of
 * a sample of stored sessions. The provider is not contacted: the token
 * exchange and signing keys are served locally, so the replay proves only the
 * runtime's resolution of stored rows. Every replayed sign-in must resolve to
 * the account's existing user without creating a user or account row, and
 * every sampled session must resolve to its stored user. Output is counts
 * only.
 */

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer } from "better-auth/plugins";
import { Result, TaggedError } from "better-result";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";

import { hasSecureDatabaseTransport, resolveDatabaseUrl } from "@/api/db-url";
import { AUTH_DATABASE_ADAPTER_OPTIONS } from "@/api/lib/auth-adapter-options";
import { isRecord } from "@/api/lib/type-guards";
import { normalizeBetterAuthOAuthBaseUrl } from "@/api/mcp/resource-policy-contract";
import { formatBetterAuthScriptFailure } from "@/api/scripts/better-auth-script-failure";

const EXIT_CODE = {
  CONFIGURATION_OR_QUERY_FAILURE: 2,
  INVARIANT_FAILURE: 1,
  SUCCESS: 0,
} as const;
const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com";
const SIGNING_KEY_ID = "replay-key";
const MAX_SIGN_IN_ROWS = 1000;

class BetterAuthSignInReplayError extends TaggedError(
  "BetterAuthSignInReplayError",
)<{
  cause?: unknown;
  code:
    | "database-query-failed"
    | "invalid-arguments"
    | "replay-failed"
    | "session-resolution-failed"
    | "sign-in-resolution-failed";
  message: string;
}> {}

type ReplayArgs = { oauthBaseUrl: string; sessionSample: number };

export const parseBetterAuthSignInReplayArgs = (
  args: readonly string[],
): Result<ReplayArgs, BetterAuthSignInReplayError> => {
  const oauthBaseUrl =
    args.at(0) === "--oauth-base-url" && args.at(1)
      ? normalizeBetterAuthOAuthBaseUrl(args[1] ?? "")
      : null;
  const sessionSample = Number(args.at(3));
  if (
    oauthBaseUrl === null ||
    args.at(2) !== "--session-sample" ||
    !Number.isSafeInteger(sessionSample) ||
    sessionSample < 0 ||
    args.length !== 4
  ) {
    return Result.err(
      new BetterAuthSignInReplayError({
        code: "invalid-arguments",
        message:
          "Usage: better-auth-sign-in-replay --oauth-base-url <https-origin> --session-sample <n>",
      }),
    );
  }
  return Result.ok({ oauthBaseUrl, sessionSample });
};

type MicrosoftRow = {
  accountId: string;
  email: string;
  idToken: string;
  userId: string;
};

type SessionRow = { token: string; userId: string };

const queryFailed = (cause: unknown) =>
  new BetterAuthSignInReplayError({
    cause,
    code: "database-query-failed",
    message: "Sign-in replay could not read the stored rows",
  });

const readRows = async (client: SQL) => {
  const queried = await Result.tryPromise({
    try: async () => ({
      microsoft: await client`
        SELECT a.account_id AS "accountId", a.id_token AS "idToken",
               a.user_id AS "userId", u.email AS "email"
          FROM account a JOIN "user" u ON u.id = a.user_id
         WHERE a.provider_id = 'microsoft'
         ORDER BY a.id
         LIMIT ${MAX_SIGN_IN_ROWS + 1}
      `,
      sessions: await client`
        SELECT token, user_id AS "userId"
          FROM session
         WHERE expires_at > now()
         ORDER BY expires_at DESC
         LIMIT 1000
      `,
      userCount: await client`SELECT count(*)::text AS "count" FROM "user"`,
      accountCount: await client`SELECT count(*)::text AS "count" FROM account`,
    }),
    catch: queryFailed,
  });
  if (Result.isError(queried)) {
    return queried;
  }
  const microsoft: MicrosoftRow[] = [];
  for (const row of queried.value.microsoft) {
    const accountId = isRecord(row) ? row["accountId"] : null;
    const idToken = isRecord(row) ? row["idToken"] : null;
    const userId = isRecord(row) ? row["userId"] : null;
    const email = isRecord(row) ? row["email"] : null;
    if (
      typeof accountId !== "string" ||
      typeof idToken !== "string" ||
      typeof userId !== "string" ||
      typeof email !== "string"
    ) {
      return Result.err(queryFailed(undefined));
    }
    microsoft.push({ accountId, email, idToken, userId });
  }
  if (microsoft.length > MAX_SIGN_IN_ROWS) {
    return Result.err(queryFailed(undefined));
  }
  const sessions: SessionRow[] = [];
  for (const row of queried.value.sessions) {
    const token = isRecord(row) ? row["token"] : null;
    const userId = isRecord(row) ? row["userId"] : null;
    if (typeof token !== "string" || typeof userId !== "string") {
      return Result.err(queryFailed(undefined));
    }
    sessions.push({ token, userId });
  }
  const userCount = queried.value.userCount.at(0);
  const accountCount = queried.value.accountCount.at(0);
  if (
    !isRecord(userCount) ||
    typeof userCount["count"] !== "string" ||
    !isRecord(accountCount) ||
    typeof accountCount["count"] !== "string"
  ) {
    return Result.err(queryFailed(undefined));
  }
  return Result.ok({
    accountCount: accountCount["count"],
    microsoft,
    sessions,
    userCount: userCount["count"],
  });
};

const cookieHeader = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .join("; ");

type ReplayOutcome = "resolved" | "rejected" | "created" | "mismatched";

const run = async (args: readonly string[]) => {
  const parsed = parseBetterAuthSignInReplayArgs(args);
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
      new BetterAuthSignInReplayError({
        code: "invalid-arguments",
        message:
          "Sign-in replay requires provider configuration and a secure database connection",
      }),
    );
  }
  const { oauthBaseUrl, sessionSample } = parsed.value;
  const client = new SQL({ max: 1, url: databaseUrl });
  const rows = await readRows(client);
  if (Result.isError(rows)) {
    await client.end();
    return rows;
  }

  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = {
    ...(await exportJWK(publicKey)),
    alg: "RS256",
    kid: SIGNING_KEY_ID,
    use: "sig",
  };
  const database = drizzle({ client });
  const auth = betterAuth({
    baseURL: oauthBaseUrl,
    // A throwaway secret: nothing signed here outlives the replay.
    secret: Bun.randomUUIDv7() + Bun.randomUUIDv7(),
    database: drizzleAdapter(database, AUTH_DATABASE_ADAPTER_OPTIONS),
    trustedOrigins: [oauthBaseUrl],
    socialProviders: {
      microsoft: {
        clientId,
        clientSecret: "replay",
        disableProfilePhoto: true,
        tenantId,
      },
    },
    plugins: [bearer()],
  });

  let currentIdToken = "";
  const realFetch = globalThis.fetch;
  // The runtime's only outbound calls during a sign-in are the provider's
  // token exchange and key discovery; both are served locally and every
  // other destination is refused, so the replay never leaves the process.
  const localProviderFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (
      request.url.startsWith(`${MICROSOFT_AUTHORITY}/`) &&
      request.url.includes("/oauth2/v2.0/token")
    ) {
      const exchange = new URLSearchParams(await request.text());
      if (exchange.get("code") !== "replay") {
        return new Response("refused by replay", { status: 599 });
      }
      return Response.json({
        access_token: "replay-access",
        expires_in: 3600,
        id_token: currentIdToken,
        scope: "openid profile email",
        token_type: "Bearer",
      });
    }
    if (
      request.url.startsWith(`${MICROSOFT_AUTHORITY}/`) &&
      request.url.includes("/discovery/v2.0/keys")
    ) {
      return Response.json({ keys: [jwk] });
    }
    return new Response("refused by replay", { status: 599 });
  };

  const outcomes: Record<ReplayOutcome, number> = {
    created: 0,
    mismatched: 0,
    rejected: 0,
    resolved: 0,
  };
  globalThis.fetch = localProviderFetch;
  const replayed = await Result.tryPromise({
    try: async () => {
      const rowIterator = rows.value.microsoft.values();
      const replayNext = async (): Promise<void> => {
        const next = rowIterator.next();
        if (next.done) {
          return;
        }
        const row = next.value;
        const claims = decodeJwt(row.idToken);
        const start = await auth.handler(
          new Request(`${oauthBaseUrl}/api/auth/sign-in/social`, {
            body: JSON.stringify({
              callbackURL: "/replay",
              provider: "microsoft",
            }),
            headers: {
              "content-type": "application/json",
              origin: oauthBaseUrl,
            },
            method: "POST",
          }),
        );
        const startBody: unknown = await start.json();
        const authorizeUrl = new URL(
          isRecord(startBody) && typeof startBody["url"] === "string"
            ? startBody["url"]
            : "about:blank",
        );
        const state = authorizeUrl.searchParams.get("state") ?? "";
        const nonce = authorizeUrl.searchParams.get("nonce");
        const now = Math.floor(Date.now() / 1000);
        const tid =
          typeof claims["tid"] === "string" ? claims["tid"] : tenantId;
        currentIdToken = await new SignJWT({
          email: row.email,
          name: row.email,
          oid: claims["oid"],
          preferred_username: row.email,
          tid,
          ...(nonce ? { nonce } : {}),
        })
          .setProtectedHeader({ alg: "RS256", kid: SIGNING_KEY_ID })
          .setIssuer(`${MICROSOFT_AUTHORITY}/${tid}/v2.0`)
          .setAudience(clientId)
          .setSubject(typeof claims.sub === "string" ? claims.sub : "")
          .setIssuedAt(now)
          .setExpirationTime(now + 3600)
          .sign(privateKey);
        const callback = await auth.handler(
          new Request(
            `${oauthBaseUrl}/api/auth/callback/microsoft?code=replay&state=${encodeURIComponent(state)}`,
            { headers: { cookie: cookieHeader(start) } },
          ),
        );
        const location = callback.headers.get("location") ?? "";
        if (location.includes("error=")) {
          outcomes.rejected += 1;
          return replayNext();
        }
        const session = await auth.handler(
          new Request(`${oauthBaseUrl}/api/auth/get-session`, {
            headers: { cookie: cookieHeader(callback) },
          }),
        );
        const sessionBody: unknown = await session.json();
        const resolvedUserId =
          isRecord(sessionBody) && isRecord(sessionBody["user"])
            ? sessionBody["user"]["id"]
            : null;
        if (resolvedUserId === row.userId) {
          outcomes.resolved += 1;
        } else {
          outcomes.mismatched += 1;
        }
        return replayNext();
      };
      await replayNext();
    },
    catch: (cause) =>
      new BetterAuthSignInReplayError({
        cause,
        code: "replay-failed",
        message: "Sign-in replay did not complete",
      }),
  });
  globalThis.fetch = realFetch;

  const sessionOutcomes = { resolved: 0, unresolved: 0 };
  if (Result.isOk(replayed)) {
    const sampled = rows.value.sessions.slice(0, sessionSample).values();
    const resolveNext = async (): Promise<void> => {
      const next = sampled.next();
      if (next.done) {
        return;
      }
      const response = await auth.handler(
        new Request(`${oauthBaseUrl}/api/auth/get-session`, {
          headers: { authorization: `Bearer ${next.value.token}` },
        }),
      );
      const body: unknown = await response.json();
      const resolvedUserId =
        isRecord(body) && isRecord(body["user"]) ? body["user"]["id"] : null;
      if (resolvedUserId === next.value.userId) {
        sessionOutcomes.resolved += 1;
      } else {
        sessionOutcomes.unresolved += 1;
      }
      return resolveNext();
    };
    await resolveNext();
  }

  const after = await readRows(client);
  await client.end();
  if (Result.isError(replayed)) {
    return replayed;
  }
  if (Result.isError(after)) {
    return after;
  }
  if (
    after.value.userCount !== rows.value.userCount ||
    after.value.accountCount !== rows.value.accountCount
  ) {
    outcomes.created += 1;
  }
  const summary = {
    accounts: rows.value.microsoft.length,
    sessions: sessionOutcomes,
    signIns: outcomes,
  };
  if (
    outcomes.rejected > 0 ||
    outcomes.mismatched > 0 ||
    outcomes.created > 0
  ) {
    return Result.err(
      new BetterAuthSignInReplayError({
        code: "sign-in-resolution-failed",
        message: `Sign-in replay: ${JSON.stringify(summary)}`,
      }),
    );
  }
  if (sessionOutcomes.unresolved > 0) {
    return Result.err(
      new BetterAuthSignInReplayError({
        code: "session-resolution-failed",
        message: `Sign-in replay: ${JSON.stringify(summary)}`,
      }),
    );
  }
  return Result.ok(summary);
};

if (import.meta.main) {
  run(Bun.argv.slice(2))
    .then((result) => {
      if (Result.isError(result)) {
        process.stderr.write(formatBetterAuthScriptFailure(result.error));
        process.exitCode =
          result.error.code === "sign-in-resolution-failed" ||
          result.error.code === "session-resolution-failed"
            ? EXIT_CODE.INVARIANT_FAILURE
            : EXIT_CODE.CONFIGURATION_OR_QUERY_FAILURE;
        return undefined;
      }
      process.stdout.write(
        `${JSON.stringify({ check: "sign-in-replay", status: "passed", ...result.value })}\n`,
      );
      process.exitCode = EXIT_CODE.SUCCESS;
      return undefined;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        formatBetterAuthScriptFailure({
          cause: error,
          code: "unexpected-failure",
          message: "Sign-in replay failed unexpectedly",
        }),
      );
      process.exitCode = EXIT_CODE.CONFIGURATION_OR_QUERY_FAILURE;
    });
}
