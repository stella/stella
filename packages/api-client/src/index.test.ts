import { afterAll, describe, expect, expectTypeOf, test } from "bun:test";

import { rejectionOf } from "@stll/property-testing/rejection";

import { createApiClient } from "./index";
import type { ApiClientOptions, ScopedResponse } from "./index";

type Echo = {
  readonly method: string;
  readonly path: string;
  readonly query: [string, string][];
  readonly contentType: string | null;
  readonly headers: Record<string, string>;
  readonly body: unknown;
};

type ItemRoute = {
  body: unknown;
  params: unknown;
  query: unknown;
  headers: unknown;
  response: { 200: Echo; 404: { readonly message: string } };
};

/** A route answering `TOk`, and `TRefusals` by status. */
type AnswerRoute<TOk, TRefusals = Record<never, never>> = {
  body: unknown;
  params: unknown;
  query: unknown;
  headers: unknown;
  response: { 200: TOk } & TRefusals;
};

type TestRoutes = {
  v1: {
    items: {
      get: {
        body: unknown;
        params: unknown;
        query: { limit?: number; tags?: string[]; archived?: boolean };
        headers: unknown;
        response: { 200: Echo };
      };
      post: {
        body: { name: string; count?: number };
        params: unknown;
        query: unknown;
        headers: unknown;
        response: { 200: Echo; 422: { readonly message: string } };
      };
      special: { patch: ItemRoute };
      ":itemId": {
        get: ItemRoute;
        patch: ItemRoute;
        delete: ItemRoute;
        versions: { ":version": { get: ItemRoute } };
      };
    };
    uploads: {
      post: {
        body: { file: File; label: string; size: number; meta: { a: number } };
        params: unknown;
        query: unknown;
        headers: unknown;
        response: { 200: Echo };
      };
    };
    answers: {
      json: { get: AnswerRoute<{ items: number[] }> };
      text: { get: AnswerRoute<string> };
      bytes: { get: AnswerRoute<ArrayBuffer> };
      image: { get: AnswerRoute<Blob> };
      empty: { delete: AnswerRoute<undefined> };
      events: { get: AnswerRoute<ReadableStream> };
      refused: {
        get: AnswerRoute<Echo, { 404: { code: string; message: string } }>;
      };
      broken: { get: AnswerRoute<Echo> };
      "broken-refusal": { get: AnswerRoute<Echo, { 503: string }> };
    };
    me: {
      delete: { "pending-tasks": { get: ItemRoute } };
    };
    filter: {
      get: {
        body: unknown;
        params: unknown;
        query: { status: "open" | "closed" };
        headers: unknown;
        response: { 200: Echo };
      };
    };
  };
};

const readBody = async (request: Request): Promise<unknown> => {
  const type = request.headers.get("content-type") ?? "";
  if (type.startsWith("multipart/form-data")) {
    const fields: [string, unknown][] = [];
    for (const [name, value] of (await request.formData()).entries()) {
      const entry: unknown = value;
      fields.push([
        name,
        entry instanceof File
          ? { file: entry.name, text: await entry.text() }
          : entry,
      ]);
    }
    return fields;
  }
  if (type.startsWith("application/json")) {
    const text = await request.text();
    return text === "" ? undefined : JSON.parse(text);
  }
  const text = await request.text();
  return text === "" ? undefined : text;
};

const echo = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const answer: Echo = {
    method: request.method,
    path: url.pathname,
    query: [...url.searchParams.entries()],
    contentType: request.headers.get("content-type"),
    headers: Object.fromEntries(request.headers.entries()),
    body: await readBody(request),
  };
  return Response.json(answer);
};

const server = Bun.serve({
  port: 0,
  routes: {
    "/v1/answers/json": () => Response.json({ items: [1, 2] }),
    "/v1/answers/text": () => new Response("plain answer"),
    "/v1/answers/bytes": () =>
      new Response(new Uint8Array([1, 2, 3]), {
        headers: { "content-type": "application/octet-stream" },
      }),
    "/v1/answers/image": () =>
      new Response(new Uint8Array([137, 80, 78, 71]), {
        headers: { "content-type": "image/png" },
      }),
    "/v1/answers/empty": () => new Response(null, { status: 204 }),
    "/v1/answers/events": () =>
      new Response("data: one\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    "/v1/answers/refused": () =>
      Response.json(
        { code: "not_found", message: "Missing" },
        { status: 404, headers: { "x-receipt-id": "receipt-1" } },
      ),
    "/v1/answers/broken": () =>
      new Response("{", { headers: { "content-type": "application/json" } }),
    "/v1/answers/broken-refusal": () =>
      new Response("Invalid JSON", {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  },
  fetch: echo,
});

afterAll(async () => {
  await server.stop(true);
});

const origin = server.url.href;

const client = (options?: ApiClientOptions) =>
  createApiClient<TestRoutes>(origin, options).v1;

describe("createApiClient", () => {
  test("walks segments and path parameters to the request path", async () => {
    const api = client();

    const item = await api.items({ itemId: "a b/c" }).get();
    const version = await api
      .items({ itemId: 7 })
      .versions({ version: 2 })
      .get();

    expect(item.data?.path).toBe("/v1/items/a%20b%2Fc");
    expect(item.data?.method).toBe("GET");
    expect(version.data?.path).toBe("/v1/items/7/versions/2");
  });

  test("sends a segment named like a method as a segment", async () => {
    const { data } = await client().me.delete["pending-tasks"].get();

    expect(data?.path).toBe("/v1/me/delete/pending-tasks");
    expect(data?.method).toBe("GET");
  });

  test("sends each method with its body", async () => {
    const api = client();

    const patched = await api.items({ itemId: 1 }).patch({ pinned: true });
    const removed = await api.items({ itemId: 1 }).delete();

    expect(patched.data).toMatchObject({
      method: "PATCH",
      contentType: "application/json",
      body: { pinned: true },
    });
    // An empty body echoes as no `body` key: JSON has no `undefined`.
    expect(removed.data).toMatchObject({ method: "DELETE" });
    expect(removed.data?.body).toBeUndefined();
  });

  test("writes query values the way the API reads them back", async () => {
    const { data } = await client().items.get({
      query: { limit: 50, tags: ["a", "b"], archived: false },
    });

    expect(data?.query).toEqual([
      ["limit", "50"],
      ["tags", "a"],
      ["tags", "b"],
      ["archived", "false"],
    ]);
  });

  test("sends a JSON body, and a string body as text", async () => {
    const api = client();

    const json = await api.items.post({ name: "Draft", count: 2 });
    const text = await createApiClient<{
      feedback: {
        post: {
          body: unknown;
          params: unknown;
          query: unknown;
          headers: unknown;
          response: { 200: Echo };
        };
      };
    }>(origin).feedback.post(JSON.stringify({ rating: 5 }));

    expect(json.data).toMatchObject({
      contentType: "application/json",
      body: { name: "Draft", count: 2 },
    });
    expect(text.data?.contentType).toBe("text/plain;charset=utf-8");
    expect(text.data?.body).toBe('{"rating":5}');
  });

  test("sends a body carrying a file as a multipart form of wire values", async () => {
    const file = new File(["contract text"], "contract.txt", {
      type: "text/plain",
    });

    const { data } = await client().uploads.post({
      file,
      label: "Signed",
      size: 12,
      meta: { a: 1 },
    });

    expect(data?.contentType).toStartWith("multipart/form-data");
    expect(data?.body).toEqual([
      ["file", { file: "contract.txt", text: "contract text" }],
      ["label", "Signed"],
      ["size", "12"],
      ["meta", '{"a":1}'],
    ]);
  });

  test("includes credentials by default and keeps the caller's fetch settings", async () => {
    const seen: RequestInit[] = [];
    const recording = (options: ApiClientOptions["fetch"]) =>
      client({
        ...(options === undefined ? {} : { fetch: options }),
        fetcher: async (url, init) => {
          seen.push(init);
          return await fetch(url, init);
        },
      });

    await recording(undefined).items.get();
    await recording({ cache: "no-store", credentials: "omit" }).items.get();
    await recording(undefined).items.get({
      fetch: { credentials: "same-origin" },
    });

    expect(seen.map((init) => init.credentials)).toEqual([
      "include",
      "omit",
      "same-origin",
    ]);
    expect(seen.at(1)?.cache).toBe("no-store");
  });

  test("computes client headers per request; request headers win", async () => {
    let session = "first";
    const api = client({
      headers: () => ({ "x-session": session, "x-client": "web" }),
    });

    const first = await api.items.get();
    session = "second";
    const second = await api.items.get({ headers: { "x-client": "override" } });

    expect(first.data?.headers["x-session"]).toBe("first");
    expect(second.data?.headers["x-session"]).toBe("second");
    expect(second.data?.headers["x-client"]).toBe("override");
  });

  test("runs the request and response hooks around each request", async () => {
    const calls: string[] = [];
    const api = client({
      onRequest: (path, init) => {
        calls.push(`request ${String(init.method)} ${path}`);
      },
      onResponse: async (response) => {
        calls.push(`response ${String(response.status)}`);
        // The hook reads a copy; the client still decodes the original.
        await response.clone().text();
      },
    });

    const { data } = await api.answers.json.get();

    expect(calls).toEqual(["request GET /v1/answers/json", "response 200"]);
    expect(data).toEqual({ items: [1, 2] });
  });

  test("decodes each answer by its content type", async () => {
    const api = client();

    const text = await api.answers.text.get();
    const bytes = await api.answers.bytes.get();
    const image = await api.answers.image.get();
    const empty = await api.answers.empty.delete();
    const events = await api.answers.events.get();

    expect(text.data).toBe("plain answer");
    expect(bytes.data).toBeInstanceOf(ArrayBuffer);
    expect(image.data).toBeInstanceOf(Blob);
    expect(image.data instanceof Blob ? image.data.type : "").toBe("image/png");
    expect(empty).toMatchObject({ data: undefined, error: null, status: 204 });
    expect(events.data).toBeInstanceOf(ReadableStream);
  });

  test("returns a refusal with its status, body and headers", async () => {
    const result = await client().answers.refused.get();

    expect(result.data).toBeNull();
    expect(result.status).toBe(404);
    expect(result.error).toEqual({
      status: 404,
      value: { code: "not_found", message: "Missing" },
    });
    expect(result.headers.get("x-receipt-id")).toBe("receipt-1");
    expect(result.response.status).toBe(404);
  });

  test("keeps a refusal's malformed JSON as text and refuses a malformed success", async () => {
    const api = client();

    const refusal = await api.answers["broken-refusal"].get();

    expect(refusal.error).toEqual({ status: 503, value: "Invalid JSON" });
    expect(String(await rejectionOf(api.answers.broken.get()))).toContain(
      "malformed JSON",
    );
  });

  test("a client node is never mistaken for a promise", async () => {
    const node = await Promise.resolve(client().items);

    expect(typeof node).toBe("function");
  });

  test("types follow the route tree", () => {
    const api = client();

    // Type-only: bun's `expectTypeOf` checks at compile time, so the
    // assertions name types rather than walking a value's runtime chain.
    expectTypeOf<Parameters<typeof api.items.post>[0]>().toEqualTypeOf<{
      name: string;
      count?: number;
    }>();
    expectTypeOf<Parameters<typeof api.filter.get>[0]>().toExtend<{
      readonly query: { status: "open" | "closed" };
    }>();
    expectTypeOf<
      Awaited<ReturnType<ReturnType<typeof api.items>["get"]>>["error"]
    >().toEqualTypeOf<{
      readonly status: 404;
      readonly value: { readonly message: string };
    } | null>();
  });
});

const jsonResponse = () =>
  new Response(JSON.stringify({ items: [1] }), {
    headers: { "content-type": "application/json" },
  });

const testFetcher = (
  handler: (
    input: Parameters<typeof fetch>[0],
    init: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch => Object.assign(handler, { preconnect: () => undefined });

class CloneTrackedResponse extends Response {
  cloneCalls = 0;

  override clone() {
    this.cloneCalls += 1;
    return super.clone();
  }
}

test("scoped observers retain declared methods and parameter names across concurrent requests", async () => {
  const seen: unknown[] = [];
  const transportSymbols: symbol[][] = [];
  const scopedClient = createApiClient<TestRoutes>("https://api.example", {
    fetcher: testFetcher(async (_input, init) => {
      transportSymbols.push(Object.getOwnPropertySymbols(init ?? {}));
      await Promise.resolve();
      return jsonResponse();
    }),
    onScopedResponse: async ({ response, scope }) => {
      seen.push(scope);
      expect(response.status).toBe(200);
      await Promise.resolve();
    },
  });
  await Promise.all([
    scopedClient.v1.items({ itemId: "first-private-id" }).get(),
    scopedClient.v1.items({ itemId: "second-private-id" }).patch({}),
  ]);
  expect(seen).toContainEqual({
    type: "request",
    method: "GET",
    routeTemplate: "/v1/items/:itemId",
  });
  expect(seen).toContainEqual({
    type: "request",
    method: "PATCH",
    routeTemplate: "/v1/items/:itemId",
  });
  expect(seen).toHaveLength(2);
  expect(JSON.stringify(seen)).not.toContain("private-id");
  expect(transportSymbols).toEqual([[], []]);
});

test("scoped observation leaves streamed success bodies for the caller", async () => {
  const chunks = ['{"items":', "[1]}"];
  const encoder = new TextEncoder();
  let chunkIndex = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks.at(chunkIndex);
      if (chunk === undefined) {
        controller.close();
        return;
      }
      chunkIndex += 1;
      controller.enqueue(encoder.encode(chunk));
    },
  });
  const response = new CloneTrackedResponse(body, {
    headers: { "content-type": "application/json" },
  });
  let observed: ScopedResponse | undefined;
  const scopedClient = createApiClient<TestRoutes>("https://api.example", {
    fetcher: testFetcher(async () => response),
    onScopedResponse: ({ response: observedResponse }) => {
      observed = observedResponse;
    },
  });

  const result = await scopedClient.v1.answers.json.get();

  expect(result.data).toEqual({ items: [1] });
  expect(observed).toBe(response);
  expect(response.cloneCalls).toBe(0);
  expect(response.bodyUsed).toBe(true);
});

test("scoped clients resolve the current default fetch at request time", async () => {
  const previousFetch = globalThis.fetch;
  const observed: string[] = [];
  const scopedClient = createApiClient<TestRoutes>("https://api.example", {
    onScopedResponse: ({ scope }) => {
      observed.push(scope.routeTemplate);
    },
  });
  let calls = 0;
  globalThis.fetch = testFetcher(async () => {
    calls += 1;
    return jsonResponse();
  });
  try {
    await scopedClient.v1.answers.json.get();
    expect(calls).toBe(1);
    expect(observed).toEqual(["/v1/answers/json"]);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test.each(["request", "fetch", "scoped-response", "response"] as const)(
  "preserves the %s boundary rejection without decoding a response",
  async (boundary) => {
    const failure = new Error(`Failed ${boundary}`);
    const response = jsonResponse();
    let fetchCalls = 0;
    const fail = () => {
      throw failure;
    };
    const scopedClient = createApiClient<TestRoutes>("https://api.example", {
      ...(boundary === "request" ? { onRequest: fail } : {}),
      fetcher: async () => {
        fetchCalls += 1;
        return boundary === "fetch" ? fail() : response;
      },
      ...(boundary === "scoped-response" ? { onScopedResponse: fail } : {}),
      ...(boundary === "response" ? { onResponse: fail } : {}),
    });
    expect(await rejectionOf(scopedClient.v1.answers.json.get())).toBe(failure);
    expect(fetchCalls).toBe(boundary === "request" ? 0 : 1);
    expect(response.bodyUsed).toBe(false);
  },
);

test("scoped and ordinary observers see the same unread response before decoding", async () => {
  const response = jsonResponse();
  const order: string[] = [];
  const scopedClient = createApiClient<TestRoutes>("https://api.example", {
    fetcher: async () => response,
    onScopedResponse: ({ response: observed }) => {
      expect(observed).toBe(response);
      expect(response.bodyUsed).toBe(false);
      order.push("scoped");
    },
    onResponse: (observed) => {
      expect(observed).toBe(response);
      expect(response.bodyUsed).toBe(false);
      order.push("ordinary");
    },
  });
  const result = await scopedClient.v1.answers.json.get();
  expect(order).toEqual(["scoped", "ordinary"]);
  expect(result.response).toBe(response);
  expect(result.data).toEqual({ items: [1] });
});

describe("request replay header policy", () => {
  const key = "intent-key";
  const headerSources = [
    {
      clientOptions: { headers: { "Idempotency-Key": key } },
      requestOptions: {},
    },
    {
      clientOptions: { headers: () => ({ "idempotency-key": key }) },
      requestOptions: {},
    },
    {
      clientOptions: {
        fetch: { headers: new Headers({ "IDEMPOTENCY-KEY": key }) },
      },
      requestOptions: {},
    },
    {
      clientOptions: {},
      requestOptions: { headers: { "Idempotency-Key": key } },
    },
    {
      clientOptions: {},
      requestOptions: { fetch: { headers: [["Idempotency-Key", key]] } },
    },
    {
      clientOptions: {
        headers: { "Idempotency-Key": "default" },
        fetch: { headers: { "Idempotency-Key": "fetch-default" } },
      },
      requestOptions: {
        headers: { "Idempotency-Key": key },
        fetch: { headers: { "Idempotency-Key": "fetch-request" } },
      },
    },
  ] satisfies readonly {
    clientOptions: ApiClientOptions;
    requestOptions: { headers?: Record<string, string>; fetch?: RequestInit };
  }[];

  test("all merged header channels obey the replay policy at transport", async () => {
    for (const { clientOptions, requestOptions } of headerSources) {
      for (const eligible of [false, true]) {
        const observed: (string | null)[] = [];
        const api = client({
          ...clientOptions,
          requestReplayRoutes: eligible
            ? [{ method: "POST", path: "/v1/items" }]
            : [],
          onRequest: (_path, init) => {
            observed.push(new Headers(init.headers).get("Idempotency-Key"));
          },
        });
        const result = await api.items.post(
          { name: "Created" },
          requestOptions,
        );
        expect(observed).toEqual([key]);
        expect(result.data?.headers["idempotency-key"]).toBe(
          eligible ? key : undefined,
        );
      }
    }
  });

  test("eligibility binds method and template even when literal and dynamic paths coincide", async () => {
    const api = client({
      headers: { "Idempotency-Key": key },
      requestReplayRoutes: [{ method: "patch", path: "/v1/items/:itemId" }],
    });
    const replay = await api.items({ itemId: "special" }).patch({});
    const literal = await api.items.special.patch({});
    const otherMethod = await api.items({ itemId: "special" }).delete();
    expect(replay.data?.path).toBe(literal.data?.path);
    expect(replay.data?.headers["idempotency-key"]).toBe(key);
    expect(literal.data?.headers["idempotency-key"]).toBeUndefined();
    expect(otherMethod.data?.headers["idempotency-key"]).toBeUndefined();
  });

  test("a request hook cannot restore an ineligible replay header", async () => {
    for (const replace of [false, true]) {
      const api = client({
        requestReplayRoutes: [],
        onRequest: (_path, init) => {
          if (replace) {
            init.headers = { "Idempotency-Key": key };
          } else if (init.headers instanceof Headers) {
            init.headers.set("Idempotency-Key", key);
          }
        },
      });
      const result = await api.items.post({ name: "Created" });
      expect(result.data?.headers["idempotency-key"]).toBeUndefined();
    }
  });

  test("clients without a replay policy preserve existing headers", async () => {
    for (const { clientOptions, requestOptions } of headerSources) {
      const result = await client(clientOptions).items.post(
        { name: "Created" },
        requestOptions,
      );
      expect(result.data?.headers["idempotency-key"]).toBe(key);
    }
  });
});
