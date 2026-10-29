import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import type { BetterAuthClientPlugin } from "better-auth/client";
import {
  emailOTPClient,
  inferAdditionalFields,
  lastLoginMethodClient,
  organizationClient,
  twoFactorClient,
} from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";
import { Result } from "better-result";
import * as v from "valibot";

import { mcpHandoffSessionsSchema } from "@stll/api-contract/mcp-web-handoff";
import { fetchWithTimeout } from "@stll/fetch";
import { ac, roles } from "@stll/permissions";

import {
  discardBootPrefetch,
  resolveRequestMethod,
  takeBootPrefetch,
} from "@/boot-prefetch";
import { getTranslator, useI18nStore } from "@/i18n/i18n-store";
import { reportUnhandledAuthClientError } from "@/lib/account/auth-code-report";
import { notifyStepUp } from "@/lib/account/mcp-step-up";
import { ssrApiHeaders } from "@/lib/account/ssr-api-headers";
import { getAnalytics } from "@/lib/analytics/provider";
import { externalApiOrigin } from "@/lib/api-origins";
import { browserAuthBaseUrl } from "@/lib/api-url";
import { AuthClientError } from "@/lib/errors/auth";
import {
  notifyUserError,
  reportUserVisibleError,
} from "@/lib/errors/user-toast";
import { getSignedOauthQueryFromHash } from "@/lib/oauth-provider";

export const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * Stall budget for every auth request.
 *
 * `require-fetch-timeout` only reaches first-party `fetch()` calls, so the
 * auth client's own transport is the one hole in that invariant: a wedged
 * connection (laptop sleep, network switch) leaves its promise pending
 * forever. `_protected.tsx`'s `beforeLoad` awaits the role query through
 * that transport, so an unbounded request there parks the route in its
 * pending component — a full-screen loader with nothing logged.
 *
 * Bounding the request rather than racing the promise matters: an abort
 * *settles* the query (as an error the prefetch swallows), so shell chrome
 * still mounts against a resolved cache instead of a still-in-flight one.
 *
 * Deliberately below `CRITICAL_QUERY_TIMEOUT_MS` (10s) so the transport
 * settles first and that outer race stays a backstop rather than the
 * mechanism. Note this budget only bounds a single attempt: the boot
 * queries in `routes/-queries.ts` opt out of retries so the worst case
 * stays one budget rather than four plus backoff.
 */
const AUTH_REQUEST_TIMEOUT_MS = 8000;
const defineBetterAuthClientPlugin = <TPlugin extends BetterAuthClientPlugin>(
  plugin: TPlugin,
): TPlugin => plugin;

/** Pathname of a fetch input, tolerant of relative URLs (resolved against a
 *  placeholder origin: only the path is consumed). */
const requestPathname = (input: string | URL | Request): string => {
  if (typeof input === "string") {
    return new URL(input, "http://relative.invalid").pathname;
  }
  if (input instanceof URL) {
    return input.pathname;
  }
  return new URL(input.url, "http://relative.invalid").pathname;
};

const withOauthQueryFromHash = (ctx: {
  body?: unknown;
  headers: Headers;
  method: string;
}) => {
  if (
    typeof window === "undefined" ||
    ctx.method === "GET" ||
    ctx.method === "DELETE"
  ) {
    return;
  }

  const oauthQuery = getSignedOauthQueryFromHash(window.location.hash);
  if (!oauthQuery) {
    return;
  }

  const contentType = ctx.headers.get("content-type");
  const rawBody = ctx.body;
  let body = rawBody;
  if (
    typeof rawBody === "string" &&
    contentType?.toLowerCase().startsWith("application/json")
  ) {
    const parsed = Result.try((): unknown => JSON.parse(rawBody));
    if (Result.isError(parsed)) {
      return;
    }
    body = parsed.value;
  }

  if (typeof body !== "object" || body === null || "oauth_query" in body) {
    return;
  }

  ctx.headers.set("content-type", "application/json");
  ctx.body = JSON.stringify({ ...body, oauth_query: oauthQuery });
};

const authClientPlugins = [
  emailOTPClient(),
  lastLoginMethodClient(),
  organizationClient({ ac, roles }),
  inferAdditionalFields({
    session: {
      originConsentId: { type: "string", required: false },
    },
    user: {
      locale: { type: "string" },
      preferredName: { type: "string", required: false },
      timezoneId: { type: "string" },
      readerAnswerLanguage: { type: "string", required: false },
      wordEditShortcut: { type: "string", required: false },
      userShortcuts: { type: "string", required: false },
      guideProgress: { type: "string", required: false },
      detectedCountry: { type: "string", required: false },
    },
  }),
  defineBetterAuthClientPlugin(oauthProviderClient()),
  // No `onTwoFactorRedirect`/`twoFactorPage`: those globally intercept every
  // sign-in call, which would lose the in-flight `redirectTo` search param.
  // The email-OTP sign-in step (otp-panel.tsx) reads `twoFactorRedirect` off
  // its own response instead and navigates to `/auth/two-factor` explicitly.
  twoFactorClient(),
];

const customFetchImpl = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const method = resolveRequestMethod(input, init);
  if (import.meta.env.SSR) {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(ssrApiHeaders())) {
      headers.set(name, value);
    }
    return await fetchWithTimeout(input, {
      ...init,
      headers,
      signal: init?.signal ?? undefined,
      timeout: { type: "idle", ms: AUTH_REQUEST_TIMEOUT_MS },
    });
  }
  if (method === "GET") {
    // Serve the boot-time prefetch (see `boot-prefetch.ts`) for the
    // first session/role read so route entry does not wait for the main
    // graph to boot before these leave the browser. Consume-once + TTL +
    // the mutation fence below keep a stale response from ever
    // satisfying a post-auth-change read.
    const prefetched = await takeBootPrefetch(requestPathname(input));
    if (prefetched !== null) {
      return prefetched;
    }
  } else {
    // Any auth mutation (sign-in/out, org switch, 2FA) invalidates
    // whatever the boot prefetch captured before it.
    discardBootPrefetch();
  }
  return await fetchWithTimeout(input, {
    ...init,
    signal: init?.signal ?? undefined,
    timeout: { type: "idle", ms: AUTH_REQUEST_TIMEOUT_MS },
  });
};

const createStellaAuthClient = (redirectMode: "automatic" | "manual") =>
  createAuthClient({
    disableDefaultFetchPlugins: redirectMode === "manual",
    baseURL: import.meta.env.SSR ? externalApiOrigin() : browserAuthBaseUrl(),
    plugins: authClientPlugins,
    fetchOptions: {
      customFetchImpl,
      headers: {
        get "Accept-Language"() {
          return useI18nStore.getState().lang;
        },
      },
      onRequest: withOauthQueryFromHash,
      onError: (context) => {
        if (notifyStepUp(context.error)) {
          return;
        }
        if (context.response.status === HTTP_TOO_MANY_REQUESTS) {
          const t = getTranslator();
          notifyUserError(context.error, t("auth.rateLimitExceeded"));
          return;
        }
        reportUnhandledAuthClientError(
          context.error,
          reportUserVisibleError,
          context.request.url,
        );
      },
    },
  });

export const authClient = createStellaAuthClient("automatic");

/** Consent owns the completion view and navigation; the SDK's redirect hook must not race it. */
export const submitOAuthConsent = async (accept: boolean) => {
  const consentClient = createStellaAuthClient("manual");
  return await consentClient.oauth2.consent({ accept });
};

export const listAuthSessions = async () => {
  const result = await authClient.listSessions();
  if (result.error) {
    return result;
  }

  const hasHandoffSession = result.data.some(
    (session) =>
      "originConsentId" in session &&
      typeof session.originConsentId === "string" &&
      session.originConsentId.length > 0,
  );
  const clientsBySessionId = new Map<string, string | null>();
  if (hasHandoffSession) {
    const handoffSessionsResult = await Result.tryPromise({
      try: async () =>
        await authClient.$fetch<unknown>("/mcp-handoff/sessions"),
      catch: (cause) => cause,
    });

    if (Result.isError(handoffSessionsResult)) {
      getAnalytics().captureError(handoffSessionsResult.error, {
        fingerprintKey: "auth.listSessions.handoffs:fetch",
        scope: { type: "handler", handlerId: "auth.listSessions.handoffs" },
      });
    } else if (handoffSessionsResult.value.error) {
      getAnalytics().captureError(handoffSessionsResult.value.error, {
        fingerprintKey: "auth.listSessions.handoffs:response",
        scope: { type: "handler", handlerId: "auth.listSessions.handoffs" },
      });
    } else {
      const handoffsResult = v.safeParse(
        mcpHandoffSessionsSchema,
        handoffSessionsResult.value.data,
      );
      if (handoffsResult.success) {
        for (const { id, clientName } of handoffsResult.output.sessions) {
          clientsBySessionId.set(id, clientName);
        }
      } else {
        getAnalytics().captureError(
          new AuthClientError({
            message: "Invalid MCP handoff session response",
            status: 502,
            statusText: "Bad Gateway",
          }),
          {
            fingerprintKey: "auth.listSessions.handoffs:schema",
            scope: { type: "handler", handlerId: "auth.listSessions.handoffs" },
            context: {
              type: "detached",
              operation: "auth.list_sessions.handoffs",
            },
          },
        );
      }
    }
  }
  return {
    data: result.data.map((session) => ({
      originClientName: clientsBySessionId.get(session.id) ?? null,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      id: session.id,
      ipAddress: session.ipAddress,
      updatedAt: session.updatedAt,
      userAgent: session.userAgent,
      userId: session.userId,
    })),
    error: null,
  };
};

export const revokeAuthSession = async ({ sessionId }: { sessionId: string }) =>
  await authClient.$fetch("/revoke-session-by-id", {
    method: "POST",
    body: { sessionId },
  });

// The two-factor server plugin rewrites a sign-in endpoint's response body to
// `{ twoFactorRedirect: true, twoFactorMethods }` when the signed-in user has
// 2FA enabled. That rewrite happens through a server-side hook shared across
// every sign-in method, so the sign-in endpoints' own declared response types
// (e.g. `signIn.emailOtp`) never include it. Narrow structurally instead of
// casting so this keeps working whether or not a given better-auth version
// reflects the rewrite in its types.
export const isTwoFactorRedirect = (data: unknown): boolean => {
  if (typeof data !== "object" || data === null) {
    return false;
  }

  return "twoFactorRedirect" in data && data.twoFactorRedirect === true;
};

// Structural check for `session.user.twoFactorEnabled`: the twoFactorClient
// plugin declares `$InferServerPlugin` to merge this field onto the session
// user type, but this app's authClient is not generically parameterized by
// the backend's `auth` instance (see `inferAdditionalFields` above, which
// re-declares custom fields by hand for the same reason), so whether the
// field actually flows through depends on better-auth's client typing. Narrow
// structurally so this reads correctly either way.
export const isTwoFactorEnabledUser = (user: unknown): boolean => {
  if (typeof user !== "object" || user === null) {
    return false;
  }

  return "twoFactorEnabled" in user && user.twoFactorEnabled === true;
};

export type Role = keyof typeof roles;
