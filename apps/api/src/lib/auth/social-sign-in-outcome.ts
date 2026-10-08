import type { BetterAuthPlugin, HookEndpointContext } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";

import { emitSocialSignInOutcome } from "@/api/lib/observability/request-metrics";
import type { SocialSignInOutcome } from "@/api/lib/observability/request-metrics";

const CALLBACK_PATH_PREFIX = "/callback/";
const KNOWN_PROVIDERS = new Set(["google", "microsoft"]);

/**
 * Reads the outcome from the redirect the callback answers with. Better Auth
 * reports every callback failure as a redirect to its error URL carrying an
 * `error` code, and a completed sign-in or link as a redirect elsewhere. Only
 * a redirect to the error URL counts as a failure, so a caller-chosen
 * callback URL cannot pose as one.
 */
export const classifySocialCallback = (
  returned: unknown,
  errorUrl: string,
): SocialSignInOutcome => {
  if (!isAPIError(returned)) {
    return "failed";
  }
  const headers: unknown = returned.headers;
  const location = headers instanceof Headers ? headers.get("location") : null;
  if (returned.statusCode !== 302 || location === null) {
    return "failed";
  }
  const target = URL.parse(location, errorUrl);
  const expected = URL.parse(errorUrl);
  if (
    target === null ||
    expected === null ||
    target.origin !== expected.origin ||
    target.pathname !== expected.pathname
  ) {
    return "completed";
  }
  switch (target.searchParams.get("error") ?? "") {
    case "account_not_linked":
      return "account_not_linked";
    case "identity_not_allowed":
      return "identity_not_allowed";
    default:
      return "failed";
  }
};

export const socialSignInOutcomePlugin = {
  id: "stella-social-sign-in-outcome",
  hooks: {
    after: [
      {
        matcher: (ctx: HookEndpointContext) =>
          ctx.path?.startsWith(CALLBACK_PATH_PREFIX) ?? false,
        handler: createAuthMiddleware(async (ctx) => {
          const provider: unknown = ctx.params?.["id"];
          emitSocialSignInOutcome(
            classifySocialCallback(
              ctx.context.returned,
              ctx.context.options.onAPIError?.errorURL ??
                `${ctx.context.baseURL}/error`,
            ),
            typeof provider === "string" && KNOWN_PROVIDERS.has(provider)
              ? provider
              : "other",
          );
          await Promise.resolve();
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
