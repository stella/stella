import type { BetterAuthPlugin } from "better-auth";
import type { createAuthMiddleware } from "better-auth/api";

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

type Redaction =
  | { changed: true; value: Record<string, unknown> | unknown[] }
  | { changed: false; value: unknown };

/**
 * Removes the token of every session-shaped object except the caller's own.
 * Other sessions are identified by id; their tokens never leave the server.
 */
export const redactForeignSessionTokens = (
  value: unknown,
  ownTokens: ReadonlySet<string>,
): Redaction => {
  if (Array.isArray(value)) {
    const items = value.map((item) =>
      redactForeignSessionTokens(item, ownTokens),
    );
    return items.some((item) => item.changed)
      ? { changed: true, value: items.map((item) => item.value) }
      : { changed: false, value };
  }
  if (!isPlainObject(value)) {
    return { changed: false, value };
  }
  const sessionShaped = isSessionShaped(value);
  const entries = Object.entries(value).map(([key, item]) => {
    const foreignToken =
      key === "token" &&
      sessionShaped &&
      typeof item === "string" &&
      !ownTokens.has(item);
    return {
      key,
      foreignToken,
      redacted: foreignToken
        ? null
        : redactForeignSessionTokens(item, ownTokens),
    };
  });
  const changed = entries.some(
    ({ foreignToken, redacted }) => foreignToken || redacted?.changed === true,
  );
  if (!changed) {
    return { changed: false, value };
  }
  return {
    changed: true,
    value: Object.fromEntries(
      entries.flatMap(({ key, redacted }) =>
        redacted === null ? [] : [[key, redacted.value] as const],
      ),
    ),
  };
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
 * session token other than the caller's current one. Errors and raw
 * responses are not plain objects, so they pass through unchanged.
 */
export const createSessionTokenRedactionPlugin = (
  middleware: typeof createAuthMiddleware,
) =>
  ({
    id: "stella-session-token-redaction",
    hooks: {
      after: [
        {
          matcher: () => true,
          handler: middleware(async (ctx) => {
            const redacted = redactForeignSessionTokens(
              ctx.context.returned,
              await ownSessionTokens(ctx),
            );
            if (!redacted.changed) {
              return undefined;
            }
            return await ctx.json(redacted.value);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
