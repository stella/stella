import { BASE_ERROR_CODES } from "@better-auth/core/error";
import type { AuthContext, BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
  isAPIError,
} from "better-auth/api";
import { Result } from "better-result";

import {
  checkReviewAccountAccess,
  isReviewAccountBodyEmailPath,
  isReviewAccountEmail,
  readReviewAccountOrganizationTargets,
  REVIEW_ACCOUNT_OPERATION,
  REVIEW_ACCOUNT_REFUSAL_MESSAGE,
  resolveReviewAccountBodyEmailOperation,
  resolveReviewAccountSessionOperation,
} from "@/api/lib/auth/review-account-policy";
import type {
  ReviewAccountConfig,
  ReviewAccountOperation,
} from "@/api/lib/auth/review-account-policy";
import {
  findReviewAccountTokenRedemption,
  isReviewAccountTokenRedemptionPath,
} from "@/api/lib/auth/review-account-token-subjects";
import type { createAccountAttemptBudget } from "@/api/lib/rate-limit/otp-account-budget";
import { isRecord } from "@/api/lib/type-guards";

const SIGN_IN_EMAIL_PATH = "/sign-in/email";
const GET_SESSION_PATH = "/get-session";
const API_KEY_CREATE_PATH = "/api-key/create";
const BUDGET_CONTEXT_KEY = "reviewAccountSignInBudgetKey";
/** Failed password sign-ins one account may make in one window. */
export const REVIEW_ACCOUNT_SIGN_IN_BUDGET = {
  max: 10,
  durationMs: 60 * 60 * 1000,
} as const;

type SignInBudget = ReturnType<typeof createAccountAttemptBudget>;

type ReviewAccountPluginOptions = {
  config: ReviewAccountConfig;
  /**
   * Self-hosted local password sign-in stays open to every account; without
   * it, only the review account may sign in with a password.
   */
  localPasswordEnabled: boolean;
  /** Per-account failure budget; absent when auth rate limits are off. */
  signInBudget?: SignInBudget | undefined;
};

export const requireReviewAccountAccess = (
  access: ReturnType<typeof checkReviewAccountAccess>,
): void => {
  if (Result.isError(access)) {
    throw new APIError("FORBIDDEN", {
      code: "account_access_unavailable",
      message: access.error.message,
    });
  }
};

/**
 * Paths whose signed-in account this plugin resolves: those that perform a
 * review-account operation, plus the OAuth and organization endpoints, where
 * the session must still be pinned to the review organization.
 */
const sessionCheckedOperation = ({
  path,
  method,
}: {
  path: string;
  method: string | undefined;
}): ReviewAccountOperation | "session-only" | null => {
  const operation = resolveReviewAccountSessionOperation({ path, method });
  if (operation !== null) {
    return operation;
  }
  return path.startsWith("/oauth2/") || path.startsWith("/organization/")
    ? "session-only"
    : null;
};

/** Refuses a request naming any organization but the review account's own. */
const requireNamedOrganizations = async ({
  adapter,
  body,
  config,
  email,
  path,
  query,
}: {
  adapter: Pick<AuthContext["adapter"], "findOne">;
  body: unknown;
  config: ReviewAccountConfig;
  email: string;
  path: string;
  query: unknown;
}) => {
  const targets = readReviewAccountOrganizationTargets({ path, body, query });
  const slugTargets = await Promise.all(
    targets.slugs.map(
      async (slug) =>
        (
          await adapter.findOne<{ id: string }>({
            model: "organization",
            where: [{ field: "slug", value: slug }],
          })
        )?.id ?? null,
    ),
  );
  for (const organizationId of [...targets.ids, ...slugTargets]) {
    requireReviewAccountAccess(
      checkReviewAccountAccess({
        email,
        config,
        operation: REVIEW_ACCOUNT_OPERATION.session,
        organizationId,
      }),
    );
  }
};

const CREDENTIAL_PROVIDER_ID = "credential";

/**
 * Database-layer rules for the review account, covering every path that
 * writes the rows (explicit linking, implicit linking on a social sign-in
 * with a matching verified email, sign-up): no identity but its password
 * credential is ever attached to it, and no request creates it; only the
 * operator command does, outside any request.
 */
export const createReviewAccountDatabaseHooks = (
  config: ReviewAccountConfig,
) => ({
  accountCreateBefore: async (
    account: { userId: string; providerId: string },
    // Absent outside a request (the operator command), where it is allowed.
    context:
      | { context: Pick<AuthContext, "internalAdapter"> }
      | null
      | undefined,
  ): Promise<undefined> => {
    if (
      config.email === undefined ||
      account.providerId === CREDENTIAL_PROVIDER_ID ||
      context === null ||
      context === undefined
    ) {
      return undefined;
    }
    const owner = await context.context.internalAdapter.findUserById(
      account.userId,
    );
    if (owner) {
      requireReviewAccountAccess(
        checkReviewAccountAccess({
          email: owner.email,
          config,
          operation: REVIEW_ACCOUNT_OPERATION.linkIdentity,
        }),
      );
    }
    return undefined;
  },
  userCreateBefore: async (
    user: { email: string },
    context: unknown,
  ): Promise<undefined> => {
    await Promise.resolve();
    // Only the operator command, outside any request, creates the account.
    const inRequest = context !== null && context !== undefined;
    if (inRequest && isReviewAccountEmail({ email: user.email, config })) {
      throw new APIError("FORBIDDEN", {
        code: "account_access_unavailable",
        message: REVIEW_ACCOUNT_REFUSAL_MESSAGE,
      });
    }
    return undefined;
  },
});

export const createReviewAccountPlugin = ({
  config,
  localPasswordEnabled,
  signInBudget,
}: ReviewAccountPluginOptions) => {
  const configured = config.email !== undefined;
  return {
    id: "restricted-review-account",
    hooks: {
      before: [
        {
          // Password sign-in: only the review account, unless local password
          // sign-in is on for everyone.
          matcher: ({ path }) => configured && path === SIGN_IN_EMAIL_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body: unknown = ctx.body;
            const email = isRecord(body) ? body["email"] : undefined;
            if (
              typeof email === "string" &&
              isReviewAccountEmail({ email, config })
            ) {
              if (!signInBudget) {
                return undefined;
              }
              const reservation = await signInBudget.reserve(email);
              if (Result.isError(reservation)) {
                return await Promise.reject(reservation.error);
              }
              // Better Auth deep-merges a before-hook's `context` into the
              // endpoint context (api/dispatch.mjs, `defuReplaceArrays`), so
              // the inner `context` lands on the auth context the after-hook
              // reads as `ctx.context`.
              return {
                context: {
                  context: { [BUDGET_CONTEXT_KEY]: reservation.value },
                },
              };
            }
            if (localPasswordEnabled) {
              return undefined;
            }
            // The same work and the same answer as an account without a
            // password, so the refusal says nothing about the address.
            const password = isRecord(body) ? body["password"] : undefined;
            if (
              typeof password === "string" &&
              password.length <= ctx.context.password.config.maxPasswordLength
            ) {
              await ctx.context.password.hash(password);
            }
            throw APIError.from(
              "UNAUTHORIZED",
              BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD,
            );
          }),
        },
        {
          // Endpoints redeeming a token or stored state that names an account
          // check that account before taking effect, whenever the token was
          // issued.
          matcher: ({ path }) =>
            configured &&
            path !== undefined &&
            isReviewAccountTokenRedemptionPath(path),
          handler: createAuthMiddleware(async (ctx) => {
            const resolve = findReviewAccountTokenRedemption(ctx.path);
            const subjects =
              resolve === undefined
                ? []
                : await resolve({
                    body: ctx.body,
                    query: ctx.query,
                    internalAdapter: ctx.context.internalAdapter,
                  });
            for (const { email, operation } of subjects) {
              requireReviewAccountAccess(
                checkReviewAccountAccess({ email, config, operation }),
              );
            }
            return undefined;
          }),
        },
        {
          // Recovery and sign-up name the account by email, not by session.
          matcher: ({ path }) =>
            configured &&
            path !== undefined &&
            isReviewAccountBodyEmailPath(path),
          handler: createAuthMiddleware(async (ctx) => {
            const body: unknown = ctx.body;
            const email = isRecord(body) ? body["email"] : undefined;
            const operation = resolveReviewAccountBodyEmailOperation({
              path: ctx.path,
              otpType: isRecord(body) ? body["type"] : undefined,
            });
            if (typeof email === "string" && operation !== null) {
              requireReviewAccountAccess(
                checkReviewAccountAccess({ email, config, operation }),
              );
            }
            await Promise.resolve();
            return undefined;
          }),
        },
        {
          matcher: ({ path }) =>
            configured &&
            path !== undefined &&
            sessionCheckedOperation({ path, method: undefined }) !== null,
          handler: createAuthMiddleware(async (ctx) => {
            const path = ctx.path;
            const operation = sessionCheckedOperation({
              path,
              method: ctx.method,
            });
            if (operation === null) {
              return undefined;
            }
            // Server-side key creation names its owner in the body.
            const body: unknown = ctx.body;
            const requestedUserId = isRecord(body) ? body["userId"] : undefined;
            if (
              path === API_KEY_CREATE_PATH &&
              typeof requestedUserId === "string"
            ) {
              const owner =
                await ctx.context.internalAdapter.findUserById(requestedUserId);
              if (!owner) {
                throw new APIError("UNAUTHORIZED", { message: "Unauthorized" });
              }
              requireReviewAccountAccess(
                checkReviewAccountAccess({
                  email: owner.email,
                  config,
                  operation: REVIEW_ACCOUNT_OPERATION.createApiKey,
                }),
              );
            }
            const resolved = await getAuthoritativeSessionFromCtx(ctx);
            if (!resolved) {
              return undefined;
            }
            requireReviewAccountAccess(
              checkReviewAccountAccess({
                email: resolved.user.email,
                config,
                operation: REVIEW_ACCOUNT_OPERATION.session,
                organizationId: resolved.session["activeOrganizationId"],
              }),
            );
            // Every organization the request names, not only the session's.
            await requireNamedOrganizations({
              adapter: ctx.context.adapter,
              body: ctx.body,
              config,
              email: resolved.user.email,
              path,
              query: ctx.query,
            });
            if (operation === "session-only") {
              return undefined;
            }
            requireReviewAccountAccess(
              checkReviewAccountAccess({
                email: resolved.user.email,
                config,
                operation,
              }),
            );
            return undefined;
          }),
        },
      ],
      after: [
        {
          matcher: ({ path }) => configured && path === SIGN_IN_EMAIL_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const key: unknown = Reflect.get(ctx.context, BUDGET_CONTEXT_KEY);
            if (typeof key !== "string" || !signInBudget) {
              return undefined;
            }
            await signInBudget.complete(key, !isAPIError(ctx.context.returned));
            return undefined;
          }),
        },
        {
          // A session outside the review organization does not resolve.
          matcher: ({ path }) => configured && path === GET_SESSION_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const resolved = ctx.context.session;
            if (!resolved) {
              return undefined;
            }
            const access = checkReviewAccountAccess({
              config,
              email: resolved.user.email,
              operation: REVIEW_ACCOUNT_OPERATION.session,
              organizationId: resolved.session["activeOrganizationId"],
            });
            if (Result.isOk(access)) {
              return undefined;
            }
            ctx.context.session = null;
            return await ctx.json(null);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};
