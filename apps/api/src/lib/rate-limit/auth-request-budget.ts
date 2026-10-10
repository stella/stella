import {
  getOAuthProviderApi,
  type OAuthOptions,
  type Scope,
} from "@better-auth/oauth-provider";
import {
  APIError,
  type createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { panic, Result } from "better-result";
import * as v from "valibot";

import { sha256Hex } from "@stll/sha256/bun";

import { AUTH_CLIENT_ADDRESS_HEADER } from "@/api/lib/client-ip";
import { AUTH_RATE_LIMITS } from "@/api/lib/limits";
import type { createAuthRateLimitStorage } from "@/api/lib/rate-limit/auth-storage";
import {
  recordBudgetRejection,
  type BudgetObservation,
} from "@/api/lib/rate-limit/budget-observability";
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

export const AUTH_TOKEN_ADDRESS_BUDGET = {
  rule: AUTH_RATE_LIMITS.authSharedAddress,
  name: "auth.token.address",
  keyKind: "address",
  key: (address: string) => `/oauth2/token:address:${sha256Hex(address)}`,
} as const;

export const AUTH_REQUEST_IP_RULE_OVERRIDES = Object.fromEntries(
  Object.keys(AUTH_REQUEST_BUDGET_RULES).map((path) => [path, false] as const),
);

export const isAuthRequestBudgetPath = (
  path: string,
): path is keyof typeof AUTH_REQUEST_BUDGET_RULES =>
  Object.hasOwn(AUTH_REQUEST_BUDGET_RULES, path);

const AUTH_BUDGET_OBSERVATIONS = {
  "/sign-in/email": {
    account: "auth.sign_in.email.account",
    address: "auth.sign_in.email.address",
  },
  "/sign-in/email-otp": {
    account: "auth.sign_in.otp.account",
    address: "auth.sign_in.otp.address",
  },
  "/email-otp/send-verification-otp": {
    account: "auth.otp.send.account",
    address: "auth.otp.send.address",
  },
  "/sign-in/social": {
    account: "auth.social.user",
    address: "auth.social.address",
  },
  "/oauth2/authorize": {
    account: "auth.authorize.user",
    address: "auth.authorize.address",
  },
  "/oauth2/token": {
    account: "auth.token.user_client",
    address: "auth.token.address",
  },
  "/oauth2/register": {
    account: "auth.register.user",
    address: "auth.register.address",
  },
} as const satisfies Record<
  keyof typeof AUTH_REQUEST_BUDGET_RULES,
  {
    account: BudgetObservation["name"];
    address: BudgetObservation["name"];
  }
>;

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

type AuthRequestBudgetContext = Parameters<
  Parameters<typeof createAuthMiddleware>[0]
>[0];

type ReadAuthBudgetGrantOptions = {
  ctx: AuthRequestBudgetContext;
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

type ConsumeAuthRequestBudgetOptions = BudgetObservation & {
  storage: ReturnType<typeof createAuthRateLimitStorage>;
  key: string;
  rule: { max: number; window: number };
};

const consumeAuthRequestBudget = async ({
  storage,
  key,
  rule,
  name,
  keyKind,
}: ConsumeAuthRequestBudgetOptions) => {
  const decision = await storage.consume(key, rule);
  if (decision.allowed) {
    return Result.ok(undefined);
  }
  recordBudgetRejection({ name, keyKind, windowMs: rule.window * 1000 });
  return Result.err(
    new APIError(
      "TOO_MANY_REQUESTS",
      { message: "Try again later.", code: "TOO_MANY_REQUESTS" },
      { "Retry-After": String(decision.retryAfter ?? rule.window) },
    ),
  );
};

type CreateAuthRequestBudgetOptions = {
  storage: ReturnType<typeof createAuthRateLimitStorage>;
  enabled: boolean;
} & (
  | { type: "authentication" }
  | { type: "oauth"; providerOptions: OAuthOptions<Scope[]> }
);

export const createAuthRequestBudget =
  ({ storage, enabled, ...policy }: CreateAuthRequestBudgetOptions) =>
  async (ctx: AuthRequestBudgetContext) => {
    if (!enabled || !ctx.path || !isAuthRequestBudgetPath(ctx.path)) {
      return Result.ok(undefined);
    }
    const isAuthentication = !ctx.path.startsWith("/oauth2/");
    if ((policy.type === "authentication") !== isAuthentication) {
      return Result.ok(undefined);
    }
    const rule = AUTH_REQUEST_BUDGET_RULES[ctx.path];
    const address = ctx.headers?.get(AUTH_CLIENT_ADDRESS_HEADER) ?? "unknown";
    // Bound grant-resolution work before untrusted credentials reach the database.
    if (ctx.path === "/oauth2/token") {
      const admission = await consumeAuthRequestBudget({
        storage,
        ...AUTH_TOKEN_ADDRESS_BUDGET,
        key: AUTH_TOKEN_ADDRESS_BUDGET.key(address),
      });
      if (admission.isErr()) {
        return admission;
      }
    }
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
    const observations = AUTH_BUDGET_OBSERVATIONS[ctx.path];
    const counter = {
      key: `${ctx.path}:${identity.key}`,
      rule,
      name: observations.account,
      keyKind: identity.type === "account" ? "account" : "user",
    } as const;
    let budgets: (BudgetObservation & {
      key: string;
      rule: { max: number; window: number };
    })[];
    switch (identity.type) {
      case "registration":
        budgets = [
          {
            key: `${ctx.path}:address:${sha256Hex(address)}`,
            rule: AUTH_RATE_LIMITS.oauthAnonymousAddress,
            name: observations.address,
            keyKind: "address",
          },
          {
            ...counter,
            rule: AUTH_RATE_LIMITS.oauthAnonymousClientRegistration,
            name: "auth.register.client",
            keyKind: "client",
          },
        ];
        break;
      case "account":
        budgets = [
          {
            key: `${ctx.path}:address:${sha256Hex(address)}`,
            rule: AUTH_RATE_LIMITS.authSharedAddress,
            name: observations.address,
            keyKind: "address",
          },
          counter,
        ];
        break;
      case "verified":
        budgets = [
          {
            ...counter,
            keyKind: ctx.path === "/oauth2/token" ? "client" : "user",
          },
        ];
        break;
      case "anonymous":
        // Token requests already consumed the broad admission budget above.
        budgets =
          ctx.path === "/oauth2/token"
            ? []
            : [
                {
                  ...counter,
                  rule: AUTH_RATE_LIMITS.authSharedAddress,
                  name: observations.address,
                  keyKind: "address",
                },
              ];
        break;
      default: {
        identity satisfies never;
        panic("Unexpected auth request budget identity");
      }
    }
    for (const budget of budgets) {
      const decision = await consumeAuthRequestBudget({ storage, ...budget });
      if (decision.isErr()) {
        return decision;
      }
    }
    return Result.ok(undefined);
  };
