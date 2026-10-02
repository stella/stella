import {
  getCurrentAdapter,
  tryGetCurrentAuthEndpointContext,
} from "@better-auth/core/context";
import type { AuthContext, BetterAuthPlugin, Session } from "better-auth";
import {
  createAuthMiddleware,
  createAuthEndpoint,
  sensitiveSessionMiddleware,
} from "better-auth/api";
import * as v from "valibot";

import { AUTH_SESSION_STARTUP_HEADER } from "@stll/auth-model";
import { DAY_IN_MS } from "@stll/time";

import { hashSessionToken } from "@/api/lib/auth/session-token";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";

export const SESSION_ABSOLUTE_AGE_MS = 90 * DAY_IN_MS;
export const SESSION_IDLE_AGE_MS = 60 * 60 * 1000;
export const SESSION_PRIOR_TOKEN_GRACE_MS = 60 * 1000;
const cookieCacheVersion = "session-lifetime-v2";

export const SESSION_LIFETIME_FIELDS = {
  refreshMode: {
    type: "string",
    required: false,
    input: false,
    returned: false,
    defaultValue: "automatic",
  },
  lastSeenAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
  priorTokenHash: {
    type: "string",
    required: false,
    input: false,
    returned: false,
  },
  priorTokenExpiresAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
} as const;

type SessionObservation = {
  token: string;
  now: Date;
  boundary: "startup" | "activity";
};

type SessionRefresh = {
  token: string;
  credentialMode: "cookie" | "bearer";
  now: Date;
  expiresAt: Date;
};

export type SessionLifetimeStore = {
  observe: (options: SessionObservation) => Promise<Session | null>;
  refresh: (options: SessionRefresh) => Promise<Session | null>;
  revokeById: (options: {
    sessionId: string;
    userId: SafeId<"user">;
  }) => Promise<void>;
};

type SessionLifetimeOptions = {
  store: SessionLifetimeStore;
  now?: () => Date;
};

export const createSessionLifetime = ({
  store,
  now = () => new Date(),
}: SessionLifetimeOptions) => {
  const decorated = new WeakSet<AuthContext["internalAdapter"]>();
  const observations = new WeakMap<
    object,
    Map<string, Promise<Session | null>>
  >();
  const observe = async (token: string) => {
    const ctx = tryGetCurrentAuthEndpointContext();
    let memo = ctx ? observations.get(ctx) : undefined;
    const existing = memo?.get(token);
    if (existing) {
      return await existing;
    }
    if (ctx && !memo) {
      memo = new Map();
      observations.set(ctx, memo);
    }
    const result = store.observe({
      token,
      now: now(),
      boundary:
        ctx?.path === "/get-session" &&
        ctx.getHeader?.(AUTH_SESSION_STARTUP_HEADER) === "1"
          ? "startup"
          : "activity",
    });
    memo?.set(token, result);
    return await result;
  };

  const forgetObservations = () => {
    const ctx = tryGetCurrentAuthEndpointContext();
    if (ctx) {
      observations.delete(ctx);
    }
  };

  const decorate = (adapter: AuthContext["internalAdapter"]) => {
    if (decorated.has(adapter)) {
      return;
    }
    decorated.add(adapter);
    const findSession = adapter.findSession.bind(adapter);
    const updateSession = adapter.updateSession.bind(adapter);
    const deleteSession = adapter.deleteSession.bind(adapter);
    adapter.findSession = async (token) => {
      let current = await observe(token);
      if (!current) {
        const expired = await findSession(token);
        if (expired && expired.session.expiresAt <= now()) {
          await deleteSession(expired.session.token);
        }
        return null;
      }
      let resolved = await findSession(current.token);
      if (!resolved) {
        forgetObservations();
        current = await observe(token);
        resolved = current ? await findSession(current.token) : null;
      }
      if (resolved && resolved.session.token !== token) {
        const ctx = tryGetCurrentAuthEndpointContext();
        if (!ctx?.getSignedCookie || !ctx.setSignedCookie) {
          return resolved;
        }
        const ownToken = await ctx.getSignedCookie(
          ctx.context.authCookies.sessionToken.name,
          ctx.context.secret,
        );
        if (ownToken === token) {
          const dontRemember = await ctx.getSignedCookie(
            ctx.context.authCookies.dontRememberToken.name,
            ctx.context.secret,
          );
          await ctx.setSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            resolved.session.token,
            ctx.context.secret,
            {
              ...ctx.context.authCookies.sessionToken.attributes,
              ...(typeof dontRemember === "string" && dontRemember.length > 0
                ? {}
                : {
                    maxAge: Math.max(
                      0,
                      Math.floor(
                        (resolved.session.expiresAt.getTime() -
                          now().getTime()) /
                          1000,
                      ),
                    ),
                  }),
            },
          );
        }
      }
      return resolved;
    };
    adapter.updateSession = async (token, data) => {
      if (data.expiresAt) {
        forgetObservations();
        const ctx = tryGetCurrentAuthEndpointContext();
        const authorization = ctx?.getHeader?.("authorization") ?? "";
        const refreshed = await store.refresh({
          token,
          credentialMode: /^bearer\s/iu.test(authorization)
            ? "bearer"
            : "cookie",
          expiresAt: data.expiresAt,
          now: now(),
        });
        if (refreshed && ctx) {
          observations.set(
            ctx,
            new Map([[refreshed.token, Promise.resolve(refreshed)]]),
          );
          if (ctx.context.session?.session.id === refreshed.id) {
            ctx.context.session = {
              user: ctx.context.session.user,
              session: refreshed,
            };
          }
        }
        return refreshed;
      }
      // Native mutations may run inside an SDK transaction; resolve aliases there.
      const updated = await updateSession(token, data);
      if (updated) {
        return updated;
      }
      const ctx = tryGetCurrentAuthEndpointContext();
      if (!ctx) {
        const current = await observe(token);
        return current ? await updateSession(current.token, data) : null;
      }
      const transactionAdapter = await getCurrentAdapter(ctx.context.adapter);
      const current: unknown = await transactionAdapter.findOne({
        model: "session",
        where: [
          { field: "priorTokenHash", value: hashSessionToken(token) },
          { field: "priorTokenExpiresAt", operator: "gt", value: now() },
          { field: "expiresAt", operator: "gt", value: now() },
        ],
        select: ["token"],
      });
      if (current === null) {
        return null;
      }
      const canonical = v.parse(v.object({ token: v.string() }), current);
      return await updateSession(canonical.token, data);
    };
    adapter.deleteSession = async (token) => {
      const current = await observe(token);
      await deleteSession(current?.token ?? token);
      forgetObservations();
      const remaining = await observe(token);
      if (remaining) {
        await deleteSession(remaining.token);
        forgetObservations();
      }
    };
  };

  const plugin = {
    id: "session-lifetime",
    endpoints: {
      revokeSessionById: createAuthEndpoint(
        "/revoke-session-by-id",
        {
          method: "POST",
          body: v.strictObject({
            sessionId: v.pipe(v.string(), v.minLength(1)),
          }),
          use: [sensitiveSessionMiddleware],
          requireHeaders: true,
        },
        async (ctx) => {
          await store.revokeById({
            sessionId: ctx.body.sessionId,
            userId: brandPersistedUserId(ctx.context.session.user.id),
          });
          forgetObservations();
          return ctx.json({ status: true });
        },
      ),
    },
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            // Plugin initialization rebuilds the adapter; decorate its final instance.
            decorate(ctx.context.internalAdapter);
            await Promise.resolve();
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;

  return { plugin, cookieCacheVersion, prepare: decorate };
};
