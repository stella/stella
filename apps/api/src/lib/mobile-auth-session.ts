import type { BetterAuthPlugin, HookEndpointContext } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
} from "better-auth/api";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as v from "valibot";

import {
  STELLA_MOBILE_AUTH_CHALLENGE_PARAM,
  STELLA_MOBILE_AUTH_CODE_PARAM,
  STELLA_MOBILE_SCHEME,
} from "@stll/api-contract";

const BRIDGE_TTL_MS = 60_000;
const BRIDGE_IDENTIFIER_PREFIX = "mobile-session:";
const BASE64URL_SHA256_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/u;

const isExpoCookieCallbackPath = (path: string | undefined): boolean =>
  path?.startsWith("/callback/") === true ||
  path?.startsWith("/oauth2/callback") === true ||
  path?.startsWith("/magic-link/verify") === true ||
  path?.startsWith("/verify-email") === true;

export type MobileAuthBridgeValue = { challenge: string; cookie: string };

type VerificationValue = { expiresAt: Date; value: string };
type MobileAuthVerificationStore = {
  findVerificationValue: (
    identifier: string,
  ) => Promise<VerificationValue | null>;
  consumeVerificationValue: (
    identifier: string,
  ) => Promise<VerificationValue | null>;
};

export const mobileAuthChallengeForVerifier = (value: string): string =>
  createHash("sha256").update(value).digest("base64url");

const bridgeIdentifier = (code: string): string =>
  `${BRIDGE_IDENTIFIER_PREFIX}${mobileAuthChallengeForVerifier(code)}`;

const parseBridgeValue = (value: string): MobileAuthBridgeValue | undefined => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "challenge" in parsed &&
      typeof parsed.challenge === "string" &&
      BASE64URL_SHA256_PATTERN.test(parsed.challenge) &&
      "cookie" in parsed &&
      typeof parsed.cookie === "string" &&
      parsed.cookie.length > 0
    ) {
      return { challenge: parsed.challenge, cookie: parsed.cookie };
    }
  } catch {
    // A malformed/legacy verification value is indistinguishable from an
    // invalid bridge code at this public boundary.
  }
  return undefined;
};

const challengesMatch = (verifier: string, expected: string): boolean => {
  const actual = mobileAuthChallengeForVerifier(verifier);
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
};

export const protectMobileCallbackLocation = async ({
  createGrant,
  location,
}: {
  createGrant: (input: MobileAuthBridgeValue) => Promise<string>;
  location: string;
}): Promise<string | undefined> => {
  if (!URL.canParse(location)) {
    return undefined;
  }
  const redirect = new URL(location);
  if (redirect.protocol !== `${STELLA_MOBILE_SCHEME}:`) {
    return undefined;
  }
  const cookie = redirect.searchParams.get("cookie");
  if (cookie === null || cookie.length === 0) {
    return undefined;
  }

  // No native callback may retain a raw credential. Older/unbound clients fail
  // closed and must restart with the verifier-aware flow.
  redirect.searchParams.delete("cookie");
  const challenge = redirect.searchParams.get(
    STELLA_MOBILE_AUTH_CHALLENGE_PARAM,
  );
  redirect.searchParams.delete(STELLA_MOBILE_AUTH_CHALLENGE_PARAM);
  if (challenge === null || !BASE64URL_SHA256_PATTERN.test(challenge)) {
    redirect.searchParams.set("error", "mobile_callback_unbound");
    return redirect.toString();
  }

  const code = await createGrant({ challenge, cookie });
  redirect.searchParams.set(STELLA_MOBILE_AUTH_CODE_PARAM, code);
  return redirect.toString();
};

export const redeemMobileSession = async ({
  code,
  store,
  verifier,
}: {
  code: string;
  store: MobileAuthVerificationStore;
  verifier: string;
}): Promise<string | undefined> => {
  const identifier = bridgeIdentifier(code);
  const candidate = await store.findVerificationValue(identifier);
  const parsed = candidate && parseBridgeValue(candidate.value);

  // Do not consume on a wrong verifier: an interceptor that sees the code must
  // not be able to deny the legitimate installation its one attempt.
  if (!parsed || !challengesMatch(verifier, parsed.challenge)) {
    return undefined;
  }

  const consumed = await store.consumeVerificationValue(identifier);
  const consumedValue = consumed && parseBridgeValue(consumed.value);
  if (
    !consumedValue ||
    !challengesMatch(verifier, consumedValue.challenge) ||
    consumed.expiresAt.getTime() <= Date.now()
  ) {
    return undefined;
  }
  return consumedValue.cookie;
};

/**
 * Replaces the Expo plugin's raw session-cookie callback parameter with a
 * one-time code bound to a verifier that never leaves the initiating app.
 * A second Android app can still steal focus by claiming `stella://`, but it
 * receives no credential and cannot redeem the code without that verifier.
 */
export const mobileAuthSessionPlugin = {
  id: "stella-mobile-session",
  endpoints: {
    exchangeMobileSession: createAuthEndpoint(
      "/mobile-session/exchange",
      {
        method: "POST",
        body: v.object({
          code: v.pipe(v.string(), v.regex(BASE64URL_SHA256_PATTERN)),
          verifier: v.pipe(v.string(), v.regex(VERIFIER_PATTERN)),
        }),
      },
      async (ctx) => {
        const cookie = await redeemMobileSession({
          code: ctx.body.code,
          store: ctx.context.internalAdapter,
          verifier: ctx.body.verifier,
        });
        if (cookie === undefined) {
          throw new APIError("UNAUTHORIZED", {
            message: "Invalid or expired mobile sign-in",
          });
        }

        ctx.setHeader("Cache-Control", "no-store");
        return ctx.json({ cookie });
      },
    ),
  },
  hooks: {
    after: [
      {
        // Mirror every callback family on which @better-auth/expo may append a
        // cookie. Even currently unused native flows therefore fail closed.
        matcher: (ctx: HookEndpointContext) =>
          isExpoCookieCallbackPath(ctx.path),
        handler: createAuthMiddleware(async (ctx) => {
          const location = ctx.context.responseHeaders?.get("location");
          if (!location) {
            return;
          }
          const protectedLocation = await protectMobileCallbackLocation({
            location,
            createGrant: async ({ challenge, cookie }) => {
              const code = randomBytes(32).toString("base64url");
              await ctx.context.internalAdapter.createVerificationValue({
                identifier: bridgeIdentifier(code),
                value: JSON.stringify({
                  challenge,
                  cookie,
                } satisfies MobileAuthBridgeValue),
                expiresAt: new Date(Date.now() + BRIDGE_TTL_MS),
              });
              return code;
            },
          });
          if (protectedLocation !== undefined) {
            ctx.setHeader("location", protectedLocation);
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
