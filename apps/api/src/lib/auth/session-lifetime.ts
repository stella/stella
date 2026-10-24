import {
  getCurrentAdapter,
  tryGetCurrentAuthEndpointContext,
} from "@better-auth/core/context";
import type { AuthContext, BetterAuthPlugin, Session } from "better-auth";
import {
  createAuthEndpoint,
  createAuthMiddleware,
  sensitiveSessionMiddleware,
} from "better-auth/api";
import { parseUserOutput } from "better-auth/db";
import * as v from "valibot";

import {
  liveSessionAdapterWhere,
  SESSION_ABSOLUTE_AGE_MS,
} from "@/api/lib/auth/session-liveness";
import { hashSessionToken } from "@/api/lib/auth/session-token";
import type { SafeId } from "@/api/lib/branded-types";
import { brandPersistedUserId } from "@/api/lib/safe-id-boundaries";
import {
  SYNTHETIC_SESSION_LIFETIME_MS,
  SYNTHETIC_SESSION_PREFIX,
} from "@/api/lib/synthetic-principal/constants";

export { SESSION_ABSOLUTE_AGE_MS } from "@/api/lib/auth/session-liveness";

export const SESSION_PRIOR_TOKEN_RECOVERY_MS = 10 * 60 * 1000;
// Synthetic and handoff sessions resolve storage on every read, and a pending
// rotation needs one storage read before its snapshot is reusable; ordinary
// snapshots retain their cache.
const cookieCacheVersion = (
  session: Pick<Session, "id"> & Readonly<Record<string, unknown>>,
) => {
  if (
    session.id.startsWith(SYNTHETIC_SESSION_PREFIX) ||
    typeof session["priorTokenHash"] === "string"
  ) {
    return Bun.randomUUIDv7();
  }
  if (typeof session["originConsentId"] === "string") {
    return `handoff:${Bun.randomUUIDv7()}`;
  }
  return "session-lifetime-v2";
};

type SessionLifetimeDecision = {
  refreshMode: "fixed";
  expiresAt: Date;
};

/** Keeps framework session creation aligned with explicitly minted credentials. */
export const decidePinnedSessionLifetime = (
  session: Partial<Pick<Session, "id" | "createdAt">>,
): SessionLifetimeDecision | undefined =>
  session.id?.startsWith(SYNTHETIC_SESSION_PREFIX)
    ? {
        refreshMode: "fixed",
        expiresAt: new Date(
          (session.createdAt ?? new Date()).getTime() +
            SYNTHETIC_SESSION_LIFETIME_MS,
        ),
      }
    : undefined;

export const SESSION_LIFETIME_FIELDS = {
  originConsentId: { type: "string", required: false, input: false },
  handoffAbsoluteExpiresAt: {
    type: "date",
    required: false,
    input: false,
    returned: false,
  },
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
  presentedToken?: string;
};

type SessionRefresh = {
  token: string;
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

const resolveObservedSession = async (
  session: Session,
  { internalAdapter, options }: AuthContext,
) => {
  const user = await internalAdapter.findUserById(session.userId);
  return user
    ? {
        session,
        user: parseUserOutput(options, user),
      }
    : null;
};

type PriorSessionTokenOptions = {
  context: AuthContext;
  token: string;
  now: Date;
};

const findPriorSessionToken = async ({
  context,
  token,
  now,
}: PriorSessionTokenOptions) => {
  const adapter = await getCurrentAdapter(context.adapter);
  const current: unknown = await adapter.findOne({
    model: "session",
    where: [
      { field: "priorTokenHash", value: hashSessionToken(token) },
      { field: "priorTokenExpiresAt", operator: "gt", value: now },
      ...liveSessionAdapterWhere(now),
    ],
    select: ["token"],
  });
  return current === null
    ? null
    : v.parse(v.object({ token: v.string() }), current).token;
};

type SessionDeletionOptions = {
  deleteSession: AuthContext["internalAdapter"]["deleteSession"];
  observe: (token: string) => Promise<Session | null>;
  forgetObservations: () => void;
  now: () => Date;
};

const createSessionDeleter =
  ({
    deleteSession,
    observe,
    forgetObservations,
    now,
  }: SessionDeletionOptions) =>
  async (token: string) => {
    const ctx = tryGetCurrentAuthEndpointContext();
    if (ctx) {
      // Revocation inside an SDK transaction must use its adapter throughout.
      await deleteSession(token);
      const canonical = await findPriorSessionToken({
        context: ctx.context,
        token,
        now: now(),
      });
      if (canonical !== null) {
        await deleteSession(canonical);
      }
      forgetObservations();
      return;
    }
    const current = await observe(token);
    await deleteSession(current?.token ?? token);
    forgetObservations();
    const remaining = await observe(token);
    if (remaining) {
      await deleteSession(remaining.token);
      forgetObservations();
    }
  };

const createRevokeSessionByIdEndpoint = (
  store: SessionLifetimeStore,
  forgetObservations: () => void,
) =>
  createAuthEndpoint(
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
  );

const readPresentedSessionToken = async () => {
  const ctx = tryGetCurrentAuthEndpointContext();
  if (!ctx?.getSignedCookie) {
    return undefined;
  }
  const token = await ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret,
  );
  return typeof token === "string" ? token : undefined;
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
      presentedToken: await readPresentedSessionToken(),
    });
    memo?.set(token, result);
    const observed = await result;
    if (observed) {
      memo?.set(observed.token, result);
    }
    return observed;
  };

  const forgetObservations = () => {
    const ctx = tryGetCurrentAuthEndpointContext();
    if (ctx) {
      observations.delete(ctx);
    }
  };

  const decorate = (auth: AuthContext) => {
    const { internalAdapter: adapter } = auth;
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
        // An expired or outlived row is removed, like any refused session.
        if (
          expired &&
          (expired.session.expiresAt <= now() ||
            expired.session.createdAt.getTime() <=
              now().getTime() - SESSION_ABSOLUTE_AGE_MS)
        ) {
          await deleteSession(expired.session.token);
        }
        return null;
      }
      let resolved = await resolveObservedSession(current, auth);
      if (!resolved) {
        forgetObservations();
        current = await observe(token);
        resolved = current ? await resolveObservedSession(current, auth) : null;
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
        const current = await observe(token);
        if (
          !current ||
          current.expiresAt.getTime() >=
            current.createdAt.getTime() + SESSION_ABSOLUTE_AGE_MS
        ) {
          return current;
        }
        forgetObservations();
        const ctx = tryGetCurrentAuthEndpointContext();
        const refreshed = await store.refresh({
          token,
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
      const canonical = await findPriorSessionToken({
        context: ctx.context,
        token,
        now: now(),
      });
      if (canonical === null) {
        return null;
      }
      return await updateSession(canonical, data);
    };
    adapter.deleteSession = createSessionDeleter({
      deleteSession,
      observe,
      forgetObservations,
      now,
    });
  };

  const plugin = {
    id: "session-lifetime",
    endpoints: {
      revokeSessionById: createRevokeSessionByIdEndpoint(
        store,
        forgetObservations,
      ),
    },
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            // Plugin initialization rebuilds the adapter; decorate its final instance.
            decorate(ctx.context);
            await Promise.resolve();
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;

  return {
    plugin,
    cookieCacheVersion,
    prepare: decorate,
  };
};
