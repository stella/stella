import { KindGuard, Type } from "@sinclair/typebox";
import { expect, test } from "bun:test";

import { expandSchemaDefs } from "../../../../packages/cli/src/expand-schema-defs";
import type { AdvertisedSchemas } from "../../src/mcp/advertised-schema";
import { buildInputSchema } from "./capability-input-schema";
import { compactSchemaDefs } from "./compact-schema-defs";

const tableLayout = Type.Object({ type: Type.Literal("table") });
const verificationLayout = Type.Object({ type: Type.Literal("avt") });
const body = Type.Object({
  workspaceId: Type.String(),
  layout: Type.Union([tableLayout, verificationLayout]),
});

test("static conditional schemas project canonical inputs before public naming and compaction", () => {
  let projections = 0;
  const inputSchema = buildInputSchema({
    body,
    params: Type.Object({ workspaceId: Type.String() }),
    query: Type.Object({
      pageSize: Type.Union([Type.String({ format: "numeric" }), Type.Number()]),
    }),
    featureAccess: {
      type: "conditional",
      featureId: "list-verification",
      projectInputSchema: (schemas: AdvertisedSchemas) => {
        projections += 1;
        expect(schemas.body).toBe(body);
        if (schemas.body === undefined || !KindGuard.IsObject(schemas.body)) {
          throw new Error("Expected canonical TypeBox body");
        }
        expect(schemas.body.properties["workspaceId"]).toBeDefined();
        return {
          body: Type.Object({
            ...schemas.body.properties,
            layout: tableLayout,
          }),
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
  expect(serialized).not.toContain('"numeric"');
  expect(JSON.stringify(body)).toContain('"avt"');
  expect(JSON.stringify(body)).toContain('"workspaceId"');
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

test("conditional export refuses an invalid canonical schema instead of dropping its fields", () => {
  expect(() =>
    buildInputSchema({
      body: { invalid: true },
      featureAccess: {
        type: "conditional",
        featureId: "list-verification",
        projectInputSchema: (schemas: AdvertisedSchemas) => schemas,
      },
    }),
  ).toThrow("Conditional feature access requires TypeBox input schemas");
});
