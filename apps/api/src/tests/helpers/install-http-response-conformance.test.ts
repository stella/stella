import { panic, Result } from "better-result";
import { afterEach, describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";

import { rejectionOf } from "@stll/property-testing/rejection";

import {
  ACCOUNT_ACCESS,
  createSafePublicHandler,
} from "@/api/lib/api-handlers";
import { ResponseConformanceError } from "@/api/lib/response-conformance-error";

import { installHttpResponseConformance } from "./install-http-response-conformance";
import { recordResponseConformanceFailure } from "./response-conformance-request-errors";

let uninstall: (() => void) | undefined;

afterEach(() => {
  uninstall?.();
  uninstall = undefined;
});

describe("central HTTP response conformance", () => {
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
    uninstall = installHttpResponseConformance();
    const app = new Elysia({ aot: false })
      .onError(() => "converted")
      .get("/values/:id", () => Response.json({ value: 1 }), {
        response: t.Object({ value: t.String() }),
      });
    expect(
      await rejectionOf(app.handle(new Request("http://localhost/values/one"))),
    ).toMatchObject({
      route: "GET /values/:id",
      status: 200,
      issuePath: "(root)",
    });
  });

  test("rethrows a request-scoped factory defect after onError converts it", async () => {
    uninstall = installHttpResponseConformance();
    const failure = new ResponseConformanceError({
      message: "Response conformance failed: GET /value status 200 at /value",
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
  });
});
