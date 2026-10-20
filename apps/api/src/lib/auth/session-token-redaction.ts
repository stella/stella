import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, isAPIError } from "better-auth/api";

const GET_SESSION_PATH = "/get-session";

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** A session row as Better Auth serializes it: its token names a login. */
const isSessionShaped = (value: Record<string, unknown>) =>
  typeof value["token"] === "string" &&
  typeof value["userId"] === "string" &&
  "expiresAt" in value;

type Redaction = { value: unknown; changed: boolean };

/**
 * Removes the token of every session-shaped object except the caller's own.
 * Other sessions are identified by id; their tokens never leave the server.
 */
export const redactForeignSessionTokens = (
  value: unknown,
  ownTokens: ReadonlySet<string>,
): Redaction => {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const redacted = redactForeignSessionTokens(item, ownTokens);
      changed ||= redacted.changed;
      return redacted.value;
    });
    return changed ? { value: items, changed } : { value, changed };
  }
  if (!isPlainObject(value)) {
    return { value, changed: false };
  }
  let changed = false;
  const entries = Object.entries(value).flatMap(([key, item]) => {
    if (
      key === "token" &&
      isSessionShaped(value) &&
      typeof item === "string" &&
      !ownTokens.has(item)
    ) {
      changed = true;
      return [];
    }
    const redacted = redactForeignSessionTokens(item, ownTokens);
    changed ||= redacted.changed;
    return [[key, redacted.value] as const];
  });
  return changed
    ? { value: Object.fromEntries(entries), changed }
    : { value, changed };
};

const ownSessionTokens = async (
  ctx: Parameters<Parameters<typeof createAuthMiddleware>[0]>[0],
): Promise<Set<string>> => {
  const tokens = new Set<string>();
  const add = (token: unknown) => {
    if (typeof token === "string" && token.length > 0) {
      tokens.add(token);
    }
  };
  add(ctx.context.newSession?.session.token);
  add(ctx.context.session?.session.token);
  add(
    await ctx.getSignedCookie(
      ctx.context.authCookies.sessionToken.name,
      ctx.context.secret,
    ),
  );
  // get-session resolves the caller's own session from their credential.
  const returned = ctx.context.returned;
  if (ctx.path === GET_SESSION_PATH && isPlainObject(returned)) {
    const session = returned["session"];
    add(isPlainObject(session) ? session["token"] : undefined);
  }
  return tokens;
};

/**
 * Every auth endpoint answer passes through here: no response carries a
 * session token other than the caller's current one.
 */
export const createSessionTokenRedactionPlugin = () =>
  ({
    id: "stella-session-token-redaction",
    hooks: {
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (returned instanceof Response || isAPIError(returned)) {
              return undefined;
            }
            const redacted = redactForeignSessionTokens(
              returned,
              await ownSessionTokens(ctx),
            );
            return redacted.changed
              ? await ctx.json(redacted.value)
              : undefined;
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
