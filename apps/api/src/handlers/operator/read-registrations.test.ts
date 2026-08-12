import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import * as v from "valibot";

import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS } from "./query";
import { createReadRegistrationsEndpoint } from "./read-registrations";

const TOKEN = "operator-test-token-0123456789abcdef";

const pageBodySchema = v.object({
  items: v.array(v.record(v.string(), v.unknown())),
  nextCursor: v.nullable(v.string()),
  limit: v.number(),
});

const daysAgo = (days: number): Date =>
  new Date(Date.now() - days * 24 * 60 * 60 * 1000);

type MockRow = {
  id: string;
  email: string;
  name: string;
  detectedCountry: string | null;
  createdAt: Date;
  createdAtCursor: string;
};

const mockRow = (id: string): MockRow => ({
  id,
  email: `${id}@example.test`,
  name: `User ${id}`,
  detectedCountry: null,
  createdAt: daysAgo(2),
  createdAtCursor: "2026-07-10T12:00:00.000000",
});

/** The app plus a counter of how many times it opened the instance-wide read. */
const buildCountedApp = ({
  configuredToken,
  rows = [],
}: {
  configuredToken: string | undefined;
  rows?: MockRow[];
}) => {
  const { getCallCount, safeDb } = createScopedDbMock({
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    }),
  });
  const endpoint = createReadRegistrationsEndpoint({
    getConfiguredToken: () => configuredToken,
    safeDb,
  });
  return {
    app: new Elysia({ prefix: "/operator" }).get(
      "/registrations",
      endpoint.handler,
      endpoint.config,
    ),
    getCallCount,
  };
};

const buildApp = (options: {
  configuredToken: string | undefined;
  rows?: MockRow[];
}) => buildCountedApp(options).app;

const registrationsRequest = (
  params: Record<string, string>,
  headers: Record<string, string> = {},
): Request =>
  new Request(
    `http://localhost/operator/registrations?${new URLSearchParams(params).toString()}`,
    { headers },
  );

describe("GET /operator/registrations", () => {
  test("404 when no token is configured, even with a credential presented", async () => {
    const app = buildApp({ configuredToken: undefined });
    const response = await app.handle(
      registrationsRequest(
        { since: daysAgo(1).toISOString() },
        { authorization: `Bearer ${TOKEN}` },
      ),
    );
    expect(response.status).toBe(404);
  });

  test("404 on an unconfigured deployment even when the query is malformed — schema validation must never run before the token gate", async () => {
    const app = buildApp({ configuredToken: undefined });
    const response = await app.handle(registrationsRequest({}, {}));
    expect(response.status).toBe(404);
  });

  test("401 (not 422) on a wrong token with a malformed query — parameter shape must not leak to unauthenticated probes", async () => {
    const app = buildApp({ configuredToken: TOKEN });
    const response = await app.handle(
      registrationsRequest(
        { since: "not-a-date", limit: "many" },
        { authorization: "Bearer wrong" },
      ),
    );
    expect(response.status).toBe(401);
  });

  test("unknown query parameters on a probe never yield validation errors", async () => {
    const unconfigured = buildApp({ configuredToken: undefined });
    const unconfiguredResponse = await unconfigured.handle(
      registrationsRequest({ probe: "1", admin: "true" }),
    );
    expect(unconfiguredResponse.status).toBe(404);

    const configured = buildApp({ configuredToken: TOKEN });
    const configuredResponse = await configured.handle(
      registrationsRequest({ probe: "1", admin: "true" }),
    );
    expect(configuredResponse.status).toBe(401);
  });

  test("400 when since is missing on an authorized request", async () => {
    const app = buildApp({ configuredToken: TOKEN });
    const response = await app.handle(
      registrationsRequest({}, { authorization: `Bearer ${TOKEN}` }),
    );
    expect(response.status).toBe(400);
  });

  test("401 with the standard error envelope on a wrong token", async () => {
    const app = buildApp({ configuredToken: TOKEN });
    const response = await app.handle(
      registrationsRequest(
        { since: daysAgo(1).toISOString() },
        { authorization: `Bearer ${TOKEN}-wrong` },
      ),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      message: "Invalid operator token",
    });
  });

  test("401 when the credential is missing entirely", async () => {
    const app = buildApp({ configuredToken: TOKEN });
    const response = await app.handle(
      registrationsRequest({ since: daysAgo(1).toISOString() }),
    );
    expect(response.status).toBe(401);
  });

  test("400 when since is older than the lookback window", async () => {
    const app = buildApp({ configuredToken: TOKEN });
    const response = await app.handle(
      registrationsRequest(
        {
          since: daysAgo(
            OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS + 1,
          ).toISOString(),
        },
        { authorization: `Bearer ${TOKEN}` },
      ),
    );
    expect(response.status).toBe(400);
  });

  test("200 with the Page envelope and exactly five item fields on a correct token", async () => {
    const app = buildApp({
      configuredToken: TOKEN,
      rows: [mockRow("op-route-a"), mockRow("op-route-b")],
    });
    const response = await app.handle(
      registrationsRequest(
        { since: daysAgo(1).toISOString(), limit: "2" },
        { authorization: `Bearer ${TOKEN}` },
      ),
    );
    expect(response.status).toBe(200);

    const page = v.parse(pageBodySchema, await response.json());
    expect(page.limit).toBe(2);
    // Two rows for limit 2 means no third row was fetched: last page.
    expect(page.nextCursor).toBeNull();
    expect(page.items.map((item) => item["id"])).toEqual([
      "op-route-a",
      "op-route-b",
    ]);
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual([
        "createdAt",
        "detectedCountry",
        "email",
        "id",
        "name",
      ]);
    }
  });

  // The `no-unscoped-user-query` waiver on the registrations query rests on
  // this: the read spans every account on the instance and has no tenant to
  // scope by, so the token gate is the whole boundary. A gate that runs after
  // the read, or beside it, would still answer 404/401 while the accounts had
  // already been fetched.
  const gatedCases = [
    {
      name: "unconfigured deployment, valid credential and filter",
      configuredToken: undefined,
      headers: { authorization: `Bearer ${TOKEN}` },
      params: { since: daysAgo(1).toISOString() },
      status: 404,
    },
    {
      name: "configured deployment, no credential",
      configuredToken: TOKEN,
      headers: {},
      params: { since: daysAgo(1).toISOString() },
      status: 401,
    },
    {
      name: "configured deployment, wrong credential",
      configuredToken: TOKEN,
      headers: { authorization: `Bearer ${TOKEN}-wrong` },
      params: { since: daysAgo(1).toISOString() },
      status: 401,
    },
    {
      name: "authorized credential, since outside the lookback window",
      configuredToken: TOKEN,
      headers: { authorization: `Bearer ${TOKEN}` },
      params: {
        since: daysAgo(
          OPERATOR_REGISTRATIONS_MAX_LOOKBACK_DAYS + 1,
        ).toISOString(),
      },
      status: 400,
    },
  ];

  for (const gatedCase of gatedCases) {
    test(`${gatedCase.name}: answers ${gatedCase.status} without reading a single account`, async () => {
      const { app, getCallCount } = buildCountedApp({
        configuredToken: gatedCase.configuredToken,
        rows: [mockRow("op-gate-a")],
      });

      const response = await app.handle(
        registrationsRequest(gatedCase.params, gatedCase.headers),
      );

      expect(response.status).toBe(gatedCase.status);
      expect(getCallCount()).toBe(0);
    });
  }

  test("an authorized request reads once, and only once", async () => {
    const { app, getCallCount } = buildCountedApp({
      configuredToken: TOKEN,
      rows: [mockRow("op-gate-a")],
    });

    const response = await app.handle(
      registrationsRequest(
        { since: daysAgo(1).toISOString() },
        { authorization: `Bearer ${TOKEN}` },
      ),
    );

    expect(response.status).toBe(200);
    expect(getCallCount()).toBe(1);
  });

  test("emits a nextCursor when more rows exist than the requested limit", async () => {
    const app = buildApp({
      configuredToken: TOKEN,
      rows: [
        mockRow("op-route-a"),
        mockRow("op-route-b"),
        mockRow("op-route-c"),
      ],
    });
    const response = await app.handle(
      registrationsRequest(
        { since: daysAgo(1).toISOString(), limit: "2" },
        { authorization: `Bearer ${TOKEN}` },
      ),
    );
    expect(response.status).toBe(200);

    const page = v.parse(pageBodySchema, await response.json());
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });
});
