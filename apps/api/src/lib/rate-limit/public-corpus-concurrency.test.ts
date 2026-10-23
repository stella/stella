import { panic } from "better-result";
import { describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { Middleware, RouteTable } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { TimeoutError } from "@/api/lib/errors/tagged-errors";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { getPublicCorpusClassPolicy } from "@/api/public-corpus-policy";
import { serveForTest } from "@/api/tests/helpers/test-server";
import type { TestServer } from "@/api/tests/helpers/test-server";

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

const answering = (body: string) => defineEndpoint.public({}, () => body);

/**
 * Serve `table` on a real `Bun.serve` with the admission stage in front of
 * every route, inside the boundary that answers a handler failure. `before`
 * stages run between the two, where the production pipeline's earlier
 * stages sit.
 */
const serveCapacity = (
  admission: Middleware,
  table: RouteTable,
  before: readonly Middleware[] = [],
): TestServer =>
  serveForTest(
    createHttpApp({
      middleware: [errorBoundary, ...before, admission],
      routes: routes(table),
    }),
  );

/** Marks the one request a test singles out among identical ones. */
const TAG_HEADER = "x-test-tag";
/** Asks `disconnectBeforeAdmission` to hold a request until its client leaves. */
const DISCONNECT_FIRST_HEADER = "x-disconnect-before-admission";

/** Settles once `signal` aborts: on the server, when the client disconnects. */
const abortOf = async (signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return;
  }
  const aborted = Promise.withResolvers<undefined>();
  signal.addEventListener(
    "abort",
    () => {
      aborted.resolve(undefined);
    },
    { once: true },
  );
  await aborted.promise;
};

/** How a client's request ended: answered, or the name of its rejection. */
const outcomeOf = async (response: Promise<Response>): Promise<string> =>
  await response.then(
    () => "answered",
    (error: unknown) =>
      error instanceof DOMException || error instanceof Error
        ? error.name
        : "rejected",
  );

/**
 * A stage ahead of admission that holds a marked request until its client
 * disconnects, as a slow earlier stage would, so the request meets admission
 * already aborted. `served` settles with the answer the server produced,
 * which the departed client never reads.
 */
const disconnectBeforeAdmission = () => {
  const arrived = Promise.withResolvers<undefined>();
  const served = Promise.withResolvers<Response>();
  const stage: Middleware = async (ctx, inner) => {
    if (!ctx.request.headers.has(DISCONNECT_FIRST_HEADER)) {
      return await inner();
    }
    arrived.resolve(undefined);
    await abortOf(ctx.request.signal);
    const response = await inner();
    served.resolve(response);
    return response;
  };
  return { stage, arrived: arrived.promise, served: served.promise };
};

type CapacityJob = {
  readonly tag: string | null;
  readonly finish: () => void;
  readonly fail: (error: unknown) => void;
  /** Settles when the server sees this request's client disconnect. */
  readonly disconnected: Promise<void>;
};

const createCapacityApp = (before: readonly Middleware[] = []) => {
  const observations: Parameters<
    NonNullable<
      NonNullable<Parameters<typeof publicCorpusConcurrencyLimit>[0]>["observe"]
    >
  >[0][] = [];
  const pending: CapacityJob[] = [];
  const jobWaiters: ((job: CapacityJob) => void)[] = [];
  /** The next handler work to start, from a request still to arrive. */
  const nextJob = async (): Promise<CapacityJob> => {
    const started = Promise.withResolvers<CapacityJob>();
    jobWaiters.push(started.resolve);
    return await started.promise;
  };
  /**
   * Settles once `count` handlers have started. Requests travel on their own
   * connections, so a later round trip is no proof that earlier ones arrived.
   */
  const whenPending = async (count: number): Promise<void> => {
    while (pending.length < count) {
      await nextJob();
    }
  };
  const work = async ({ request }: { request: Request }) => {
    if (request.headers.has("x-capacity-probe")) {
      return "probe-started";
    }
    const completion = Promise.withResolvers<string>();
    const job: CapacityJob = {
      tag: request.headers.get(TAG_HEADER),
      finish: () => completion.resolve("done"),
      fail: completion.reject,
      disconnected: abortOf(request.signal),
    };
    pending.push(job);
    jobWaiters.shift()?.(job);
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
  const working = defineEndpoint.public({}, work);
  const server = serveCapacity(
    middleware,
    {
      "/v1/law/statutes/search": { GET: working },
      "/v1/case/decisions": { GET: answering("browse") },
      "/v1/case/decisions/search": { POST: working },
      "/v1/law/statutes/facets": { GET: working },
      "/v1/case/decisions/facets": { GET: working },
      "/v1/case/provisions/citation-counts": { GET: working },
      "/v1/case/provisions/citing-decisions": { GET: working },
      "/v1/law/statutes/resolve": { POST: working },
      "/v1/case/sitemap/shards": { GET: working },
      "/v1/case/sitemap/decisions/shard": { GET: working },
      "/v1/law/sitemap/shards": { GET: working },
      "/v1/law/sitemap/statutes/shard": { GET: working },
      "/v1/law/statutes": { GET: answering("read") },
    },
    before,
  );
  return {
    server,
    observations,
    pending,
    nextJob,
    whenPending,
    [Symbol.asyncDispose]: async () => {
      await server.stop();
    },
  };
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
    await using server = serveCapacity(middleware, {
      "/v1/case/decisions/search": {
        POST: defineEndpoint.public({}, async ({ request: incoming }) =>
          incoming.headers.has("x-capacity-probe")
            ? "probe"
            : await completion.promise,
        ),
      },
      "/v1/law/statutes": { GET: answering("browse") },
    });
    const route = { method: "POST", path: "/v1/case/decisions/search" };
    const running = Array.from(
      { length: getPublicCorpusClassPolicy().classes.search.concurrency },
      async () => server.fetch(request(route)),
    );
    try {
      await server.fetch(request({ method: "GET", path: "/v1/law/statutes" }));
      expect(lines).toEqual([]);
      expect((await server.fetch(probeRequest(route))).status).toBe(429);
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
    await using fixture = createCapacityApp();
    const { server, pending, observations } = fixture;
    const sitemap = { method: "GET", path: "/v1/case/sitemap/shards" };
    const running = Array.from(
      { length: getPublicCorpusClassPolicy().totalConcurrency },
      async () => server.fetch(request(sitemap)),
    );
    try {
      expect(
        (
          await server.fetch(
            request({ method: "GET", path: "/v1/case/decisions" }),
          )
        ).status,
      ).toBe(200);
      await fixture.whenPending(getPublicCorpusClassPolicy().totalConcurrency);
      expect(pending).toHaveLength(
        getPublicCorpusClassPolicy().totalConcurrency,
      );
      for (const route of [...searchPaths, ...aggregatePaths, sitemap]) {
        expect((await server.fetch(probeRequest(route))).status).toBe(429);
      }
      const job = pending.at(0);
      const response = running.at(0);
      if (job === undefined || response === undefined) {
        throw new TypeError("Missing sitemap request");
      }
      job.finish();
      await response;
      running.push(server.fetch(request(searchPaths[0])));
      await fixture.whenPending(
        getPublicCorpusClassPolicy().totalConcurrency + 1,
      );
      expect(
        observations.filter((event) => event.outcome === "acquired"),
      ).toHaveLength(getPublicCorpusClassPolicy().totalConcurrency + 1);
      expect((await server.fetch(probeRequest(aggregatePaths[0]))).status).toBe(
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
    await using fixture = createCapacityApp();
    const { server, pending } = fixture;
    const running = Array.from(
      { length: getPublicCorpusClassPolicy().classes.search.concurrency },
      async () => server.fetch(request(searchPaths[0])),
    );
    try {
      await fixture.whenPending(
        getPublicCorpusClassPolicy().classes.search.concurrency,
      );
      expect((await server.fetch(probeRequest(searchPaths[0]))).status).toBe(
        429,
      );
      running.push(server.fetch(request(aggregatePaths[0])));
      await fixture.whenPending(
        getPublicCorpusClassPolicy().classes.search.concurrency + 1,
      );
      expect(pending).toHaveLength(
        getPublicCorpusClassPolicy().classes.search.concurrency + 1,
      );
      expect((await server.fetch(probeRequest(searchPaths[0]))).status).toBe(
        429,
      );
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
      await using fixture = createCapacityApp();
      const { server, pending, observations } = fixture;
      const capacity =
        getPublicCorpusClassPolicy().classes[routeClass].concurrency;
      const running: Promise<Response>[] = [];
      try {
        for (let index = 0; index < capacity; index += 1) {
          const path = paths.at(index % paths.length);
          if (path === undefined) {
            throw new TypeError("Missing capacity fixture route");
          }
          running.push(server.fetch(request(path)));
        }
        // Browse stays available while the class is full. Every start is
        // awaited, not timed, before the capacity counts as occupied.
        expect(
          (
            await server.fetch(
              request({ method: "GET", path: "/v1/law/statutes" }),
            )
          ).status,
        ).toBe(200);
        await fixture.whenPending(capacity);
        expect(pending).toHaveLength(capacity);
        if (routeClass === "search") {
          const head = await server.fetch(
            probeRequest({ method: "HEAD", path: "/v1/law/statutes/search/" }),
          );
          expect(head.status).toBe(429);
          expect(head.headers.get("retry-after")).toBe("1");
        }
        for (const path of paths) {
          const response = await server.fetch(probeRequest(path));
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
        running.push(server.fetch(request(replacementPath)));
        await fixture.whenPending(capacity + 1);
        expect(pending).toHaveLength(capacity + 1);
        expect((await server.fetch(probeRequest(replacementPath))).status).toBe(
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
      await using fixture = createCapacityApp();
      const { server, pending } = fixture;
      const path = { method: "POST", path: "/v1/case/decisions/search" };
      const running = Array.from(
        { length: getPublicCorpusClassPolicy().classes.search.concurrency },
        async () => server.fetch(request(path)),
      );
      try {
        await fixture.whenPending(
          getPublicCorpusClassPolicy().classes.search.concurrency,
        );
        expect((await server.fetch(probeRequest(path))).status).toBe(429);
        const first = pending.at(0);
        const response = running.at(0);
        if (first === undefined || response === undefined) {
          throw new TypeError("Missing failed request");
        }
        first.fail(failure);
        expect((await response).status).toBeGreaterThanOrEqual(500);
        running.push(server.fetch(request(path)));
        await fixture.whenPending(
          getPublicCorpusClassPolicy().classes.search.concurrency + 1,
        );
        expect(pending).toHaveLength(
          getPublicCorpusClassPolicy().classes.search.concurrency + 1,
        );
        expect((await server.fetch(probeRequest(path))).status).toBe(429);
      } finally {
        for (const job of pending) {
          job.finish();
        }
        await Promise.all(running);
      }
    });
  }

  test("aborted requests keep capacity until handler work settles, then release exactly once", async () => {
    await using fixture = createCapacityApp();
    const { server, pending } = fixture;
    const path = { method: "POST", path: "/v1/case/decisions/search" };
    const browse = { method: "GET", path: "/v1/law/statutes" };
    const capacity = getPublicCorpusClassPolicy().classes.search.concurrency;
    const cancellation = new AbortController();
    const cancelled = outcomeOf(
      server.fetch(
        new Request(request(path, cancellation.signal), {
          headers: { [TAG_HEADER]: "cancelled" },
        }),
      ),
    );
    const running: Promise<Response>[] = [];
    for (let index = 1; index < capacity; index += 1) {
      running.push(server.fetch(request(path)));
    }
    try {
      await fixture.whenPending(capacity);
      expect(pending).toHaveLength(capacity);
      const job = pending.find(({ tag }) => tag === "cancelled");
      if (job === undefined) {
        throw new TypeError("Missing cancelled request");
      }
      cancellation.abort();
      expect(await cancelled).toBe("AbortError");
      // The server sees the disconnect while the handler is still working,
      // and the slot stays held.
      await job.disconnected;
      expect((await server.fetch(probeRequest(path))).status).toBe(429);
      job.finish();
      // A round trip after the work settled: its lease is back by then.
      await server.fetch(request(browse));
      running.push(server.fetch(request(path)));
      await fixture.whenPending(capacity + 1);
      expect(pending).toHaveLength(capacity + 1);
      // Released exactly once: the replacement took the only free slot.
      expect((await server.fetch(probeRequest(path))).status).toBe(429);
    } finally {
      for (const job of pending) {
        job.finish();
      }
      await Promise.all(running);
    }
  });

  test("a request whose client left before admission is refused without acquiring a lease", async () => {
    const disconnect = disconnectBeforeAdmission();
    await using fixture = createCapacityApp([disconnect.stage]);
    const { server, pending, observations } = fixture;
    const cancellation = new AbortController();
    const sent = outcomeOf(
      server.fetch(
        new Request(request(searchPaths[0], cancellation.signal), {
          headers: { "x-capacity-probe": "1", [DISCONNECT_FIRST_HEADER]: "1" },
        }),
      ),
    );
    await disconnect.arrived;
    cancellation.abort();
    expect(await sent).toBe("AbortError");
    const response = await disconnect.served;
    expect(response.status).toBe(429);
    expect(pending).toEqual([]);
    expect(observations).toEqual([{ class: "search", outcome: "refused" }]);
    // No lease was taken or returned: the full capacity is still free.
    const capacity = getPublicCorpusClassPolicy().classes.search.concurrency;
    const running = Array.from(
      { length: capacity },
      async () => await server.fetch(request(searchPaths[0])),
    );
    try {
      await fixture.whenPending(capacity);
      expect(pending).toHaveLength(capacity);
      expect((await server.fetch(probeRequest(searchPaths[0]))).status).toBe(
        429,
      );
    } finally {
      for (const job of pending) {
        job.finish();
      }
      await Promise.all(running);
    }
  });

  test("one page's search and facets wait for each other instead of refusing", async () => {
    const pending: { path: string; finish: () => void }[] = [];
    const work = async ({ request: incoming }: { request: Request }) => {
      const completion = Promise.withResolvers<string>();
      pending.push({
        path: new URL(incoming.url).pathname,
        finish: () => completion.resolve("done"),
      });
      return await completion.promise;
    };
    // Production shape: one slot per task, so the facets must wait.
    expect(getPublicCorpusClassPolicy().totalConcurrency).toBe(1);
    // Production defaults: one page's requests come from one address.
    await using server = serveCapacity(publicCorpusConcurrencyLimit(), {
      "/v1/case/decisions/search": { POST: defineEndpoint.public({}, work) },
      "/v1/case/decisions/facets": { GET: defineEndpoint.public({}, work) },
    });
    // Either may reach the server first; the other waits for its slot.
    const answers = new Map<string, Promise<Response>>([
      [searchPaths[1].path, server.fetch(request(searchPaths[1]))],
      [aggregatePaths[1].path, server.fetch(request(aggregatePaths[1]))],
    ]);
    await Bun.sleep(10);
    expect(pending).toHaveLength(1);
    const first = pending.at(0);
    if (first === undefined) {
      throw new TypeError("Missing admitted request");
    }
    first.finish();
    expect((await answers.get(first.path))?.status).toBe(200);
    await Bun.sleep(10);
    expect(pending).toHaveLength(2);
    const second = pending.at(1);
    if (second === undefined) {
      throw new TypeError("Missing waiting request");
    }
    expect(new Set([first.path, second.path])).toEqual(new Set(answers.keys()));
    second.finish();
    expect((await answers.get(second.path))?.status).toBe(200);
  });

  test("the validated development switch skips capacity admission", async () => {
    const previous = env.E2E_DISABLE_AUTH_RATE_LIMIT;
    const disconnect = disconnectBeforeAdmission();
    await using fixture = createCapacityApp([disconnect.stage]);
    const { server, observations, nextJob } = fixture;
    env.E2E_DISABLE_AUTH_RATE_LIMIT = true;
    try {
      expect(
        (
          await server.fetch(
            request({ method: "GET", path: "/v1/law/statutes" }),
          )
        ).status,
      ).toBe(200);
      // An aborted request, which admission would refuse, still runs.
      const cancellation = new AbortController();
      const sent = outcomeOf(
        server.fetch(
          new Request(request(searchPaths[0], cancellation.signal), {
            headers: { [DISCONNECT_FIRST_HEADER]: "1" },
          }),
        ),
      );
      const started = nextJob();
      await disconnect.arrived;
      cancellation.abort();
      expect(await sent).toBe("AbortError");
      // The bypass still executes ordinary handler work.
      const job = await started;
      job.finish();
      expect((await disconnect.served).status).toBe(200);
      expect(observations).toEqual([]);
    } finally {
      env.E2E_DISABLE_AUTH_RATE_LIMIT = previous;
    }
  });
});
