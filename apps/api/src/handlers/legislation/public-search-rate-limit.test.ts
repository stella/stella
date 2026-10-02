import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { STELLA_API_VERSION_PREFIX } from "@stll/api-contract";

import { API_RATE_LIMITS } from "@/api/lib/limits";
import {
  InMemoryRateLimitContext,
  rateLimit,
  scopedGenerator,
} from "@/api/lib/rate-limit/rate-limit";

import {
  isPublicStatuteSearchRateLimitedRequest,
  PUBLIC_STATUTE_SEARCH_PATH,
  PUBLIC_STATUTE_SEARCH_RATE_LIMIT_POLICY,
  publicStatuteSearchRateLimitKey,
} from "./public-search-rate-limit";

const searchPath = `${STELLA_API_VERSION_PREFIX}${PUBLIC_STATUTE_SEARCH_PATH}`;
const request = (path: string, method = "GET") =>
  new Request(`http://localhost${path}`, { method });

describe("public statute search request budget", () => {
  test("charges GET and its implicit HEAD search, including the accepted trailing slash", () => {
    for (const path of [
      searchPath,
      `${searchPath}/`,
      `${searchPath}?query=test`,
    ]) {
      expect(isPublicStatuteSearchRateLimitedRequest(request(path))).toBe(true);
      expect(
        isPublicStatuteSearchRateLimitedRequest(request(path, "HEAD")),
      ).toBe(true);
    }
    for (const path of [
      PUBLIC_STATUTE_SEARCH_PATH,
      "/v1/law/statutes",
      "/v1/law/statutes/read",
      "/v1/law/statutes/search/extra",
      "/v1/legislation/search",
    ]) {
      expect(isPublicStatuteSearchRateLimitedRequest(request(path))).toBe(
        false,
      );
    }
    for (const method of ["POST", "OPTIONS", "PUT", "DELETE"]) {
      expect(
        isPublicStatuteSearchRateLimitedRequest(request(searchPath, method)),
      ).toBe(false);
    }
  });

  test("keys the search budget by the trusted client address, independent of credentials", async () => {
    const firstRequest = request(searchPath);
    const secondRequest = new Request(firstRequest, {
      headers: {
        authorization: "Bearer a-different-credential",
        "x-forwarded-for": "198.51.100.10",
      },
    });
    const firstPeer = { requestIP: () => ({ address: "192.0.2.1" }) };
    const secondPeer = { requestIP: () => ({ address: "192.0.2.2" }) };
    const firstKey = await publicStatuteSearchRateLimitKey(
      firstRequest,
      firstPeer,
    );
    expect(
      await publicStatuteSearchRateLimitKey(secondRequest, firstPeer),
    ).toBe(firstKey);
    expect(
      await publicStatuteSearchRateLimitKey(firstRequest, secondPeer),
    ).not.toBe(firstKey);
    expect(firstKey).toBe("public-statute-search:192.0.2.1");
  });

  test("the N+1th search returns the standard 429 without consuming the shared bucket", async () => {
    const sharedContext = new InMemoryRateLimitContext();
    const searchContext = new InMemoryRateLimitContext();
    const app = new Elysia().group(STELLA_API_VERSION_PREFIX, (versioned) =>
      versioned
        .use(
          rateLimit({
            context: sharedContext,
            duration: API_RATE_LIMITS.api.duration,
            generator: scopedGenerator("api"),
            max: 1,
            skip: isPublicStatuteSearchRateLimitedRequest,
          }),
        )
        .use(
          new Elysia()
            .use(
              rateLimit({
                ...PUBLIC_STATUTE_SEARCH_RATE_LIMIT_POLICY,
                context: searchContext,
                generator: publicStatuteSearchRateLimitKey,
              }),
            )
            .get(PUBLIC_STATUTE_SEARCH_PATH, () => ({ items: [] }))
            .get("/law/statutes", () => "browse"),
        )
        .get("/other", () => "ordinary"),
    );
    try {
      for (
        let index = 0;
        index < API_RATE_LIMITS.publicStatuteSearch.max;
        index += 1
      ) {
        const response = await app.handle(request(searchPath));
        expect(response.status).toBe(200);
      }
      const limited = await app.handle(request(`${searchPath}/`));
      expect(limited.status).toBe(429);
      expect(await limited.text()).toBe("rate-limit reached");
      expect(limited.headers.get("retry-after")).toMatch(/^\d+$/u);
      expect(limited.headers.get("ratelimit-limit")).toBe(
        String(API_RATE_LIMITS.publicStatuteSearch.max),
      );
      const browse = await app.handle(request("/v1/law/statutes"));
      expect(browse.status).toBe(200);
      // The browse request consumes the first shared token; none of the 31 searches did.
      expect((await app.handle(request("/v1/other"))).status).toBe(429);
    } finally {
      sharedContext.kill();
      searchContext.kill();
    }
  });

  test("unrelated public law traffic cannot consume the search budget", async () => {
    const context = new InMemoryRateLimitContext();
    const app = new Elysia()
      .use(
        rateLimit({
          ...PUBLIC_STATUTE_SEARCH_RATE_LIMIT_POLICY,
          context,
          generator: publicStatuteSearchRateLimitKey,
        }),
      )
      .get(searchPath, () => "search")
      .get("/v1/law/statutes", () => "browse");
    try {
      for (
        let index = 0;
        index <= API_RATE_LIMITS.publicStatuteSearch.max;
        index += 1
      ) {
        expect((await app.handle(request("/v1/law/statutes"))).status).toBe(
          200,
        );
      }
      expect((await app.handle(request(searchPath))).status).toBe(200);
    } finally {
      context.kill();
    }
  });
});
