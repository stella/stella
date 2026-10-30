import { Result } from "better-result";
import { expect, test } from "bun:test";

import { proveSanctionsStartup } from "./sanctions-startup-proof";

const requestUrl = (request: string | URL | Request): string => {
  if (request instanceof URL) {
    return request.href;
  }
  if (typeof request === "string") {
    return request;
  }
  return request.url;
};

const proofFailure = async (
  proof: ReturnType<typeof proveSanctionsStartup>,
): Promise<string | null> => {
  const outcome = await proof;
  return Result.isError(outcome) ? outcome.error.message : null;
};

const searchAnswering = (...bodies: Response[]) => {
  const responses = [Response.json({ status: "started" }), ...bodies];
  return async () => responses.shift() ?? new Response(null, { status: 500 });
};

test("polls started before searching and rejects a warming list", async () => {
  const requests: string[] = [];
  const responses = [
    new Response(null, { status: 503 }),
    Response.json({ status: "started" }),
    Response.json({ lists: [{ source: "eu", reason: "warming" }] }),
  ];

  const failure = await proofFailure(
    proveSanctionsStartup({
      baseUrl: "https://api.example.test",
      transport: async (request) => {
        requests.push(requestUrl(request));
        return responses.shift() ?? new Response(null, { status: 500 });
      },
      sleep: async () => undefined,
    }),
  );

  expect(failure).toBe("Sanctions search reported warming after /started");
  expect(requests).toEqual([
    "https://api.example.test/started",
    "https://api.example.test/started",
    "https://api.example.test/v1/sanctions/search",
  ]);
});

test("bounds a stalled request by the remaining proof deadline", async () => {
  let instant = 0;
  const controller = new AbortController();
  const entered = Promise.withResolvers<undefined>();
  let abortedWith: unknown;
  const budgets: number[] = [];
  const pending = proofFailure(
    proveSanctionsStartup({
      baseUrl: "https://api.example.test",
      transport: async (_request, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            abortedWith = init.signal?.reason;
            reject(new Error("request aborted by proof deadline"));
          });
          entered.resolve(undefined);
        }),
      now: () => instant,
      deadlineSignal: (durationMs) => {
        budgets.push(durationMs);
        return controller.signal;
      },
      pollIntervalMs: 1,
      pollTimeoutMs: 10,
    }),
  );

  await entered.promise;
  expect(budgets).toEqual([10]);
  instant = 10;
  const deadline = new DOMException("Proof deadline reached", "TimeoutError");
  controller.abort(deadline);
  expect(await pending).toBe(
    "The API did not report started before the proof timeout",
  );
  expect(abortedWith).toBe(deadline);
});

test("bounds a search body that never completes, even when the transport ignores the signal", async () => {
  let instant = 0;
  let cancelledWith: unknown;
  const controller = new AbortController();
  const readingBody = Promise.withResolvers<undefined>();
  const budgets: number[] = [];
  const pending = proofFailure(
    proveSanctionsStartup({
      baseUrl: "https://api.example.test",
      transport: searchAnswering(
        new Response(
          new ReadableStream<Uint8Array>({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"lists":['));
            },
            pull() {
              readingBody.resolve(undefined);
            },
            cancel(reason) {
              cancelledWith = reason;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
      now: () => instant,
      deadlineSignal: (durationMs) => {
        budgets.push(durationMs);
        return controller.signal;
      },
      pollIntervalMs: 1,
      pollTimeoutMs: 50,
    }),
  );

  await readingBody.promise;
  expect(budgets).toEqual([50, 50]);
  instant = 50;
  const deadline = new DOMException("Proof deadline reached", "TimeoutError");
  controller.abort(deadline);
  expect(await pending).toBe(
    "Sanctions search response did not arrive as JSON before the proof timeout",
  );
  expect(cancelledWith).toBe(deadline);
});

test("retries refused connections until the deadline", async () => {
  let instant = 0;
  let calls = 0;
  const failure = await proofFailure(
    proveSanctionsStartup({
      baseUrl: "https://api.example.test",
      transport: async () => {
        calls++;
        return await Promise.reject(new Error("connection refused"));
      },
      now: () => instant,
      sleep: async (durationMs) => {
        instant += durationMs;
      },
      pollIntervalMs: 2,
      pollTimeoutMs: 5,
    }),
  );

  expect(calls).toBe(4);
  expect(failure).toBe(
    "The API did not report started before the proof timeout",
  );
});

// A valid list beside each malformed one must not carry the answer.
const warm = { source: "un", reason: null };

test.each([
  ["a primitive entry", { lists: [warm, "eu"] }],
  ["an empty entry", { lists: [warm, {}] }],
  ["an entry without a reason", { lists: [warm, { source: "eu" }] }],
  ["an entry without a source", { lists: [warm, { reason: null }] }],
  ["an empty source", { lists: [warm, { source: "", reason: null }] }],
  ["a non-string reason", { lists: [warm, { source: "eu", reason: 1 }] }],
  ["an empty reason", { lists: [warm, { source: "eu", reason: "" }] }],
  ["no lists at all", { lists: [] }],
  ["a body without lists", { status: "clear" }],
])("rejects %s instead of counting it as warm", async (_label, body) => {
  const failure = await proofFailure(
    proveSanctionsStartup({
      baseUrl: "https://api.example.test",
      transport: searchAnswering(Response.json(body)),
    }),
  );

  expect(failure).toBe("Sanctions search returned an invalid response");
});

test("passes when every list is warm or terminally failed", async () => {
  const outcome = await proveSanctionsStartup({
    baseUrl: "https://api.example.test",
    transport: searchAnswering(
      Response.json({
        lists: [
          { source: "eu", reason: null },
          { source: "un", reason: "load-failed" },
          { source: "cz", reason: "stale" },
        ],
      }),
    ),
  });

  expect(Result.isOk(outcome)).toBe(true);
});
