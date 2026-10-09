import {
  createAuthEndpoint,
  createAuthMiddleware,
} from "@better-auth/core/api";
import { defineRequestState } from "@better-auth/core/context";
import type { BetterAuthPlugin, Verification } from "better-auth";
import type { getOAuthState } from "better-auth/api";
import { Result } from "better-result";
import * as v from "valibot";

import { AUTH_SOCIAL_PROVIDER_IDS } from "@stll/auth-model";
import { Temporal } from "@stll/time";

import { hashSessionToken } from "@/api/lib/auth/session-token";
import {
  CACHE_CONTROL_HEADER,
  PRIVATE_CACHE_CONTROL,
} from "@/api/lib/security-headers";
import { isRecord } from "@/api/lib/type-guards";

const HINT_LIFETIME_MS = 10 * 60 * 1000;
const HINT_COOKIE = "social_link_hint";
const providerSchema = v.picklist(AUTH_SOCIAL_PROVIDER_IDS);
const hintSchema = v.strictObject({
  method: providerSchema,
  provider: providerSchema,
  attempt: v.string(),
  expiresAt: v.number(),
});
type Hint = v.InferOutput<typeof hintSchema>;

type CallbackProof = { email: string; provider: Hint["provider"] } | null;
const callbackProof = defineRequestState<CallbackProof>(() => null);

export const socialLinkHintIdentifier = (value: string) =>
  `social-link-hint:${hashSessionToken(value)}`;

export const createSocialLinkHintPlugin = (
  readOAuthState: typeof getOAuthState,
) =>
  ({
    id: "social-link-hint",
    endpoints: {
      consumeSocialLinkHint: createAuthEndpoint(
        "/social-link-hint",
        { method: "POST" },
        async (ctx) => {
          const cookie = ctx.context.createAuthCookie(HINT_COOKIE);
          const value = await ctx.getSignedCookie(
            cookie.name,
            ctx.context.secret,
          );
          ctx.setCookie(cookie.name, "", { ...cookie.attributes, maxAge: 0 });
          ctx.setHeader(CACHE_CONTROL_HEADER, PRIVATE_CACHE_CONTROL);
          const generic = { method: null, provider: null };
          if (typeof value !== "string") {
            return ctx.json(generic);
          }
          const decoded = Result.try((): unknown => JSON.parse(value));
          if (Result.isError(decoded)) {
            return ctx.json(generic);
          }
          const parsed = v.safeParse(hintSchema, decoded.value);
          if (
            !parsed.success ||
            parsed.output.expiresAt <= Temporal.Now.instant().epochMilliseconds
          ) {
            return ctx.json(generic);
          }
          const consumed = await ctx.context.adapter.consumeOne<Verification>({
            model: "verification",
            where: [
              { field: "identifier", value: socialLinkHintIdentifier(value) },
              { field: "expiresAt", operator: "gt", value: new Date() },
            ],
          });
          if (!consumed) {
            return ctx.json(generic);
          }
          return ctx.json({
            method: parsed.output.method,
            provider: parsed.output.provider,
          });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: (ctx) =>
            ctx.path === "/callback/:id" && ctx.method === "GET",
          handler: createAuthMiddleware(async (ctx) => {
            await callbackProof.set(null);
            // Clone providers on this request's context: neither the wrapper nor
            // the proof can be observed by another concurrent OAuth callback.
            ctx.context.socialProviders = ctx.context.socialProviders.map(
              (provider) => ({
                ...provider,
                getUserInfo: async (tokens) => {
                  const result = await provider.getUserInfo(tokens);
                  const parsedProvider = v.safeParse(
                    providerSchema,
                    provider.id,
                  );
                  if (
                    parsedProvider.success &&
                    result?.user.emailVerified === true &&
                    typeof result.user.email === "string"
                  ) {
                    await callbackProof.set({
                      email: result.user.email.toLowerCase(),
                      provider: parsedProvider.output,
                    });
                  }
                  return result;
                },
              }),
            );
          }),
        },
      ],
      after: [
        {
          matcher: (ctx) =>
            ctx.path === "/callback/:id" && ctx.method === "GET",
          handler: createAuthMiddleware(async (ctx) => {
            const returned: unknown = ctx.context.returned;
            const headers = isRecord(returned)
              ? returned["headers"]
              : undefined;
            const location =
              headers instanceof Headers ? headers.get("location") : null;
            if (
              !location ||
              new URL(location, ctx.context.baseURL).searchParams.get(
                "error",
              ) !== "account_not_linked"
            ) {
              return;
            }
            const proof = await callbackProof.get();
            const state = await readOAuthState();
            // getOAuthState is populated only after Better Auth checks and
            // consumes the callback's state cookie.
            const query: unknown = ctx.query;
            const attempt = isRecord(query) ? query["state"] : undefined;
            if (
              !proof ||
              !state ||
              state.link ||
              state.expiresAt <= Temporal.Now.instant().epochMilliseconds ||
              typeof attempt !== "string"
            ) {
              return;
            }
            const existing = await ctx.context.internalAdapter.findUserByEmail(
              proof.email,
              { includeAccounts: true },
            );
            const method = existing?.accounts
              .map((account) => v.safeParse(providerSchema, account.providerId))
              .find((parsed) => parsed.success);
            if (!method?.success) {
              return;
            }
            const hint = {
              method: method.output,
              provider: proof.provider,
              attempt: hashSessionToken(attempt),
              expiresAt:
                Temporal.Now.instant().epochMilliseconds + HINT_LIFETIME_MS,
            } satisfies Hint;
            const value = JSON.stringify(hint);
            await ctx.context.internalAdapter.createVerificationValue({
              identifier: socialLinkHintIdentifier(value),
              value: "",
              expiresAt: new Date(hint.expiresAt),
            });
            const cookie = ctx.context.createAuthCookie(HINT_COOKIE, {
              maxAge: HINT_LIFETIME_MS / 1000,
            });
            await ctx.setSignedCookie(
              cookie.name,
              value,
              ctx.context.secret,
              cookie.attributes,
            );
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
