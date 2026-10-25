import { expect, test } from "bun:test";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { expandSchemaDefs } from "../../../../packages/cli/src/expand-schema-defs";
import { toRouteJsonSchema } from "../../src/lib/json-schema/valibot-to-json-schema";
import type { AdvertisedSchemas } from "../../src/mcp/advertised-schema";
import { buildInputSchema } from "./capability-input-schema";
import { compactSchemaDefs } from "./compact-schema-defs";

const tableLayout = v.object({ type: v.literal("table") });
const verificationLayout = v.object({ type: v.literal("avt") });
const body = v.object({
  workspaceId: v.string(),
  layout: v.union([tableLayout, verificationLayout]),
});

test("static conditional schemas project rendered inputs before public naming and compaction", () => {
  let projections = 0;
  const inputSchema = buildInputSchema({
    body,
    params: v.object({ workspaceId: v.string() }),
    query: v.object({ pageSize: numberFromString(v.number()) }),
    featureAccess: {
      type: "conditional",
      featureId: "list-verification",
      projectInputSchema: (schemas: AdvertisedSchemas) => {
        projections += 1;
        // The projection sees the route's own rendering, before any field is
        // given its public name, as a part without a `$schema` dialect.
        const { $schema: _dialect, ...rendered } = toRouteJsonSchema(body);
        expect(schemas.body).toEqual(rendered);
        expect(schemas.body).not.toHaveProperty("$schema");
        const properties = schemas.body?.properties;
        if (properties === undefined) {
          throw new Error("Expected the rendered body's properties");
        }
        expect(properties["workspaceId"]).toBeDefined();
        return {
          body: {
            ...schemas.body,
            properties: {
              ...properties,
              layout: toRouteJsonSchema(tableLayout),
            },
          },
          params: schemas.params,
          query: schemas.query,
        };
      },
    },
  });
  expect(projections).toBe(1);
  const serialized = JSON.stringify(inputSchema);
  expect(serialized).toContain('"matterId"');
  expect(serialized).not.toContain('"workspaceId"');
  expect(serialized).toContain('"table"');
  expect(serialized).not.toContain('"avt"');
  expect(serialized).toContain('"pageSize"');
  // The wire string is shown as the number it carries, not as its pattern.
  expect(JSON.stringify(inputSchema.query)).toContain('"number"');
  expect(serialized).not.toContain('"pattern"');
  expect(JSON.stringify(toRouteJsonSchema(body))).toContain('"avt"');
  expect(JSON.stringify(toRouteJsonSchema(body))).toContain('"workspaceId"');
  const compacted = compactSchemaDefs(inputSchema);
  expect(compacted.status).toBe("compacted");
  if (compacted.status === "compacted") {
    expect(JSON.stringify(expandSchemaDefs(compacted.inputSchema))).toBe(
      serialized,
    );
  }
});

test("required and ordinary schemas retain their declared variants in the static catalog", () => {
  for (const featureAccess of [
    undefined,
    { type: "required", featureId: "list-verification" },
  ]) {
    const serialized = JSON.stringify(
      buildInputSchema({ body, featureAccess }),
    );
    expect(serialized).toContain('"avt"');
    expect(serialized).toContain('"table"');
    expect(serialized).toContain('"matterId"');
  }
});

test("a conditional declaration without its owner projection refuses static export", () => {
  expect(() =>
    buildInputSchema({
      body,
      featureAccess: { type: "conditional", featureId: "list-verification" },
    }),
  ).toThrow("Conditional feature access requires an input schema projection");
});

test("export refuses an input part that is not a schema instead of dropping its fields", () => {
  for (const featureAccess of [
    undefined,
    {
      type: "conditional",
      featureId: "list-verification",
      projectInputSchema: (schemas: AdvertisedSchemas) => schemas,
    },
  ]) {
    expect(() =>
      buildInputSchema({ body: { invalid: true }, featureAccess }),
    ).toThrow("Capability input schemas must be valibot schemas");
  }
});
