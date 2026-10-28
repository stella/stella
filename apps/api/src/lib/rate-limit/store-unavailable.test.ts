import { RedisClient } from "bun";
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { LIMITER_STORE_UNAVAILABLE } from "@stll/api-contract/action-admission";
import { rejectionOf } from "@stll/property-testing/rejection";

import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

import {
  createPublicCorpusAddressRateLimitOptions,
  createPublicSanctionsRateLimitOptions,
} from "./public-corpus-rate-limits";
import { rateLimit } from "./rate-limit";
import { RedisRateLimitContext } from "./redis-context";
import { LimiterStoreUnavailableError } from "./store-unavailable";

const failureSources = {
  connect: () => ({
    connect: async () => {
      throw new TypeError("Unavailable");
    },
    send: async () => [1, 1000],
  }),
  command: () => ({
    send: async () => {
      throw new TypeError("Unavailable");
    },
  }),
  reply: () => ({ send: async () => ["invalid"] }),
  coercedReply: () => ({ send: async () => [true, null] }),
  fractionalReply: () => ({ send: async () => [1.5, 1000] }),
  timeout: () => ({
    send: async () =>
      await new Promise<never>(() => {
        /* The command remains pending until its deadline. */
      }),
  }),
};

test.each(Object.entries(failureSources))(
  "%s failure refuses reads and writes as store unavailable",
  async (_source, createRedis) => {
    for (const operation of ["increment", "read"] as const) {
      const context = new RedisRateLimitContext({
        failurePolicy: "fail_closed",
        createRedis,
        commandTimeoutMs: 5,
        onRedisError: () => undefined,
      });
      try {
        expect(await rejectionOf(context[operation]("counter"))).toBeInstanceOf(
          LimiterStoreUnavailableError,
        );
      } finally {
        context.kill();
      }
    }
  },
);

test.each([
  { surface: "sanctions", failurePolicy: "fail_closed" },
  { surface: "public-corpus", failurePolicy: "fail_closed" },
  { surface: "public-corpus", failurePolicy: "fail_open_local" },
] as const)(
  "an unreachable Valkey preserves the $surface $failurePolicy response",
  async ({ surface, failurePolicy }) => {
    const context = new RedisRateLimitContext({
      failurePolicy,
      commandTimeoutMs: 100,
      createRedis: () =>
        new RedisClient("redis://127.0.0.1:1", {
          enableOfflineQueue: false,
          connectionTimeout: 100,
          maxRetries: 0,
        }),
      onRedisError: () => undefined,
    });
    const options =
      surface === "sanctions"
        ? createPublicSanctionsRateLimitOptions()
        : {
            ...createPublicCorpusAddressRateLimitOptions("search"),
            skip: () => false,
          };
    await options.context.kill();
    let handled = 0;
    await using server = serveForTest(
      createHttpApp({
        middleware: [errorBoundary, rateLimit({ ...options, context })],
        routes: routes({
          "/search": {
            POST: defineEndpoint.public({}, () => {
              handled += 1;
              return "ok";
            }),
          },
        }),
      }),
    );
    try {
      const response = await server.fetch("http://localhost/search", {
        method: "POST",
      });
      if (failurePolicy === "fail_open_local") {
        expect(response.status).toBe(200);
        expect(await response.text()).toBe("ok");
        expect(handled).toBe(1);
        return;
      }
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        code: LIMITER_STORE_UNAVAILABLE.code,
        message: LIMITER_STORE_UNAVAILABLE.message,
        hint: LIMITER_STORE_UNAVAILABLE.hint,
        retryable: true,
      });
      expect(response.headers.get("RateLimit-Remaining")).toBeNull();
      expect(handled).toBe(0);
    } finally {
      context.kill();
    }
  },
);

const FAIL_CLOSED_OWNERS = [
  "handlers/legal-resolve/routes.ts",
  "lib/auth/mcp-web-handoff-service.ts",
  "lib/rate-limit/public-corpus-rate-limits.ts",
  "lib/rate-limit/synthetic-session-budget.ts",
];

const closedOwners = (sources: ReadonlyMap<string, string>) =>
  [...sources]
    .flatMap(([path, source]) =>
      [...source.matchAll(/failurePolicy:\s*"fail_closed"/gu)].map(() => path),
    )
    .toSorted();

test("every fail-closed counter is owned by the shared unavailable outcome", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sources = new Map<string, string>();
  for await (const path of new Bun.Glob("**/*.ts").scan(root)) {
    if (path.endsWith(".test.ts")) {
      continue;
    }
    sources.set(path, await readFile(`${root}/${path}`, "utf-8"));
  }
  expect(closedOwners(sources)).toEqual(FAIL_CLOSED_OWNERS);
  const mutated = new Map(sources);
  mutated.set("new-limiter.ts", 'failurePolicy: "fail_closed"');
  expect(closedOwners(mutated)).not.toEqual(FAIL_CLOSED_OWNERS);
  const duplicated = new Map(sources);
  const existingOwner = "lib/rate-limit/public-corpus-rate-limits.ts";
  duplicated.set(
    existingOwner,
    `${sources.get(existingOwner)}\nfailurePolicy: "fail_closed"`,
  );
  expect(closedOwners(duplicated)).not.toEqual(FAIL_CLOSED_OWNERS);
  expect(
    [...sources]
      .filter(
        ([path, source]) =>
          path !== "lib/admission-redis.ts" &&
          /\b(createAdmissionRedis|sendAdmissionRedisCommand)\b/u.test(source),
      )
      .map(([path]) => path)
      .toSorted(),
  ).toEqual([
    "handlers/case-law/ingestion/adapters/publisher-request-gate.ts",
    "lib/rate-limit/action-admission.ts",
    "lib/rate-limit/mcp-read-fence.ts",
  ]);
  expect(sources.get("lib/non-evicting-redis.ts")).toContain(
    'reason: "store_unavailable"',
  );
  const owner = sources.get("lib/rate-limit/redis-context.ts");
  expect(owner).toContain("LimiterStoreUnavailableError");
  expect(owner).not.toContain("FAIL_CLOSED_COUNT");
});
