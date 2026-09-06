import type { TSchema } from "@sinclair/typebox";
import { describe, expect, test } from "bun:test";
import Elysia, { t } from "elysia";

import fillTemplateById from "@/api/handlers/templates/fill-by-id";
import fillTemplatePreview from "@/api/handlers/templates/fill-preview";
import fillTemplateToWorkspace from "@/api/handlers/templates/fill-to-workspace";

const invalidValues = [
  "arbitrary string",
  42,
  false,
  '{"client.name":"Ada"}',
  null,
  [],
];

const storedFillSchemas = [
  ["fill-by-id", fillTemplateById.config.body],
  ["fill-preview", fillTemplatePreview.config.body],
  ["fill-to-matter", fillTemplateToWorkspace.config.body],
] as const;

const recordOnlySchema = t.Object({
  values: t.Record(t.String(), t.Unknown()),
});

const validateBody = async (body: unknown, schema: TSchema) => {
  const app = new Elysia().post(
    "/fill",
    ({ body: submitted }) => {
      if (typeof submitted !== "object" || submitted === null) {
        return new Response(null, { status: 500 });
      }
      if (!("values" in submitted)) {
        return new Response(null, { status: 500 });
      }
      return Response.json(submitted.values);
    },
    { body: schema },
  );
  return await app.handle(
    new Request("https://example.test/fill", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
};

describe("stored-template fill value boundaries", () => {
  test("Elysia accepts scalar values for a bare record schema", async () => {
    for (const values of invalidValues) {
      const response = await validateBody({ values }, recordOnlySchema);
      expect(response.status).toBe(values === null ? 422 : 200);
    }
  });

  test.each(storedFillSchemas)(
    "%s preserves nested values",
    async (_name, schema) => {
      const values = {
        "client.name": { display: "Ada" },
        signatories: [{ name: "Ada" }],
      };
      const response = await validateBody({ values }, schema);

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(values);
    },
  );

  test.each(storedFillSchemas)(
    "%s rejects every non-object values form",
    async (_name, schema) => {
      for (const values of invalidValues) {
        const response = await validateBody({ values }, schema);
        expect(response.status).toBe(422);
      }
    },
  );
});
