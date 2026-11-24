import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";

import {
  classifySitemapUpstreamFailure,
  createSitemapReadFailureResponse,
  SitemapNotFoundError,
  SitemapReadFailedError,
  SitemapUpstreamBusyError,
} from "./public-sitemap";

describe("sitemap read failure responses", () => {
  const stdout = spyOn(process.stdout, "write").mockReturnValue(true);

  afterEach(() => {
    stdout.mockClear();
  });

  afterAll(() => {
    stdout.mockRestore();
  });

  const loggedLines = (): unknown[] =>
    stdout.mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);

  const upstreamFailureResponse = ({
    addressesShard = true,
    status,
  }: {
    addressesShard?: boolean;
    status: number;
  }): Response =>
    createSitemapReadFailureResponse(
      classifySitemapUpstreamFailure({
        action: "readShard",
        addressesShard,
        response: new Response("upstream", {
          headers: { "Retry-After": "7" },
          status,
        }),
      }),
    );

  test("a busy refusal answers 503 with Retry-After and logs one line", () => {
    const response = createSitemapReadFailureResponse(
      new SitemapUpstreamBusyError({
        action: "readShard",
        message: "busy",
        retryAfter: "7",
      }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("7");
    expect(loggedLines()).toEqual([{ message: "web.sitemap.busy_refusal" }]);
  });

  test.each([429, 503])(
    "an upstream %d answers 503 with Retry-After as a busy refusal",
    (status) => {
      const response = upstreamFailureResponse({ status });

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("7");
      expect(loggedLines()).toEqual([{ message: "web.sitemap.busy_refusal" }]);
    },
  );

  test.each([400, 404, 410, 422])(
    "an upstream %d for an addressed shard answers 404 and logs nothing",
    async (status) => {
      const response = upstreamFailureResponse({ status });

      expect(response.status).toBe(404);
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(await response.text()).toBe("Not Found");
      expect(loggedLines()).toEqual([]);
    },
  );

  test("a shard the web does not publish answers 404", () => {
    const response = createSitemapReadFailureResponse(
      new SitemapNotFoundError({ action: "readShard", message: "missing" }),
    );

    expect(response.status).toBe(404);
    expect(loggedLines()).toEqual([]);
  });

  test.each([422, 404])(
    "an upstream %d for a shard list is a fault, not a missing sitemap",
    (status) => {
      const response = upstreamFailureResponse({
        addressesShard: false,
        status,
      });

      expect(response.status).toBe(503);
      expect(loggedLines()).toEqual([
        {
          action: "readShard",
          message: "web.sitemap.read_failed",
          reason: "upstream_status",
          upstreamStatus: status,
        },
      ]);
    },
  );

  test.each([500, 502])(
    "an upstream %d answers 503 and logs one read failure line",
    (status) => {
      const response = upstreamFailureResponse({ status });

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBeNull();
      expect(loggedLines()).toEqual([
        {
          action: "readShard",
          message: "web.sitemap.read_failed",
          reason: "upstream_status",
          upstreamStatus: status,
        },
      ]);
    },
  );

  test("a typed read failure logs its reason without the address", () => {
    const response = createSitemapReadFailureResponse(
      new SitemapReadFailedError({
        action: "readShard",
        cause: new Error("http://localhost:3001/v1/secret?country=cze"),
        message: "unreachable",
        reason: "upstream_unreachable",
        upstreamStatus: null,
      }),
    );

    expect(response.status).toBe(503);
    expect(loggedLines()).toEqual([
      {
        action: "readShard",
        message: "web.sitemap.read_failed",
        reason: "upstream_unreachable",
        upstreamStatus: null,
      },
    ]);
  });

  test("an untyped failure answers 503 and logs only its error name", () => {
    const response = createSitemapReadFailureResponse(
      new TypeError("fetch failed: http://localhost:3001/v1/case"),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBeNull();
    expect(loggedLines()).toEqual([
      {
        action: "readPublicSitemap",
        errorName: "TypeError",
        message: "web.sitemap.read_failed",
        reason: "unexpected_error",
        upstreamStatus: null,
      },
    ]);
    expect(String(stdout.mock.calls[0]?.[0])).not.toContain("localhost");
  });
});
