import { panic } from "better-result";
import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { env } from "@/api/env";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { getPublicCorpusClassPolicy } from "@/api/public-corpus-policy";

import { publicCorpusConcurrencyLimit } from "./public-corpus-concurrency";

const searchPaths = [
  { method: "GET", path: "/v1/law/statutes/search" },
  { method: "POST", path: "/v1/case/decisions/search" },
] as const;
const aggregatePaths = [
  { method: "GET", path: "/v1/law/statutes/facets" },
  { method: "GET", path: "/v1/case/decisions/facets" },
  { method: "GET", path: "/v1/case/provisions/citation-counts" },
  { method: "GET", path: "/v1/case/provisions/citing-decisions" },
  { method: "POST", path: "/v1/law/statutes/resolve" },
] as const;

const createCapacityApp = () => {
  const observations: Parameters<
    NonNullable<
      NonNullable<Parameters<typeof publicCorpusConcurrencyLimit>[0]>["observe"]
    >
  >[0][] = [];
  const pending: { finish: () => void; fail: (error: unknown) => void }[] = [];
  const work = async ({ request }: { request: Request }) => {
    if (request.headers.has("x-capacity-probe")) {
      return "probe-started";
    }
    const completion = Promise.withResolvers<string>();
    pending.push({
      finish: () => completion.resolve("done"),
      fail: completion.reject,
    });
    return completion.promise;
  };
  // Capacity cases: refuse at once, each request its own client.
  const middleware = publicCorpusConcurrencyLimit({
    observe: (event) => {
      observations.push(event);
    },
    waitMsOf: () => 0,
    clientOf: () => Bun.randomUUIDv7(),
  });
  const app = new Elysia()
    .use(middleware)
    .get("/v1/law/statutes/search", work)
    .get("/v1/case/decisions", () => "browse")
    .post("/v1/case/decisions/search", work)
    .get("/v1/law/statutes/facets", work)
    .get("/v1/case/decisions/facets", work)
    .get("/v1/case/provisions/citation-counts", work)
    .get("/v1/case/provisions/citing-decisions", work)
    .post("/v1/law/statutes/resolve", work)
    .get("/v1/case/sitemap/shards", work)
    .get("/v1/case/sitemap/decisions/shard", work)
    .get("/v1/law/sitemap/shards", work)
    .get("/v1/law/sitemap/statutes/shard", work)
    .get("/v1/law/statutes", () => "read");
  return { app, observations, pending };
};

const request = (
  { path, method }: { path: string; method: string },
  signal?: AbortSignal,
) =>
  new Request(`http://localhost${path}`, {
    method,
    ...(signal === undefined ? {} : { signal }),
  });

const probeRequest = (route: { path: string; method: string }) =>
  new Request(request(route), { headers: { "x-capacity-probe": "1" } });

describe("public corpus active request capacity", () => {
  test("capacity telemetry emits refusals while accepted requests emit no metric lines", async () => {
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    const completion = Promise.withResolvers<string>();
    const middleware = publicCorpusConcurrencyLimit({
      waitMsOf: () => 0,
      clientOf: () => Bun.randomUUIDv7(),
    });
    const app = new Elysia()
      .use(middleware)
      .post("/v1/case/decisions/search", async ({ request: incoming }) =>
        incoming.headers.has("x-capacity-probe") ? "probe" : completion.promise,
      )
      .get("/v1/law/statutes", () => "browse");
    const route = { method: "POST", path: "/v1/case/decisions/search" };
    const running = Array.from(
      { length: getPublicCorpusClassPolicy().classes.search.concurrency },
      async () => app.handle(request(route)),
    );
    try {
      await app.handle(request({ method: "GET", path: "/v1/law/statutes" }));
      expect(lines).toEqual([]);
      expect((await app.handle(probeRequest(route))).status).toBe(429);
      expect(lines).toHaveLength(1);
      const line = lines.at(0);
      if (line === undefined) {
        panic("Capacity refusal must emit a metric line");
      }
      expect(JSON.parse(line)).toMatchObject({
        class: "search",
        outcome: "refused",
        PublicCorpusAdmissions: 1,
      });
    } finally {
      completion.resolve("done");
      await Promise.all(running);
      resetMetricLineSinkForTesting();
    }
  });
  test("search, aggregate and sitemap work share one total capacity while browse remains available", async () => {
    const { app, pending, observations } = createCapacityApp();
    const sitemap = { method: "GET", path: "/v1/case/sitemap/shards" };
    const running = Array.from(
      { length: getPublicCorpusClassPolicy().totalConcurrency },
      async () => app.handle(request(sitemap)),
    );
    try {
      expect(
        (
          await app.handle(
            request({ method: "GET", path: "/v1/case/decisions" }),
          )
        ).status,
      ).toBe(200);
      expect(pending).toHaveLength(
        getPublicCorpusClassPolicy().totalConcurrency,
      );
      for (const route of [...searchPaths, ...aggregatePaths, sitemap]) {
        expect((await app.handle(probeRequest(route))).status).toBe(429);
      }
      const job = pending.at(0);
      const response = running.at(0);
      if (job === undefined || response === undefined) {
        throw new TypeError("Missing sitemap request");
      }
      job.finish();
      await response;
      running.push(app.handle(request(searchPaths[0])));
      await app.handle(request({ method: "GET", path: "/v1/law/statutes" }));
      expect(
        observations.filter((event) => event.outcome === "acquired"),
      ).toHaveLength(getPublicCorpusClassPolicy().totalConcurrency + 1);
      expect((await app.handle(probeRequest(aggregatePaths[0]))).status).toBe(
        429,
      );
    } finally {
      for (const job of pending) {
        job.finish();
      }
      await Promise.all(running);
    }
  });

  test("dedicated-pool search and aggregate retain independent class ceilings below the total cap", async () => {
    const previous = env.PUBLIC_LAW_DATABASE_URL;
    env.PUBLIC_LAW_DATABASE_URL =
      "postgres://readonly:password@localhost/corpus";
    const { app, pending } = createCapacityApp();
    const running = Array.from(
      { length: getPublicCorpusClassPolicy().classes.search.concurrency },
      async () => app.handle(request(searchPaths[0])),
    );
    try {
      await app.handle(request({ method: "GET", path: "/v1/law/statutes" }));
      expect((await app.handle(probeRequest(searchPaths[0]))).status).toBe(429);
      running.push(app.handle(request(aggregatePaths[0])));
      await app.handle(request({ method: "GET", path: "/v1/law/statutes" }));
      expect(pending).toHaveLength(
        getPublicCorpusClassPolicy().classes.search.concurrency + 1,
      );
      expect((await app.handle(probeRequest(searchPaths[0]))).status).toBe(429);
    } finally {
      for (const job of pending) {
        job.finish();
      }
      await Promise.all(running);
      env.PUBLIC_LAW_DATABASE_URL = previous;
    }
  });
  for (const [routeClass, paths] of [
    ["search", searchPaths],
    ["aggregate", aggregatePaths],
  ] as const) {
    test(`${routeClass} shares its process capacity across routes and refuses without starting work`, async () => {
      const { app, pending, observations } = createCapacityApp();
      const capacity =
        getPublicCorpusClassPolicy().classes[routeClass].concurrency;
      const running: Promise<Response>[] = [];
      try {
        for (let index = 0; index < capacity; index += 1) {
          const path = paths.at(index % paths.length);
          if (path === undefined) {
            throw new TypeError("Missing capacity fixture route");
          }
          running.push(app.handle(request(path)));
        }
        // A completed browse request crosses the same pipeline after all starts, without
        // depending on timers to decide whether the capacity is occupied.
        expect(
          (
            await app.handle(
              request({ method: "GET", path: "/v1/law/statutes" }),
            )
          ).status,
        ).toBe(200);
        expect(pending).toHaveLength(capacity);
        if (routeClass === "search") {
          const head = await app.handle(
            probeRequest({ method: "HEAD", path: "/v1/law/statutes/search/" }),
          );
          expect(head.status).toBe(429);
          expect(head.headers.get("retry-after")).toBe("1");
        }
        for (const path of paths) {
          const response = await app.handle(probeRequest(path));
          expect(response.status).toBe(429);
          expect(response.headers.get("retry-after")).toBe("1");
          expect(await response.text()).toBe("rate-limit reached");
          expect(pending).toHaveLength(capacity);
        }
        expect(
          observations.filter((event) => event.outcome === "acquired"),
        ).toHaveLength(capacity);
        expect(
          observations.filter((event) => event.outcome === "refused"),
        ).toHaveLength(paths.length + (routeClass === "search" ? 1 : 0));
        const first = pending.at(0);
        if (first === undefined) {
          throw new TypeError("Missing active request");
        }
        first.finish();
        const firstResponse = running.at(0);
        if (firstResponse === undefined) {
          throw new TypeError("Missing active response");
        }
        expect((await firstResponse).status).toBe(200);
        const replacementPath = paths.at(0);
        if (replacementPath === undefined) {
          throw new TypeError("Missing replacement route");
        }
        running.push(app.handle(request(replacementPath)));
        await app.handle(request({ method: "GET", path: "/v1/law/statutes" }));
        expect(pending).toHaveLength(capacity + 1);
        expect((await app.handle(probeRequest(replacementPath))).status).toBe(
          429,
        );
      } finally {
        for (const job of pending) {
          job.finish();
        }
        await Promise.all(running);
      }
    });
  }

  for (const failure of [
    new TypeError("handler failed"),
    new TimeoutError({
      message: "query timed out",
      label: "public-corpus-query",
    }),
  ]) {
    test(`releases failed handler work after ${failure.name}`, async () => {
      const { app, pending } = createCapacityApp();
      const path = { method: "POST", path: "/v1/case/decisions/search" };
      const running = Array.from(
        { length: getPublicCorpusClassPolicy().classes.search.concurrency },
        async () => app.handle(request(path)),
      );
      try {
        await app.handle(request({ method: "GET", path: "/v1/law/statutes" }));
        expect((await app.handle(probeRequest(path))).status).toBe(429);
        const first = pending.at(0);
        const response = running.at(0);
        if (first === undefined || response === undefined) {
          throw new TypeError("Missing failed request");
        }
        first.fail(failure);
        expect((await response).status).toBeGreaterThanOrEqual(500);
        running.push(app.handle(request(path)));
        await app.handle(request({ method: "GET", path: "/v1/law/statutes" }));
        expect(pending).toHaveLength(
          getPublicCorpusClassPolicy().classes.search.concurrency + 1,
        );
        expect((await app.handle(probeRequest(path))).status).toBe(429);
      } finally {
        for (const job of pending) {
          job.finish();
        }
        await Promise.all(running);
      }
    });
  }

  test("aborted requests keep capacity until handler work settles, then release exactly once", async () => {
    const { app, pending } = createCapacityApp();
    const path = { method: "POST", path: "/v1/case/decisions/search" };
    const cancellation = new AbortController();
    const running = [app.handle(request(path, cancellation.signal))];
    for (
      let index = 1;
      index < getPublicCorpusClassPolicy().classes.search.concurrency;
      index += 1
    ) {
      running.push(app.handle(request(path)));
    }
    try {
      await app.handle(request({ method: "GET", path: "/v1/law/statutes" }));
      cancellation.abort();
      expect((await app.handle(probeRequest(path))).status).toBe(429);
      const first = pending.at(0);
      const firstResponse = running.at(0);
      if (first === undefined || firstResponse === undefined) {
        throw new TypeError("Missing cancelled request");
      }
      first.finish();
      await firstResponse;
      running.push(app.handle(request(path)));
      await app.handle(request({ method: "GET", path: "/v1/law/statutes" }));
      expect(pending).toHaveLength(
        getPublicCorpusClassPolicy().classes.search.concurrency + 1,
      );
      expect((await app.handle(probeRequest(path))).status).toBe(429);
    } finally {
      for (const job of pending) {
        job.finish();
      }
      await Promise.all(running);
    }
  });

  test("already aborted requests refuse without acquiring or releasing another lease", async () => {
    const { app, pending, observations } = createCapacityApp();
    const cancellation = new AbortController();
    cancellation.abort();
    const response = await app.handle(
      new Request(request(searchPaths[0], cancellation.signal), {
        headers: { "x-capacity-probe": "1" },
      }),
    );
    expect(response.status).toBe(429);
    expect(pending).toEqual([]);
    expect(observations).toEqual([{ class: "search", outcome: "refused" }]);
  });

  test("one page's search and facets wait for each other instead of refusing", async () => {
    const pending: (() => void)[] = [];
    const work = async () => {
      const completion = Promise.withResolvers<string>();
      pending.push(() => completion.resolve("done"));
      return await completion.promise;
    };
    // Production shape: one slot per task, so the facets must wait.
    expect(getPublicCorpusClassPolicy().totalConcurrency).toBe(1);
    // Production defaults: requests without an address share one client.
    const app = new Elysia()
      .use(publicCorpusConcurrencyLimit())
      .post("/v1/case/decisions/search", work)
      .get("/v1/case/decisions/facets", work);
    const search = app.handle(request(searchPaths[1]));
    const facets = app.handle(request(aggregatePaths[1]));
    await Bun.sleep(10);
    expect(pending).toHaveLength(1);
    pending[0]?.();
    expect((await search).status).toBe(200);
    await Bun.sleep(10);
    expect(pending).toHaveLength(2);
    pending[1]?.();
    expect((await facets).status).toBe(200);
  });

  test("the validated development switch skips capacity admission", async () => {
    const previous = env.E2E_DISABLE_AUTH_RATE_LIMIT;
    const { app, observations, pending } = createCapacityApp();
    env.E2E_DISABLE_AUTH_RATE_LIMIT = true;
    try {
      expect(
        (await app.handle(request({ method: "GET", path: "/v1/law/statutes" })))
          .status,
      ).toBe(200);
      const cancellation = new AbortController();
      cancellation.abort();
      const response = app.handle(request(searchPaths[0], cancellation.signal));
      // The bypass still executes ordinary handler work.
      await app.handle(request({ method: "GET", path: "/v1/law/statutes" }));
      expect(observations).toEqual([]);
      for (const job of pending) {
        job.finish();
      }
      expect((await response).status).toBe(200);
    } finally {
      env.E2E_DISABLE_AUTH_RATE_LIMIT = previous;
    }
  });
});
