import { describe, expect, spyOn, test } from "bun:test";
import { Elysia, t } from "elysia";

import { rejectionOf } from "@stll/property-testing/rejection";

import { ResponseConformanceError } from "@/api/lib/response-conformance-error";

import {
  assertHttpResponseConformance,
  assertResponseConformance,
} from "./response-conformance-validation";

const route = "GET /fixture";
const objectSchema = t.Object({ count: t.Number() });

describe("response conformance validation", () => {
  test("checks TypeBox fields and declared response statuses", async () => {
    expect(
      await assertResponseConformance({
        route,
        status: 200,
        schema: objectSchema,
        value: { count: 1 },
      }),
    ).toBe("valid");
    expect(
      await rejectionOf(
        assertResponseConformance({
          route,
          status: 200,
          schema: objectSchema,
          value: { count: "private-value" },
        }),
      ),
    ).toMatchObject({
      route,
      status: 200,
      issuePath: "/count",
    });
    expect(
      await rejectionOf(
        assertResponseConformance({
          route,
          status: 201,
          schema: objectSchema,
          value: { count: 1 },
        }),
      ),
    ).toMatchObject({ issuePath: "(status)" });
    expect(
      await assertResponseConformance({
        route,
        status: 201,
        schema: { 201: objectSchema },
        value: { count: 1 },
      }),
    ).toBe("valid");
    expect(
      await assertResponseConformance({
        route,
        status: 404,
        schema: { default: t.String() },
        value: "missing",
      }),
    ).toBe("valid");
    expect(
      await rejectionOf(
        assertResponseConformance({
          route,
          status: 404,
          schema: { 200: objectSchema },
          value: {},
        }),
      ),
    ).toMatchObject({ issuePath: "(status)" });
  });

  test("resolves named Elysia models and TypeBox references", async () => {
    const output = t.Object({ count: t.Number() }, { $id: "Output" });
    const app = new Elysia().model("Output", output);
    const models = { Output: app.models.Output.schema };
    expect(
      await assertHttpResponseConformance({
        route,
        response: Response.json({ count: 1 }),
        method: "GET",
        schema: { 200: "Output" },
        models,
      }),
    ).toBe("valid");
    expect(
      await assertResponseConformance({
        route,
        status: 200,
        schema: t.Ref("Output"),
        references: [output],
        value: { count: 1 },
      }),
    ).toBe("valid");
    expect(
      await rejectionOf(
        assertResponseConformance({
          route,
          status: 200,
          schema: t.Ref("Output"),
          references: [output],
          value: { count: "wrong" },
        }),
      ),
    ).toMatchObject({ issuePath: "/count" });
    expect(
      await rejectionOf(
        assertResponseConformance({
          route,
          status: 200,
          schema: { 200: "UnknownModel" },
          models,
          value: {},
        }),
      ),
    ).toMatchObject({ issuePath: "(schema)" });
    expect(
      await rejectionOf(
        assertResponseConformance({
          route,
          status: 200,
          schema: { 200: output, invalid: output },
          value: { count: 1 },
        }),
      ),
    ).toMatchObject({ issuePath: "(schema)" });
  });

  test("distinguishes missing declarations from unsupported schemas", async () => {
    for (const schema of [undefined, null]) {
      expect(
        await assertResponseConformance({
          route,
          status: 200,
          schema,
          value: {},
        }),
      ).toBe("missing");
    }
    for (const schema of ["NamedSchema", {}, { type: "unknown" }]) {
      expect(
        await rejectionOf(
          assertResponseConformance({ route, status: 200, schema, value: {} }),
        ),
      ).toMatchObject({ issuePath: "(schema)" });
    }
  });

  test("supports asynchronous Standard Schema validation and keyed issue paths", async () => {
    const schema = {
      "~standard": {
        version: 1,
        vendor: "fixture",
        validate: async (value: unknown) => {
          await Promise.resolve();
          return value === "accepted"
            ? { value }
            : {
                issues: [
                  { message: "invalid", path: [{ key: "items" }, 0, "name"] },
                ],
              };
        },
      },
    };
    expect(
      await assertResponseConformance({
        route,
        status: 200,
        schema,
        value: "accepted",
      }),
    ).toBe("valid");
    expect(
      await rejectionOf(
        assertResponseConformance({
          route,
          status: 200,
          schema,
          value: "private-value",
        }),
      ),
    ).toMatchObject({ issuePath: "items.0.name" });
  });

  test("borrows the original while validating its owned JSON clone", async () => {
    const original = Response.json({ count: 2 });
    expect(
      await assertHttpResponseConformance({
        route,
        response: original,
        method: "GET",
        schema: objectSchema,
      }),
    ).toBe("valid");
    expect(await original.json()).toEqual({ count: 2 });
  });

  test("reports malformed JSON without including response content", async () => {
    const response = new Response("private-value", {
      headers: { "content-type": "application/json" },
    });
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response,
          method: "GET",
          schema: objectSchema,
        }),
      ),
    ).toMatchObject({
      issuePath: "(body)",
      message: `Response conformance failed: ${route} status 200 at (body)`,
    });
  });

  test("validates statuses but omits protocol-forbidden response bodies", async () => {
    for (const status of [204, 304]) {
      expect(
        await assertHttpResponseConformance({
          route,
          response: new Response(null, { status }),
          method: "GET",
          schema: { [status]: objectSchema },
        }),
      ).toBe("valid");
    }
    expect(
      await assertHttpResponseConformance({
        route,
        response: new Response(null),
        method: "HEAD",
        schema: objectSchema,
      }),
    ).toBe("valid");
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response: new Response(null, { status: 204 }),
          method: "GET",
          schema: objectSchema,
        }),
      ),
    ).toMatchObject({ issuePath: "(status)" });
  });

  test("does not read unconstrained streaming bodies", async () => {
    const response = new Response(new ReadableStream());
    expect(
      await assertHttpResponseConformance({
        route,
        response,
        method: "GET",
        schema: t.Any(),
      }),
    ).toBe("valid");
    expect(response.bodyUsed).toBe(false);
    await response.body?.cancel();
  });

  test.each(["text/plain", "text/event-stream", "application/octet-stream"])(
    "does not clone or consume %s responses even under an object schema",
    async (contentType) => {
      const response = new Response("stream payload", {
        headers: { "content-type": contentType },
      });
      const clone = spyOn(response, "clone");
      try {
        expect(
          await assertHttpResponseConformance({
            route,
            response,
            method: "GET",
            schema: objectSchema,
          }),
        ).toBe("valid");
        expect(clone).toHaveBeenCalledTimes(0);
        expect(response.bodyUsed).toBe(false);
        expect(await response.text()).toBe("stream payload");
      } finally {
        clone.mockRestore();
      }
    },
  );

  test("does not clone unconstrained JSON or File responses", async () => {
    for (const schema of [t.Any(), t.Unknown(), t.File()]) {
      const response = Response.json({ private: "value" });
      const clone = spyOn(response, "clone");
      try {
        expect(
          await assertHttpResponseConformance({
            route,
            response,
            method: "GET",
            schema,
          }),
        ).toBe("valid");
        expect(clone).toHaveBeenCalledTimes(0);
        expect(response.bodyUsed).toBe(false);
        await response.body?.cancel();
      } finally {
        clone.mockRestore();
      }
    }
  });

  test.each([true, false])(
    "cancels its constrained JSON clone after validation success=%s",
    async (valid) => {
      const response = Response.json({ count: valid ? 1 : "wrong" });
      const copy = response.clone();
      if (copy.body === null) {
        throw new Error("The JSON clone fixture must have a body");
      }
      const clone = spyOn(response, "clone").mockReturnValue(copy);
      const cancel = spyOn(copy.body, "cancel");
      try {
        const checked = assertHttpResponseConformance({
          route,
          response,
          method: "GET",
          schema: objectSchema,
        });
        if (valid) {
          expect(await checked).toBe("valid");
        } else {
          expect(await rejectionOf(checked)).toMatchObject({
            issuePath: "/count",
          });
        }
        expect(clone).toHaveBeenCalledTimes(1);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(response.bodyUsed).toBe(false);
        expect(await response.json()).toEqual({ count: valid ? 1 : "wrong" });
      } finally {
        cancel.mockRestore();
        clone.mockRestore();
      }
    },
  );

  test("checks constrained +json bodies using the effective status override", async () => {
    const response = new Response(JSON.stringify({ count: "wrong" }), {
      headers: { "content-type": "application/problem+json; charset=utf-8" },
    });
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response,
          status: 201,
          method: "GET",
          schema: { 201: objectSchema },
        }),
      ),
    ).toMatchObject({ status: 201, issuePath: "/count" });
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toEqual({ count: "wrong" });
  });

  test("uses the dedicated error type", async () => {
    expect(
      await rejectionOf(
        assertResponseConformance({
          route,
          status: 200,
          schema: objectSchema,
          value: null,
        }),
      ),
    ).toBeInstanceOf(ResponseConformanceError);
  });
});
