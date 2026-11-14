import { afterAll, describe, expect, test } from "bun:test";
import * as v from "valibot";

import fillTemplateToWorkspace from "@/api/handlers/templates/fills/create";
import fillTemplateById from "@/api/handlers/templates/fills/download";
import fillTemplatePreview from "@/api/handlers/templates/fills/preview";
import { createHttpApp } from "@/api/http/app";
import { routes } from "@/api/http/route";
import type { AnySchema, RouteDefinition } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

const invalidValues = [
  "arbitrary string",
  42,
  false,
  '{"client.name":"Ada"}',
  null,
  // Not `[]`: a valibot record reads a list as an object of its indices.
];

const storedFillSchemas = [
  ["fills.download", fillTemplateById.config.body],
  ["fills.preview", fillTemplatePreview.config.body],
  ["fills.create", fillTemplateToWorkspace.config.body],
] as const;

const recordOnlySchema = v.object({
  values: v.record(v.string(), v.unknown()),
});

/** Echoes the decoded `values`, so a 200 shows what the handler would see. */
const echoValues = (schema: AnySchema): RouteDefinition =>
  defineEndpoint.public({ body: schema }, ({ body: submitted }) => {
    if (typeof submitted !== "object" || submitted === null) {
      return new Response(null, { status: 500 });
    }
    if (!("values" in submitted)) {
      return new Response(null, { status: 500 });
    }
    return Response.json(submitted.values);
  });

const server = serveForTest(
  createHttpApp({
    middleware: [errorBoundary],
    routes: routes({
      "/fill/record-only": { POST: echoValues(recordOnlySchema) },
      ...Object.fromEntries(
        storedFillSchemas.map(([name, schema]) => [
          `/fill/${name}`,
          { POST: echoValues(schema) },
        ]),
      ),
    }),
  }),
);
afterAll(async () => {
  await server.stop();
});

const validateBody = async (body: unknown, name: string) =>
  await server.fetch(
    new Request(`https://example.test/fill/${name}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("stored-template fill value boundaries", () => {
  // A bare record refuses scalars but admits an array, so a boundary that
  // requires a map cannot be a bare record.
  test("a bare record schema admits an array but no scalar", async () => {
    for (const values of invalidValues) {
      const response = await validateBody({ values }, "record-only");
      expect({ values, status: response.status }).toEqual({
        values,
        status: Array.isArray(values) ? 200 : 422,
      });
    }
  });

  test.each(storedFillSchemas)("%s preserves nested values", async (name) => {
    const values = {
      "client.name": { display: "Ada" },
      signatories: [{ name: "Ada" }],
    };
    const response = await validateBody({ values }, name);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(values);
  });

  test.each(storedFillSchemas)(
    "%s rejects every non-object values form",
    async (name) => {
      for (const values of invalidValues) {
        const response = await validateBody({ values }, name);
        expect({ values, status: response.status }).toEqual({
          values,
          status: 422,
        });
      }
    },
  );
});
