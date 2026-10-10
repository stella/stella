import {
  getOAuthProviderApi,
  type OAuthOptions,
  type Scope,
} from "@better-auth/oauth-provider";
import type { HookEndpointContext } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { AUTH_RATE_LIMITS } from "@/api/lib/limits";
import type { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";
import { isRecord } from "@/api/lib/type-guards";

export const AUTH_ACCOUNT_REQUEST_BUDGET_RULES = {
  "/sign-in/email": AUTH_RATE_LIMITS.signIn,
  "/sign-in/email-otp": AUTH_RATE_LIMITS.signIn,
  "/email-otp/send-verification-otp": AUTH_RATE_LIMITS.sendOtp,
} as const;

export const AUTH_REQUEST_BUDGET_RULES = {
  ...AUTH_ACCOUNT_REQUEST_BUDGET_RULES,
  "/sign-in/social": AUTH_RATE_LIMITS.authSharedAddress,
  "/oauth2/authorize": AUTH_RATE_LIMITS.oauthAuthorization,
  "/oauth2/token": AUTH_RATE_LIMITS.oauthToken,
  "/oauth2/register": AUTH_RATE_LIMITS.oauthClientRegistration,
} as const;

export const AUTH_REQUEST_IP_RULE_OVERRIDES = Object.fromEntries(
  Object.keys(AUTH_REQUEST_BUDGET_RULES).map((path) => [path, false] as const),
);

export const isAuthRequestBudgetPath = (
  path: string,
): path is keyof typeof AUTH_REQUEST_BUDGET_RULES =>
  Object.hasOwn(AUTH_REQUEST_BUDGET_RULES, path);

const refreshGrantSchema = v.object({
  userId: v.string(),
  clientId: v.string(),
});
const codeGrantSchema = v.object({ value: v.string() });
const codeValueSchema = v.object({
  type: v.literal("authorization_code"),
  userId: v.string(),
  query: v.object({ client_id: v.string() }),
});

type AuthRequestBudgetIdentity =
  | { type: "verified"; key: string }
  | { type: "registration"; key: string }
  | { type: "account"; key: string }
  | { type: "anonymous"; key: string };

type ResolveAuthRequestBudgetIdentityOptions = {
  path: string;
  address: string;
  body: unknown;
  readUserId: () => Promise<string | undefined>;
  readGrant: (
    token: string,
    grantType: "refresh_token" | "authorization_code",
  ) => Promise<{ userId: string; clientId: string } | undefined>;
};

export const resolveAuthRequestBudgetIdentity = async ({
  path,
  address,
  body,
  readUserId,
  readGrant,
}: ResolveAuthRequestBudgetIdentityOptions): Promise<AuthRequestBudgetIdentity> => {
  const anonymous = {
    type: "anonymous",
    key: sha256Hex(JSON.stringify(["address", address])),
  } as const;
  if (Object.hasOwn(AUTH_ACCOUNT_REQUEST_BUDGET_RULES, path)) {
    const email = isRecord(body) ? body["email"] : undefined;
    if (typeof email !== "string" || email.trim().length === 0) {
      return anonymous;
    }
    return {
      type: "account",
      key: sha256Hex(JSON.stringify(["account", email.trim().toLowerCase()])),
    };
  }
  if (path === "/oauth2/token") {
    if (!isRecord(body)) {
      return anonymous;
    }
    const type = body["grant_type"];
    if (type !== "refresh_token" && type !== "authorization_code") {
      return anonymous;
    }
    const token = body[type === "refresh_token" ? "refresh_token" : "code"];
    if (typeof token !== "string" || token.length === 0) {
      return anonymous;
    }
    const grant = await readGrant(token, type);
    if (
      !grant ||
      (typeof body["client_id"] === "string" &&
        body["client_id"] !== grant.clientId)
    ) {
      return anonymous;
    }
    return {
      type: "verified",
      key: sha256Hex(JSON.stringify(["grant", grant.userId, grant.clientId])),
    };
  }
  const userId = await readUserId();
  if (userId) {
    return {
      type: "verified",
      key: sha256Hex(JSON.stringify(["user", userId])),
    };
  }
  if (path !== "/oauth2/register" || !isRecord(body)) {
    return anonymous;
  }
  const redirects = body["redirect_uris"];
  if (
    !Array.isArray(redirects) ||
    redirects.length === 0 ||
    !redirects.every(
      (uri): uri is string => typeof uri === "string" && URL.canParse(uri),
    )
  ) {
    return anonymous;
  }
  return {
    type: "registration",
    key: sha256Hex(
      JSON.stringify([
        "registration",
        Array.from(new Set(redirects)).toSorted(),
      ]),
    ),
  };
};

type ReadAuthBudgetGrantOptions = {
  ctx: HookEndpointContext;
  providerOptions: OAuthOptions<Scope[]>;
  token: string;
  grantType: "refresh_token" | "authorization_code";
};

const readAuthBudgetGrant = async ({
  ctx,
  providerOptions,
  token,
  grantType,
}: ReadAuthBudgetGrantOptions) => {
  const storedToken = await getOAuthProviderApi(ctx, providerOptions).hashToken(
    token,
    grantType,
  );
  if (grantType === "refresh_token") {
    const row = await ctx.context.adapter.findOne({
      model: "oauthRefreshToken",
      where: [{ field: "token", value: storedToken }],
    });
    if (!row) {
      return undefined;
    }
    const grant = v.parse(refreshGrantSchema, row);
    // Possession identifies the budget owner; the provider owns expiry, revocation and replay.
    return { userId: grant.userId, clientId: grant.clientId };
  }
  const row =
    await ctx.context.internalAdapter.findVerificationValue(storedToken);
  if (!row) {
    return undefined;
  }
  const grant = v.parse(codeGrantSchema, row);
  const decoded = Result.try((): unknown => JSON.parse(grant.value));
  if (decoded.isErr()) {
    panic("Stored authorization code contains invalid JSON");
  }
  const value = v.safeParse(codeValueSchema, decoded.value);
  if (!value.success) {
    return undefined;
  }
  return {
    userId: value.output.userId,
    clientId: value.output.query.client_id,
  };
};

type CreateAuthRequestBudgetOptions = {
  storage: ReturnType<typeof createAuthRateLimitStorage>;
  enabled: boolean;
} & (
  | { type: "authentication" }
  | { type: "oauth"; providerOptions: OAuthOptions<Scope[]> }
);

export const createAuthRequestBudgetMiddleware = ({
  storage,
  enabled,
  ...policy
}: CreateAuthRequestBudgetOptions) =>
  createAuthMiddleware(async (ctx) => {
    if (!enabled || !ctx.path || !isAuthRequestBudgetPath(ctx.path)) {
      return;
    }
    const isAuthentication = !ctx.path.startsWith("/oauth2/");
    if ((policy.type === "authentication") !== isAuthentication) {
      return;
    }
    const rule = AUTH_REQUEST_BUDGET_RULES[ctx.path];
    const address = ctx.headers?.get(AUTH_CLIENT_ADDRESS_HEADER) ?? "unknown";
    const identity = await resolveAuthRequestBudgetIdentity({
      path: ctx.path,
      address,
      body: ctx.body,
      readUserId: async () =>
        (await getAuthoritativeSessionFromCtx(ctx))?.user.id,
      readGrant: async (token, grantType) =>
        policy.type === "oauth"
          ? await readAuthBudgetGrant({
              ctx,
              providerOptions: policy.providerOptions,
              token,
              grantType,
            })
          : undefined,
    });
    const counter = { key: `${ctx.path}:${identity.key}`, rule };
    let budgets: { key: string; rule: { max: number; window: number } }[];
    switch (identity.type) {
      case "registration":
        budgets = [
          {
            key: `${ctx.path}:address:${sha256Hex(address)}`,
            rule: AUTH_RATE_LIMITS.oauthAnonymousAddress,
          },
          {
            ...counter,
            rule: AUTH_RATE_LIMITS.oauthAnonymousClientRegistration,
          },
        ];
        break;
      case "account":
        budgets = [
          {
            key: `${ctx.path}:address:${sha256Hex(address)}`,
            rule: AUTH_RATE_LIMITS.authSharedAddress,
          },
          counter,
        ];
        break;
      case "verified":
        budgets = [counter];
        break;
      case "anonymous":
        budgets = [
          {
            ...counter,
            rule:
              ctx.path === "/oauth2/token"
                ? rule
                : AUTH_RATE_LIMITS.authSharedAddress,
          },
        ];
        break;
      default: {
        identity satisfies never;
        panic("Unexpected auth request budget identity");
      }
    }
    for (const budget of budgets) {
      const decision = await storage.consume(budget.key, budget.rule);
      if (decision.allowed) {
        continue;
      }
      throw new APIError(
        "TOO_MANY_REQUESTS",
        { message: "Try again later.", code: "TOO_MANY_REQUESTS" },
        { "Retry-After": String(decision.retryAfter ?? budget.rule.window) },
      );
    }
  });
