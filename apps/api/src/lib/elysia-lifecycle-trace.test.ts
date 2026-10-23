import { describe, expect, test } from "bun:test";
import { Elysia, ElysiaError, t } from "elysia";

const SECURITY_HEADERS = {
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
} as const;

const RATE_LIMIT_HEADERS = {
  "ratelimit-limit": "10",
  "ratelimit-remaining": "9",
} as const;

type Scenario =
  | "success"
  | "auth"
  | "handler-error"
  | "validation-error"
  | "thrown-error";

type TraceEntry =
  | "request"
  | "parse"
  | "transform"
  | "beforeHandle"
  | "handler"
  | "afterHandle"
  | "error"
  | "refund"
  | "afterResponse"
  | "complete";

type LifecycleFixture = {
  readonly trace: TraceEntry[];
  completed: number;
  refunded: number;
};

const scenarioFromRequest = (request: Request): Scenario => {
  const segment = new URL(request.url).pathname.split("/").at(-1);
  if (segment === undefined) {
    throw new TypeError("Unknown lifecycle scenario: undefined");
  }
  switch (segment) {
    case "success":
    case "auth":
    case "handler-error":
    case "validation-error":
    case "thrown-error":
      return segment;
    default:
      throw new TypeError(`Unknown lifecycle scenario: ${segment}`);
  }
};

const buildApp = (fixture: LifecycleFixture) =>
  new Elysia()
    .onRequest(({ set }) => {
      fixture.trace.push("request");
      Object.assign(set.headers, SECURITY_HEADERS);
    })
    .onParse(() => {
      fixture.trace.push("parse");
    })
    .onTransform(() => {
      fixture.trace.push("transform");
    })
    .onBeforeHandle(({ request, set }) => {
      fixture.trace.push("beforeHandle");
      Object.assign(set.headers, RATE_LIMIT_HEADERS);

      if (scenarioFromRequest(request) === "auth") {
        set.status = 401;
        set.headers["set-cookie"] =
          "stella.session=forwarded; Path=/; HttpOnly; SameSite=Lax";
        return { code: "unauthorized", message: "Authentication required" };
      }
      return undefined;
    })
    .onAfterHandle(({ request }) => {
      fixture.trace.push("afterHandle");
      if (scenarioFromRequest(request) === "success") {
        fixture.refunded += 1;
        fixture.trace.push("refund");
      }
    })
    .onError(({ error, set }) => {
      fixture.trace.push("error");
      if (error instanceof ElysiaError && error.code === "validation") {
        set.status = 422;
        return { code: "validation_error", message: "Invalid request" };
      }

      set.status = 500;
      return { code: "internal_error", message: "Internal server error" };
    })
    .onAfterResponse(() => {
      fixture.trace.push("afterResponse");
      fixture.completed += 1;
      fixture.trace.push("complete");
    })
    .post(
      "/trace/:scenario",
      { body: t.Object({ value: t.String() }) },
      ({ request, set }) => {
        fixture.trace.push("handler");
        switch (scenarioFromRequest(request)) {
          case "success":
            return { ok: true };
          case "handler-error":
            set.status = 409;
            return { code: "conflict", message: "Already exists" };
          case "thrown-error":
            throw new TypeError("synthetic lifecycle failure");
          case "auth":
          case "validation-error":
            throw new TypeError(
              "Scenario should have completed before handler",
            );
          default:
            throw new TypeError("Unknown lifecycle scenario");
        }
      },
    );

const request = (scenario: Scenario, body: unknown) =>
  new Request(`http://localhost/trace/${scenario}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const expectCommonHeaders = (response: Response) => {
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
};

describe("Elysia request lifecycle", () => {
  test.each([
    {
      scenario: "success",
      body: { value: "ok" },
      status: 200,
      responseBody: { ok: true },
      trace: [
        "request",
        "parse",
        "transform",
        "beforeHandle",
        "handler",
        "afterHandle",
        "refund",
        "afterResponse",
        "complete",
      ],
      rateLimited: true,
      cookie: null,
      refunded: 1,
    },
    {
      scenario: "auth",
      body: { value: "ok" },
      status: 401,
      responseBody: {
        code: "unauthorized",
        message: "Authentication required",
      },
      trace: [
        "request",
        "parse",
        "transform",
        "beforeHandle",
        "afterHandle",
        "afterResponse",
        "complete",
      ],
      rateLimited: true,
      cookie: "stella.session=forwarded; Path=/; HttpOnly; SameSite=Lax",
      refunded: 0,
    },
    {
      scenario: "handler-error",
      body: { value: "ok" },
      status: 409,
      responseBody: { code: "conflict", message: "Already exists" },
      trace: [
        "request",
        "parse",
        "transform",
        "beforeHandle",
        "handler",
        "afterHandle",
        "afterResponse",
        "complete",
      ],
      rateLimited: true,
      cookie: null,
      refunded: 0,
    },
    {
      scenario: "validation-error",
      body: { value: 42 },
      status: 422,
      responseBody: { code: "validation_error", message: "Invalid request" },
      trace: [
        "request",
        "parse",
        "transform",
        "error",
        "afterResponse",
        "complete",
      ],
      rateLimited: false,
      cookie: null,
      refunded: 0,
    },
    {
      scenario: "thrown-error",
      body: { value: "ok" },
      status: 500,
      responseBody: {
        code: "internal_error",
        message: "Internal server error",
      },
      trace: [
        "request",
        "parse",
        "transform",
        "beforeHandle",
        "handler",
        "error",
        "afterResponse",
        "complete",
      ],
      rateLimited: true,
      cookie: null,
      refunded: 0,
    },
  ] as const)(
    "preserves the $scenario lifecycle",
    async ({
      scenario,
      body,
      status,
      responseBody,
      trace,
      rateLimited,
      cookie,
      refunded,
    }) => {
      const fixture: LifecycleFixture = {
        trace: [],
        completed: 0,
        refunded: 0,
      };
      const response = await buildApp(fixture).handle(request(scenario, body));

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(responseBody);
      await Bun.sleep(0);
      expectCommonHeaders(response);
      expect(response.headers.get("ratelimit-limit")).toBe(
        rateLimited ? "10" : null,
      );
      expect(response.headers.get("ratelimit-remaining")).toBe(
        rateLimited ? "9" : null,
      );
      expect(response.headers.get("set-cookie")).toBe(cookie);
      expect(fixture.trace).toEqual([...trace]);
      expect(fixture.refunded).toBe(refunded);
      expect(fixture.completed).toBe(1);
    },
  );
});
