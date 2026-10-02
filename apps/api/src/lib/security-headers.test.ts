import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import Elysia from "elysia";

import { createAuthResponseCookiesPlugin } from "@/api/lib/auth/auth-response-cookies";
import {
  applyResponseCachePolicy,
  finalizeResponseCachePolicy,
  RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
} from "@/api/lib/security-headers";

describe("raw document response security", () => {
  test("prevents sensitive document bytes from being cached", () => {
    const response = new Response(new Uint8Array([1]), {
      headers: RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
    });

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("response cookies prevent public caching", () => {
  test.each(["pending", "response", "cookie"] as const)(
    "keeps an otherwise public response private when a late cookie comes from %s",
    async (source) => {
      const app = new Elysia()
        .use(createAuthResponseCookiesPlugin())
        .onAfterHandle(({ set, responseValue, cookie }) => {
          if (source === "pending") {
            set.headers["set-cookie"] = "session=renewed; HttpOnly; Path=/";
          } else if (source === "cookie") {
            const sessionCookie =
              cookie["session"] ?? panic("Session cookie fixture is missing");
            sessionCookie.value = "renewed";
          } else if (responseValue instanceof Response) {
            responseValue.headers.append(
              "set-cookie",
              "session=renewed; HttpOnly; Path=/",
            );
          }
        })
        .mapResponse(({ responseValue, set }) =>
          finalizeResponseCachePolicy({ response: responseValue, set }),
        )
        .get("/", ({ set }) => {
          const response = new Response("public representation");
          expect(
            applyResponseCachePolicy({
              cache: { kind: "public", maxAge: 300 },
              response,
              set,
            }),
          ).toBe("public, max-age=300");
          return response;
        });
      const response = await app.handle(new Request("http://localhost/"));
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toHaveLength(1);
      expect(response.headers.getSetCookie().at(0)).toContain(
        "session=renewed",
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    },
  );

  test("checks pending cookie headers without depending on header casing or raw responses", () => {
    for (const name of ["set-cookie", "Set-Cookie", "SET-COOKIE"]) {
      const set = { headers: { [name]: "session=renewed; Path=/" } };
      expect(
        applyResponseCachePolicy({
          cache: { kind: "public", maxAge: 300 },
          response: { ok: true },
          set,
        }),
      ).toBe("private, no-store");
      finalizeResponseCachePolicy({ response: { ok: true }, set });
      expect(new Headers(set.headers).get("cache-control")).toBe(
        "private, no-store",
      );
    }
  });
});
