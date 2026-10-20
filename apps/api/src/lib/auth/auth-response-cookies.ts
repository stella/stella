import Elysia from "elysia";
import type { Context } from "elysia";

// A bearer client receives its rotated session token in this header.
const ROTATED_BEARER_HEADER = "set-auth-token";
const EXPOSE_HEADERS = "access-control-expose-headers";

const headerValue = (
  headers: Context["set"]["headers"] | Headers,
  name: string,
): string | undefined => {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  const value = headers[name];
  return typeof value === "string" ? value : undefined;
};

const withExposedHeader = (existing: string | undefined, name: string) => {
  const names = new Set(
    (existing ?? "")
      .split(",")
      .map((header) => header.trim())
      .filter(Boolean),
  );
  names.add(name);
  return [...names].join(", ");
};

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
      const rotatedBearer = headerValue(set.headers, ROTATED_BEARER_HEADER);
      if (rotatedBearer !== undefined) {
        headers.set(ROTATED_BEARER_HEADER, rotatedBearer);
        headers.set(
          EXPOSE_HEADERS,
          withExposedHeader(
            headers.get(EXPOSE_HEADERS) ?? undefined,
            ROTATED_BEARER_HEADER,
          ),
        );
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
  target: Context["set"]["headers"] | Headers,
  source: Headers,
) => {
  const rotatedBearer = source.get(ROTATED_BEARER_HEADER);
  if (rotatedBearer !== null) {
    const exposed = withExposedHeader(
      headerValue(target, EXPOSE_HEADERS),
      ROTATED_BEARER_HEADER,
    );
    if (target instanceof Headers) {
      target.set(ROTATED_BEARER_HEADER, rotatedBearer);
      target.set(EXPOSE_HEADERS, exposed);
    } else {
      target[ROTATED_BEARER_HEADER] = rotatedBearer;
      target[EXPOSE_HEADERS] = exposed;
    }
  }
  const cookies = source.getSetCookie();
  if (cookies.length === 0) {
    return;
  }
  if (target instanceof Headers) {
    for (const cookie of cookies) {
      target.append("set-cookie", cookie);
    }
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
