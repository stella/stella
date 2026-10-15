import { describe, expect, spyOn, test } from "bun:test";
import { Elysia, t } from "elysia";
import * as v from "valibot";

import { rejectionOf } from "@stll/property-testing/rejection";

import { ResponseConformanceError } from "@/api/lib/response-conformance-error";

import {
  captureResponseConformanceViolations,
  recordResponseConformanceViolation,
} from "./response-conformance-sink";
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

  test.each([true, false])(
    "preserves validator paths and deduplicates HTTP/direct defects with HTTP first=%s",
    async (httpFirst) => {
      for (const [schema, issuePath] of [
        [objectSchema, "/count"],
        [v.object({ count: v.number() }), "count"],
      ] as const) {
        const value = { count: "wrong" };
        const direct = await rejectionOf(
          assertResponseConformance({ route, status: 200, schema, value }),
        );
        const response = Response.json(value);
        const http = await rejectionOf(
          assertHttpResponseConformance({
            route,
            response,
            method: "GET",
            schema,
          }),
        );
        expect(direct).toMatchObject({ route, status: 200, issuePath });
        expect(http).toMatchObject({
          route,
          status: 200,
          issuePath,
          contentType: "application/json",
          message: expect.stringContaining("content-type: application/json"),
        });
        const { violations } = await captureResponseConformanceViolations(
          () => {
            for (const error of httpFirst ? [http, direct] : [direct, http]) {
              recordResponseConformanceViolation(error);
            }
          },
        );
        expect(violations).toHaveLength(1);
        expect(violations).toMatchObject([
          { route, status: 200, issuePath, contentType: "application/json" },
        ]);
        expect(await response.json()).toEqual(value);
      }
    },
  );

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
      message: `Response conformance failed: ${route} status 200 at (body) (content-type: application/json)`,
    });
    expect(response.bodyUsed).toBe(false);
    expect(await response.text()).toBe("private-value");
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
    "decodes finite %s representations and rejects incompatible bodies",
    async (contentType) => {
      const response = new Response("stream payload", {
        headers: { "content-type": contentType },
      });
      const clone = spyOn(response, "clone");
      try {
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
          issuePath: contentType === "text/event-stream" ? "(body)" : "(root)",
          contentType,
          message: `Response conformance failed: ${route} status 200 at ${contentType === "text/event-stream" ? "(body)" : "(root)"} (content-type: ${contentType})`,
        });
        expect(clone).toHaveBeenCalledTimes(
          contentType === "text/event-stream" ? 0 : 1,
        );
        expect(response.bodyUsed).toBe(false);
        expect(await response.text()).toBe("stream payload");
      } finally {
        clone.mockRestore();
      }
    },
  );

  test("validates finite literal and string-union text while preserving caller bodies", async () => {
    for (const schema of [
      t.Literal("ready"),
      t.Union([t.Literal("ready"), t.Literal("done")]),
    ]) {
      const valid = new Response("ready");
      expect(
        await assertHttpResponseConformance({
          route,
          response: valid,
          method: "GET",
          schema,
        }),
      ).toBe("valid");
      expect(await valid.text()).toBe("ready");
      const invalid = new Response("wrong");
      expect(
        await rejectionOf(
          assertHttpResponseConformance({
            route,
            response: invalid,
            method: "GET",
            schema,
          }),
        ),
      ).toBeInstanceOf(ResponseConformanceError);
      expect(await invalid.text()).toBe("wrong");
    }
  });

  test("validates the entire mixed union for textual and JSON representations", async () => {
    const schema = t.Union([objectSchema, t.Literal("ready")]);
    const text = new Response("ready");
    expect(
      await assertHttpResponseConformance({
        route,
        response: text,
        method: "GET",
        schema,
      }),
    ).toBe("valid");
    expect(await text.text()).toBe("ready");
    const wrongText = new Response("wrong");
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response: wrongText,
          method: "GET",
          schema,
        }),
      ),
    ).toBeInstanceOf(ResponseConformanceError);
    expect(await wrongText.text()).toBe("wrong");
    const json = Response.json({ count: 1 });
    expect(
      await assertHttpResponseConformance({
        route,
        response: json,
        method: "GET",
        schema,
      }),
    ).toBe("valid");
    expect(await json.json()).toEqual({ count: 1 });
    const wrongJson = Response.json({ count: "wrong" });
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response: wrongJson,
          method: "GET",
          schema,
        }),
      ),
    ).toBeInstanceOf(ResponseConformanceError);
    expect(await wrongJson.json()).toEqual({ count: "wrong" });
  });

  test("keeps non-JSON number and boolean representations as raw strings", async () => {
    for (const [schema, text, value] of [
      [t.Number(), "42", 42],
      [t.Boolean(), "false", false],
    ] as const) {
      const response = new Response(text);
      const clone = spyOn(response, "clone");
      try {
        expect(
          await rejectionOf(
            assertHttpResponseConformance({
              route,
              response,
              method: "GET",
              schema,
            }),
          ),
        ).toMatchObject({
          issuePath: "(root)",
          contentType: "text/plain",
          message: `Response conformance failed: ${route} status 200 at (root) (content-type: text/plain)`,
        });
        expect(clone).toHaveBeenCalledTimes(1);
        expect(await response.text()).toBe(text);
        const json = Response.json(value);
        expect(
          await assertHttpResponseConformance({
            route,
            response: json,
            method: "GET",
            schema,
          }),
        ).toBe("valid");
        expect(await json.json()).toBe(value);
      } finally {
        clone.mockRestore();
      }
    }
  });

  test("exempts declared event streams but rejects an undeclared string stream without cloning", async () => {
    for (const declared of [true, false]) {
      const response = new Response("data: ready\n\n", {
        headers: { "content-type": "text/event-stream" },
      });
      const clone = spyOn(response, "clone");
      try {
        const schema = declared
          ? t.String({ contentMediaType: "text/event-stream" })
          : t.String();
        const checked = assertHttpResponseConformance({
          route,
          response,
          method: "GET",
          schema,
        });
        if (declared) {
          expect(await checked).toBe("valid");
        } else {
          expect(await rejectionOf(checked)).toMatchObject({
            issuePath: "(body)",
            contentType: "text/event-stream",
          });
        }
        expect(clone).toHaveBeenCalledTimes(0);
        expect(await response.text()).toBe("data: ready\n\n");
      } finally {
        clone.mockRestore();
      }
    }
  });

  test("recognizes declared generator handlers without cloning their response streams", async () => {
    const response = new Response("data: ready\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
    const handler = async function* () {
      yield { count: 1 };
    };
    const clone = spyOn(response, "clone");
    try {
      expect(
        await assertHttpResponseConformance({
          route,
          response,
          method: "GET",
          schema: objectSchema,
          handler,
        }),
      ).toBe("valid");
      expect(clone).toHaveBeenCalledTimes(0);
      expect(await response.text()).toBe("data: ready\n\n");
    } finally {
      clone.mockRestore();
    }
  });

  test.each([true, false])(
    "cancels its finite text clone after validation success=%s",
    async (valid) => {
      const response = new Response(valid ? "ready" : "wrong");
      const copy = response.clone();
      if (copy.body === null) {
        throw new Error("The text clone fixture must have a body");
      }
      const clone = spyOn(response, "clone").mockReturnValue(copy);
      const cancel = spyOn(copy.body, "cancel");
      try {
        const checked = assertHttpResponseConformance({
          route,
          response,
          method: "GET",
          schema: t.Literal("ready"),
        });
        if (valid) {
          expect(await checked).toBe("valid");
        } else {
          expect(await rejectionOf(checked)).toBeInstanceOf(
            ResponseConformanceError,
          );
        }
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(await response.text()).toBe(valid ? "ready" : "wrong");
      } finally {
        cancel.mockRestore();
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
            contentType: "application/json",
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
    ).toMatchObject({
      status: 201,
      issuePath: "/count",
      contentType: "application/problem+json",
    });
    expect(response.bodyUsed).toBe(false);
    expect(await response.json()).toEqual({ count: "wrong" });
  });

  test("decodes Standard Schema HTTP bodies by their representation", async () => {
    const stringResponse = new Response('{"count":1}', {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
    expect(
      await assertHttpResponseConformance({
        route,
        response: stringResponse,
        method: "GET",
        schema: v.string(),
      }),
    ).toBe("valid");
    expect(await stringResponse.text()).toBe('{"count":1}');

    const jsonString = Response.json("ready");
    expect(
      await assertHttpResponseConformance({
        route,
        response: jsonString,
        method: "GET",
        schema: v.string(),
      }),
    ).toBe("valid");
    expect(await jsonString.json()).toBe("ready");

    const objectForString = Response.json({ count: 1 });
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response: objectForString,
          method: "GET",
          schema: v.string(),
        }),
      ),
    ).toMatchObject({
      issuePath: "(root)",
      contentType: "application/json",
      message: `Response conformance failed: ${route} status 200 at (root) (content-type: application/json)`,
    });
    expect(await objectForString.json()).toEqual({ count: 1 });

    const schema = v.object({ count: v.number() });
    const jsonObject = Response.json({ count: 1 });
    expect(
      await assertHttpResponseConformance({
        route,
        response: jsonObject,
        method: "GET",
        schema,
      }),
    ).toBe("valid");
    expect(await jsonObject.json()).toEqual({ count: 1 });

    const textObject = new Response('{"count":1}');
    expect(
      await rejectionOf(
        assertHttpResponseConformance({
          route,
          response: textObject,
          method: "GET",
          schema,
        }),
      ),
    ).toMatchObject({
      issuePath: "(root)",
      contentType: "text/plain",
      message: `Response conformance failed: ${route} status 200 at (root) (content-type: text/plain)`,
    });
    expect(textObject.bodyUsed).toBe(false);
    expect(await textObject.text()).toBe('{"count":1}');
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
