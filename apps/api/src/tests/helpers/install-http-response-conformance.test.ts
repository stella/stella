import { panic, Result } from "better-result";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Elysia, status as httpStatus, t } from "elysia";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
  safeHandlerResponseSchemasWithStatusText,
} from "@/api/lib/api-handlers";
import { ResponseConformanceError } from "@/api/lib/response-conformance-error";

import { installHttpResponseConformance } from "./install-http-response-conformance";
import { recordResponseConformanceFailure } from "./response-conformance-request-errors";
import { captureResponseConformanceViolations } from "./response-conformance-sink";

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe("central HTTP response conformance", () => {
  test("validates canonical status text against the complete error union", async () => {
    uninstall = installHttpResponseConformance();
    const app = new Elysia().get("/status", () => httpStatus(404), {
      response: safeHandlerResponseSchemasWithStatusText(
        t.Object({ value: t.String() }),
      ),
    });
    const response = await app.handle(new Request("http://localhost/status"));
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("Not Found");
  });

  test("rejects status text accepted by no branch of the declared error union", async () => {
    const { violations } = await captureResponseConformanceViolations(
      async () => {
        uninstall = installHttpResponseConformance();
        const app = new Elysia().get(
          "/status",
          () => new Response("wrong", { status: 404 }),
          {
            response: {
              404: t.Union([
                t.Object({ message: t.String() }),
                t.Literal("Not Found"),
              ]),
            },
          },
        );
        expect(
          await rejectionOf(app.handle(new Request("http://localhost/status"))),
        ).toMatchObject({ route: "GET /status", status: 404 });
      },
    );
    expect(violations).toMatchObject([
      { route: "GET /status", status: 404, issuePath: "(body)" },
    ]);
  });

  test("validates named models using the matched parameter route and preserves the body", async () => {
    uninstall = installHttpResponseConformance();
    const app = new Elysia({ aot: false })
      .model("Output", t.Object({ value: t.String() }))
      .get("/values/:id", ({ params }) => ({ value: params.id }), {
        response: "Output",
      });
    const response = await app.handle(
      new Request("http://localhost/values/one"),
    );
    expect(await response.json()).toEqual({ value: "one" });
  });

  test("validates a safe factory's named model before HTTP dispatch returns", async () => {
    uninstall = installHttpResponseConformance();
    const endpoint = createSafePublicHandler(
      {
        contract: "patch",
        cache: { kind: "public", maxAge: 0 },
        accountAccess: ACCOUNT_ACCESS.sandbox,
        mcp: { type: "internal", reason: "health_infra" },
        response: "FactoryOutput",
      } as const,
      async function* () {
        return Result.ok({ value: "named" });
      },
    );
    const app = new Elysia({ aot: false })
      .model("FactoryOutput", t.Object({ value: t.String() }))
      .get(
        "/factory",
        async (context) => {
          // The factory cannot resolve a model registered on its caller's app.
          const pending: unknown = Reflect.apply(endpoint.handler, undefined, [
            context,
          ]);
          const result: unknown = await pending;
          if (
            typeof result !== "object" ||
            result === null ||
            !("value" in result) ||
            typeof result.value !== "string"
          ) {
            panic("Named-model fixture factory returned an invalid value");
          }
          return { value: result.value };
        },
        endpoint.config,
      );
    const response = await app.handle(new Request("http://localhost/factory"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: "named" });
  });

  test("rejects a mismatched response produced by framework error conversion", async () => {
    const { violations } = await captureResponseConformanceViolations(
      async () => {
        uninstall = installHttpResponseConformance();
        const app = new Elysia({ aot: false })
          .onError(() => "converted")
          .get("/values/:id", () => Response.json({ value: 1 }), {
            response: t.Object({ value: t.String() }),
          });
        expect(
          await rejectionOf(
            app.handle(new Request("http://localhost/values/one")),
          ),
        ).toMatchObject({
          route: "GET /values/:id",
          status: 200,
          issuePath: "(body)",
        });
      },
    );
    expect(violations).toMatchObject([
      { route: "GET /values/:id", status: 200, issuePath: "(body)" },
    ]);
  });

  test.each([
    { library: "TypeBox", schema: t.Object({ value: t.String() }) },
    { library: "Valibot", schema: v.object({ value: v.string() }) },
  ])(
    "rejects a text body under a $library object declaration",
    async ({ schema }) => {
      const { violations } = await captureResponseConformanceViolations(
        async () => {
          uninstall = installHttpResponseConformance();
          const app = new Elysia().get("/object", () => new Response("wrong"), {
            response: schema,
          });
          expect(
            await rejectionOf(
              app.handle(new Request("http://localhost/object")),
            ),
          ).toMatchObject({
            route: "GET /object",
            status: 200,
            issuePath: "(body)",
            message: expect.stringContaining("content-type: text/plain"),
          });
        },
      );
      expect(violations).toMatchObject([
        { route: "GET /object", status: 200, issuePath: "(body)" },
      ]);
    },
  );

  test.each([
    {
      library: "TypeBox literal",
      schema: t.Literal("ok"),
      text: "ok",
      outcome: "valid",
    },
    {
      library: "TypeBox literal",
      schema: t.Literal("ok"),
      text: "wrong",
      outcome: "invalid",
    },
    {
      library: "Valibot string",
      schema: v.string(),
      text: "ok",
      outcome: "valid",
    },
    {
      library: "Valibot string",
      schema: v.string(),
      text: "wrong",
      outcome: "valid",
    },
  ])(
    "validates a $library text response: $text",
    async ({ schema, text, outcome }) => {
      const { violations } = await captureResponseConformanceViolations(
        async () => {
          uninstall = installHttpResponseConformance();
          const app = new Elysia().get("/literal", () => new Response(text), {
            response: schema,
          });
          const pending = app.handle(new Request("http://localhost/literal"));
          if (outcome === "valid") {
            expect(await (await pending).text()).toBe(text);
            return;
          }
          expect(await rejectionOf(pending)).toMatchObject({
            route: "GET /literal",
            status: 200,
          });
        },
      );
      expect(violations).toMatchObject(
        outcome === "valid"
          ? []
          : [{ route: "GET /literal", status: 200, issuePath: "(body)" }],
      );
    },
  );

  test("recognizes a generator route's declared streaming body", async () => {
    uninstall = installHttpResponseConformance();
    const app = new Elysia().get(
      "/generator",
      async function* () {
        yield { value: "one" };
        yield { value: "two" };
      },
      { response: t.Object({ value: t.String() }) },
    );
    const response = await app.handle(
      new Request("http://localhost/generator"),
    );
    const body = await response.text();
    expect(body).toContain("one");
    expect(body).toContain("two");
  });

  test.each([200, 201])(
    "SSE status %s is checked without cloning or consuming the stream",
    async (status) => {
      const { violations } = await captureResponseConformanceViolations(
        async () => {
          uninstall = installHttpResponseConformance();
          const events = "data: first\n\ndata: last\n\n";
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(events));
              controller.close();
            },
          });
          const original = new Response(stream, {
            status,
            headers: { "content-type": "text/event-stream" },
          });
          const clone = spyOn(original, "clone");
          try {
            const app = new Elysia().get("/events", () => original, {
              response: {
                200: t.String({ contentMediaType: "text/event-stream" }),
              },
            });
            const request = app.handle(new Request("http://localhost/events"));
            if (status === 200) {
              expect(await (await request).text()).toBe(events);
            } else {
              expect(await rejectionOf(request)).toMatchObject({
                route: "GET /events",
                status: 201,
                issuePath: "(status)",
              });
              expect(await original.text()).toBe(events);
            }
            expect(clone).not.toHaveBeenCalled();
          } finally {
            clone.mockRestore();
          }
        },
      );
      expect(violations).toMatchObject(
        status === 200
          ? []
          : [{ route: "GET /events", status: 201, issuePath: "(status)" }],
      );
    },
  );

  test("rethrows a request-scoped factory defect after onError converts it", async () => {
    const { violations } = await captureResponseConformanceViolations(
      async () => {
        uninstall = installHttpResponseConformance();
        const failure = new ResponseConformanceError({
          message:
            "Response conformance failed: GET /value status 200 at /value",
          route: "GET /value",
          status: 200,
          issuePath: "/value",
        });
        let converted = false;
        const app = new Elysia({ aot: false })
          .onError(() => {
            converted = true;
            return "converted";
          })
          .get("/value", ({ request }) => {
            recordResponseConformanceFailure(request, failure);
            throw failure;
          });
        expect(
          await rejectionOf(app.handle(new Request("http://localhost/value"))),
        ).toBe(failure);
        expect(converted).toBe(true);
      },
    );
    expect(violations).toMatchObject([
      { route: "GET /value", status: 200, issuePath: "/value" },
    ]);
  });
});
