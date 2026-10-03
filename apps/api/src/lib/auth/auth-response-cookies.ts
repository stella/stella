import Elysia from "elysia";
import type { Context } from "elysia";

export const createAuthResponseCookiesPlugin = () =>
  new Elysia({ name: "auth-response-cookies" }).onAfterHandle(
    { as: "global" },
    ({ responseValue, set }) => {
      if (!(responseValue instanceof Response)) {
        return undefined;
      }
      const pending =
        set.headers instanceof Headers
          ? set.headers.getSetCookie()
          : set.headers["set-cookie"];
      if (pending === undefined || pending.length === 0) {
        return undefined;
      }
      const cookies = Array.isArray(pending) ? pending : [pending];
      const headers = new Headers(responseValue.headers);
      for (const cookie of cookies) {
        headers.append("set-cookie", cookie);
      }
      // Response cookies own the combined list before Elysia merges set.headers.
      if (set.headers instanceof Headers) {
        set.headers.delete("set-cookie");
      } else {
        delete set.headers["set-cookie"];
      }
      return new Response(responseValue.body, {
        status: responseValue.status,
        statusText: responseValue.statusText,
        headers,
      });
    },
  );

export const forwardAuthResponseCookies = (
  target: Context["set"]["headers"],
  source: Headers,
) => {
  const cookies = source.getSetCookie();
  if (cookies.length === 0) {
    return;
  }
  const existing = target["set-cookie"];
  const combined: string[] = [];
  if (Array.isArray(existing)) {
    combined.push(...existing);
  } else if (existing) {
    combined.push(existing);
  }
  combined.push(...cookies);
  target["set-cookie"] = combined;
};
