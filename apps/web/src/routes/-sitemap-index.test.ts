import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

Object.assign(import.meta.env, {
  VITE_API_URL: "http://localhost:3001",
  VITE_PUBLIC_APP_URL: "http://localhost:3000",
});

const { createSitemapHandlers, Route, sitemapHandlers } =
  await import("./sitemap[.]xml");

const requestPath = (input: Request | URL | string) =>
  new URL(input instanceof Request ? input.url : input.toString()).pathname;

const upstreamResponse = (status: number) =>
  status === 200
    ? Response.json({ items: [], limit: 50_000, nextCursor: null })
    : new Response("busy", { status, headers: { "Retry-After": "17" } });

describe("root sitemap read failures", () => {
  test("the route serves the canonical sitemap handlers", () => {
    expect(Route.options.server?.handlers).toBe(sitemapHandlers);
  });

  test.each([
    { caseLawStatus: 429, statuteStatus: 200, expectedStatus: 503 },
    { caseLawStatus: 502, statuteStatus: 200, expectedStatus: 503 },
    { caseLawStatus: 503, statuteStatus: 200, expectedStatus: 503 },
    { caseLawStatus: 200, statuteStatus: 429, expectedStatus: 503 },
    { caseLawStatus: 200, statuteStatus: 502, expectedStatus: 503 },
    { caseLawStatus: 200, statuteStatus: 503, expectedStatus: 503 },
  ])(
    "upstream response pair %j refuses the entire index",
    async ({ caseLawStatus, statuteStatus, expectedStatus }) => {
      const requests: string[] = [];
      const handlers = createSitemapHandlers({
        isEnabled: () => true,
        fetchImpl: async (input) => {
          const path = requestPath(input);
          requests.push(path);
          switch (path) {
            case "/v1/case/sitemap/shards":
              return upstreamResponse(caseLawStatus);
            case "/v1/law/sitemap/shards":
              return upstreamResponse(statuteStatus);
            default:
              return panic(`Unexpected sitemap upstream request: ${path}`);
          }
        },
      });

      const response = await handlers.GET();

      expect(requests).toHaveLength(2);
      expect(requests).toContain("/v1/case/sitemap/shards");
      expect(requests).toContain("/v1/law/sitemap/shards");
      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("Retry-After")).toBe(
        [caseLawStatus, statuteStatus].some(
          (status) => status === 429 || status === 503,
        )
          ? "17"
          : null,
      );
      expect(await response.text()).toBe("Service Unavailable");
    },
  );
});
