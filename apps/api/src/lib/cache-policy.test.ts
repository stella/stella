import { describe, expect, test } from "bun:test";
import Elysia, { status } from "elysia";

import {
  applyResponseCachePolicy,
  finalizeResponseCachePolicy,
  preventPublicCaching,
} from "@/api/lib/cache-policy";
import { setSecurityHeaders } from "@/api/lib/security-headers";

const publicPolicy = { kind: "public", maxAge: 300, swr: 60 } as const;

const createSet = () => ({
  headers: {
    "Cache-Control": "private, no-store",
    "cache-control": "private, no-store",
    "CACHE-CONTROL": "private, no-store",
  },
  status: 200,
});

describe("response cache policy", () => {
  test("replaces all case variants with one canonical public policy", () => {
    const set = createSet();
    applyResponseCachePolicy({
      cache: publicPolicy,
      response: { ok: true },
      set,
    });
    expect(new Headers(set.headers).get("cache-control")).toBe(
      "public, max-age=300, stale-while-revalidate=60",
    );
    expect(Object.keys(set.headers)).toEqual(["Cache-Control"]);
  });

  test("only successful statuses opt into public caching", () => {
    for (let code = 200; code <= 599; code++) {
      const set = createSet();
      set.status = code;
      applyResponseCachePolicy({
        cache: publicPolicy,
        response: { ok: true },
        set,
      });
      expect(new Headers(set.headers).get("cache-control")).toBe(
        code < 300
          ? "public, max-age=300, stale-while-revalidate=60"
          : "private, no-store",
      );
    }
  });

  test("status wrappers and upstream errors stay private", () => {
    for (const code of [400, 401, 403, 404, 422, 429, 500, 503] as const) {
      const set = createSet();
      const response = new Response("example", { status: code });
      applyResponseCachePolicy({ cache: publicPolicy, response, set });
      const mapped = finalizeResponseCachePolicy({ response, set });
      expect(mapped.status).toBe(code);
      expect(mapped.headers.get("cache-control")).toBe("private, no-store");
      applyResponseCachePolicy({
        cache: publicPolicy,
        response: status(code, "failure"),
        set,
      });
      expect(new Headers(set.headers).get("cache-control")).toBe(
        "private, no-store",
      );
    }
  });

  test("unavailable successful fallbacks never become public", () => {
    const set = createSet();
    preventPublicCaching(set);
    const body = { message: "Coverage is unavailable" };
    const value = applyResponseCachePolicy({
      cache: publicPolicy,
      response: body,
      set,
    });
    expect(value).toBe("private, no-store");
    expect(new Headers(set.headers).get("cache-control")).toBe(
      "private, no-store",
    );
    finalizeResponseCachePolicy({ response: body, set });
    expect(new Headers(set.headers).get("cache-control")).toBe(
      "private, no-store",
    );
  });

  test("raw responses use the declared default policy", () => {
    const set = createSet();
    const response = new Response("example");
    expect(
      finalizeResponseCachePolicy({ response, set }).headers.get(
        "cache-control",
      ),
    ).toBe("private, no-store");
  });

  test("late errors revoke an earlier successful public policy", () => {
    const set = createSet();
    applyResponseCachePolicy({
      cache: publicPolicy,
      response: { ok: true },
      set,
    });
    finalizeResponseCachePolicy({ response: status(500, "failure"), set });
    expect(new Headers(set.headers).get("cache-control")).toBe(
      "private, no-store",
    );
  });

  test("immutable upstream headers are copied at the response boundary", () => {
    const response = Response.redirect("http://localhost/next", 302);
    const set = createSet();
    applyResponseCachePolicy({ cache: publicPolicy, response, set });
    const mapped = finalizeResponseCachePolicy({ response, set });
    expect(mapped.status).toBe(302);
    expect(mapped.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Cache-Control")).toBeNull();
  });

  test("wrapped raw responses use the declared policy", () => {
    for (const code of [200, 404, 500] as const) {
      const set = createSet();
      const response = status(code, new Response("example"));
      const mapped = finalizeResponseCachePolicy({ response, set });
      expect(mapped).toBeInstanceOf(Response);
      if (mapped instanceof Response) {
        expect(mapped.status).toBe(code);
        expect(mapped.headers.get("cache-control")).toBe("private, no-store");
      }
    }
  });

  test("wrapped response policies follow the effective status", () => {
    for (const innerStatus of [200, 404, 503] as const) {
      const set = createSet();
      const response = status(
        200,
        new Response("example", { status: innerStatus }),
      );
      applyResponseCachePolicy({ cache: publicPolicy, response, set });
      const mapped = finalizeResponseCachePolicy({ response, set });
      expect(mapped).toBeInstanceOf(Response);
      if (mapped instanceof Response) {
        expect(mapped.status).toBe(innerStatus);
        expect(mapped.headers.get("Cache-Control")).toBe(
          innerStatus === 200
            ? "public, max-age=300, stale-while-revalidate=60"
            : "private, no-store",
        );
      }
    }
  });

  test("a late set status also revokes public raw 200 responses", async () => {
    const app = new Elysia()
      .onRequest(({ set }) => setSecurityHeaders(set))
      .onAfterHandle(({ set }) => {
        set.status = 500;
      })
      .onMapResponse(({ responseValue, set }) =>
        finalizeResponseCachePolicy({ response: responseValue, set }),
      )
      .get("/", ({ set }) => {
        const response = new Response("upstream");
        applyResponseCachePolicy({ cache: publicPolicy, response, set });
        return response;
      });
    const response = await app.handle(new Request("http://localhost/"));
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("Elysia emits one header for raw responses and early replies", async () => {
    const app = new Elysia()
      .onRequest(({ set }) => setSecurityHeaders(set))
      .onMapResponse(({ responseValue, set }) =>
        finalizeResponseCachePolicy({ response: responseValue, set }),
      )
      .get("/private", () => new Response("example"))
      .get("/public", ({ set }) => {
        const response = new Response("body");
        applyResponseCachePolicy({ cache: publicPolicy, response, set });
        return response;
      })
      .get("/missing", () => status(404, "missing"));
    for (const [path, expected] of [
      ["/private", "private, no-store"],
      ["/public", "public, max-age=300, stale-while-revalidate=60"],
      ["/missing", "private, no-store"],
    ]) {
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(response.headers.get("cache-control")).toBe(expected);
    }
  });
});
