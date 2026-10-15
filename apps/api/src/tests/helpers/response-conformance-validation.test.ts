import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import * as v from "valibot";

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

  test("reads the observer clone while preserving the original response", async () => {
    const original = Response.json({ count: 2 });
    expect(
      await assertHttpResponseConformance({
        route,
        response: original.clone(),
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

  test("reads Elysia numeric and boolean responses without coercing JSON strings", async () => {
    for (const [path, value, schema] of [
      ["/number", 42, t.Number()],
      ["/boolean", false, t.Boolean()],
    ] as const) {
      const app = new Elysia({ aot: false }).get(path, () => value, {
        response: schema,
      });
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(
        await assertHttpResponseConformance({
          route: path,
          response,
          method: "GET",
          schema,
        }),
      ).toBe("valid");
    }
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response: Response.json("42"),
          method: "GET",
          schema: t.Number(),
        }),
      ),
    ).toMatchObject({ issuePath: "(root)" });
    expect(
      await assertHttpResponseConformance({
        route,
        response: new Response("42"),
        method: "GET",
        schema: t.Union([t.String(), t.Number()]),
      }),
    ).toBe("valid");
  });

  test("reads Standard Schema numeric and boolean Elysia responses", async () => {
    for (const [path, value, schema] of [
      ["/standard-number", 42, v.number()],
      ["/standard-boolean", false, v.boolean()],
    ] as const) {
      const app = new Elysia({ aot: false }).get(path, () => value, {
        response: schema,
      });
      const response = await app.handle(new Request(`http://localhost${path}`));
      expect(
        await assertHttpResponseConformance({
          route: path,
          response,
          method: "GET",
          schema,
        }),
      ).toBe("valid");
    }
    const schema = v.union([v.string(), v.number()]);
    expect(
      await assertHttpResponseConformance({
        route,
        response: new Response("42"),
        method: "GET",
        schema,
      }),
    ).toBe("valid");
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response: Response.json("42"),
          method: "GET",
          schema: v.number(),
        }),
      ),
    ).toMatchObject({ issuePath: "(root)" });
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response: new Response("not a primitive"),
          method: "GET",
          schema: v.number(),
        }),
      ),
    ).toMatchObject({ issuePath: "(root)" });
  });

  test("preserves schema runtime failures instead of retrying a primitive", async () => {
    const schema = {
      "~standard": {
        validate: () => {
          throw new Error("fixture validator failed");
        },
      },
    };
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response: new Response("42"),
          method: "GET",
          schema,
        }),
      ),
    ).toMatchObject({ issuePath: "(schema)" });
  });

  test("reads text and File payloads using their transport representations", async () => {
    expect(
      await assertHttpResponseConformance({
        route,
        response: new Response("ok"),
        method: "GET",
        schema: t.String(),
      }),
    ).toBe("valid");
    expect(
      await assertHttpResponseConformance({
        route,
        response: new Response(new Blob(["file"])),
        method: "GET",
        schema: t.File(),
      }),
    ).toBe("valid");
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
