import { describe, expect, test } from "bun:test";

import { createHttpApp } from "@/api/http/app";
import { responseCachePolicy } from "@/api/http/cache";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

import type { OperatorRegistrationsOptions } from "./registrations";
import { createOperatorRoute } from "./routes";

/** The operator route over a real socket, behind the stages that decide its caching and failures. */
const serveOperatorRoute = (options: OperatorRegistrationsOptions) =>
  serveForTest(
    createHttpApp({
      routes: createOperatorRoute(options),
      middleware: [responseCachePolicy, errorBoundary],
    }),
  );

const NOW = Date.parse("2026-10-05T08:00:00Z");
const SINCE = "2026-10-04T08:00:00Z";
const request = (query: string, credential?: string) =>
  new Request(`http://localhost/operator/registrations${query}`, {
    headers:
      credential === undefined ? {} : { authorization: `Bearer ${credential}` },
  });

describe("operator registration HTTP boundary", () => {
  test("refuses disabled or unauthorized requests before validating queries or reading", async () => {
    const secret = Bun.randomUUIDv7();
    for (const { configuredToken, credential, status } of [
      { configuredToken: undefined, credential: secret, status: 404 },
      { configuredToken: secret, credential: undefined, status: 401 },
      { configuredToken: secret, credential: Bun.randomUUIDv7(), status: 401 },
    ]) {
      let reads = 0;
      await using app = serveOperatorRoute({
        configuredToken: () => configuredToken,
        now: () => NOW,
        readPage: async ({ limit }) => {
          reads += 1;
          return { items: [], limit, nextCursor: null };
        },
      });
      for (const query of [
        "",
        "?since=invalid&limit=-1&cursor=invalid",
        `?since=${SINCE}`,
      ]) {
        const response = await app.fetch(request(query, credential));
        expect(response.status).toBe(status);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.text();
        expect(body).not.toContain(secret);
        expect(body).not.toContain("email");
        expect(body).not.toContain("since");
      }
      expect(reads).toBe(0);
    }
  });

  test("returns a bounded page through the configured credential", async () => {
    const secret = Bun.randomUUIDv7();
    const queries: Parameters<OperatorRegistrationsOptions["readPage"]>[0][] =
      [];
    const item = {
      name: "Test User",
      email: "registration@example.test",
      organization: { id: "test-org", name: "Test Organization" },
      created_at: SINCE,
    };
    await using app = serveOperatorRoute({
      configuredToken: () => secret,
      now: () => NOW,
      readPage: async (query) => {
        queries.push(query);
        return { items: [item], limit: query.limit, nextCursor: null };
      },
    });
    const response = await app.fetch(
      request(`?since=${SINCE}&limit=1000`, secret),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      items: [item],
      limit: 100,
      nextCursor: null,
    });
    expect(queries).toEqual([
      { since: "2026-10-04T08:00:00Z", limit: 100, cursor: null },
    ]);
  });

  test("rejects invalid authorized queries without a directory read", async () => {
    const secret = Bun.randomUUIDv7();
    let reads = 0;
    await using app = serveOperatorRoute({
      configuredToken: () => secret,
      now: () => NOW,
      readPage: async ({ limit }) => {
        reads += 1;
        return { items: [], limit, nextCursor: null };
      },
    });
    for (const query of [
      "",
      "?since=invalid",
      "?since=2026-10-06T08:00:00Z",
      "?since=2026-09-01T08:00:00Z",
      `?since=${SINCE}&limit=0`,
      `?since=${SINCE}&cursor=invalid`,
    ]) {
      expect((await app.fetch(request(query, secret))).status).toBe(400);
    }
    expect(reads).toBe(0);
  });

  test("propagates an audited-read failure without returning personal data", async () => {
    const secret = Bun.randomUUIDv7();
    await using app = serveOperatorRoute({
      configuredToken: () => secret,
      now: () => NOW,
      readPage: async () => {
        throw new TypeError("registration read unavailable");
      },
    });
    const response = await app.fetch(request(`?since=${SINCE}`, secret));
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain(
      "registration read unavailable",
    );
  });
});
