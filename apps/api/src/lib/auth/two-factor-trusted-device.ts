import type { HookEndpointContext } from "better-auth";

/** Better Auth's cookie that lets a trusted browser skip the second factor. */
const TRUST_DEVICE_COOKIE_NAME = "trust_device";

/** Request headers without the named cookie, every other cookie kept. */
const withoutCookie = (headers: Headers, cookieName: string): Headers => {
  const next = new Headers(headers);
  const cookie = headers.get("cookie");
  if (cookie === null) {
    return next;
  }
  const kept = cookie
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "" && pair.split("=")[0] !== cookieName);
  if (kept.length === 0) {
    next.delete("cookie");
  } else {
    next.set("cookie", kept.join("; "));
  }
  return next;
};

/**
 * Runs the two-factor plugin's sign-in hooks as if the browser carried no
 * trusted-device cookie, so every sign-in of an enrolled account asks for its
 * second factor. Issuing grants is off (`trustDeviceMaxAge: 0`), but a grant
 * an earlier release issued, or one an older instance writes during a rolling
 * deployment, would otherwise still skip the factor until it expires.
 */
export const withoutTrustedDeviceBypass = <
  T extends {
    hooks: {
      after: {
        matcher: (ctx: HookEndpointContext) => boolean;
        handler: (ctx: HookEndpointContext) => unknown;
      }[];
    };
  },
>(
  plugin: T,
): T => ({
  ...plugin,
  hooks: {
    ...plugin.hooks,
    after: plugin.hooks.after.map((hook) => ({
      ...hook,
      handler: async (ctx: HookEndpointContext) => {
        const headers: unknown = ctx.headers;
        if (!(headers instanceof Headers)) {
          return await hook.handler(ctx);
        }
        const cookieName = ctx.context.createAuthCookie(
          TRUST_DEVICE_COOKIE_NAME,
        ).name;
        return await hook.handler({
          ...ctx,
          headers: withoutCookie(headers, cookieName),
        });
      },
    })),
  },
});
