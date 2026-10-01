import { tryGetCurrentAuthEndpointContext } from "@better-auth/core/context";
import type { AuthContext, BetterAuthPlugin, Session } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

import { AUTH_SESSION_STARTUP_HEADER } from "@stll/auth-model";
import { DAY_IN_MS } from "@stll/time";

export const SESSION_ABSOLUTE_AGE_MS = 90 * DAY_IN_MS;
export const SESSION_IDLE_AGE_MS = 60 * 60 * 1000;
export const SESSION_PRIOR_TOKEN_GRACE_MS = 60 * 1000;

export const SESSION_LIFETIME_FIELDS = {
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
  now: Date;
  expiresAt: Date;
};

export type SessionLifetimeStore = {
  observe: (options: SessionObservation) => Promise<Session | null>;
  refresh: (options: SessionRefresh) => Promise<Session | null>;
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
    const ctx = await tryGetCurrentAuthEndpointContext();
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
        ctx.headers?.get(AUTH_SESSION_STARTUP_HEADER) === "1"
          ? "startup"
          : "activity",
    });
    memo?.set(token, result);
    return await result;
  };

  const forgetObservations = async () => {
    const ctx = await tryGetCurrentAuthEndpointContext();
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
        return null;
      }
      let resolved = await findSession(current.token);
      if (!resolved) {
        await forgetObservations();
        current = await observe(token);
        resolved = current ? await findSession(current.token) : null;
      }
      if (resolved && resolved.session.token !== token) {
        const ctx = await tryGetCurrentAuthEndpointContext();
        if (ctx) {
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
              ...(dontRemember
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
        await forgetObservations();
        const refreshed = await store.refresh({
          token,
          expiresAt: data.expiresAt,
          now: now(),
        });
        const ctx = await tryGetCurrentAuthEndpointContext();
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
      const current = await observe(token);
      if (!current) {
        return null;
      }
      const updated = await updateSession(current.token, data);
      if (updated) {
        return updated;
      }
      await forgetObservations();
      const latest = await observe(token);
      return latest ? await updateSession(latest.token, data) : null;
    };
    adapter.deleteSession = async (token) => {
      const current = await observe(token);
      await deleteSession(current?.token ?? token);
      await forgetObservations();
      const remaining = await observe(token);
      if (remaining) {
        await deleteSession(remaining.token);
        await forgetObservations();
      }
    };
  };

  const plugin = {
    id: "session-lifetime",
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware((ctx) => {
            // Plugin initialization rebuilds the adapter; decorate its final instance.
            decorate(ctx.context.internalAdapter);
            return Promise.resolve();
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;

  const cookieCacheVersion = async (session: { token: string }) => {
    const current = await observe(session.token);
    return current?.token === session.token ? "1" : "resolve";
  };

  return { plugin, cookieCacheVersion, prepare: decorate };
};
