import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import { isRecord } from "@/api/lib/type-guards";
import { normalizeObjectInputAtBoundary } from "@/api/mcp/input-normalization";
import { ALL_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import {
  compileWireSchema,
  createWireSchemaValidator,
  schemaComparisonArbitrary,
} from "@/api/tests/helpers/wire-json-schema";

describe("MCP input contracts", () => {
  const validator = createWireSchemaValidator();

  for (const [index, definition] of ALL_MCP_TOOL_DEFINITIONS.entries()) {
    test(
      `${index}: ${definition.name} wire and runtime acceptance agree`,
      () => {
        expect("inputSchemaSource" in definition).toBe(true);
        if (!("inputSchemaSource" in definition)) {
          return;
        }
        const acceptsWire = compileWireSchema(
          validator,
          definition.inputSchema,
        );
        fc.assert(
          fc.property(
            schemaComparisonArbitrary([definition.inputSchema]),
            (input) => {
              const parsed = v.safeParse(
                definition.inputSchemaSource.advertisedSchema,
                input,
              );
              // Explicit projection waivers leave semantic checks at runtime.
              // Every other rejection must agree with the published schema.
              const onlyWaivedIssues =
                !parsed.success &&
                parsed.issues.every((issue) =>
                  definition.inputSchemaProjectionWaiver?.ignoreActions.some(
                    (action) => action === issue.type,
                  ),
                );
              expect(acceptsWire(input)).toBe(
                parsed.success || onlyWaivedIssues,
              );

              if (!isRecord(input)) {
                return;
              }
              const unknownKey = "__schema_property_unknown__";
              expect(definition.inputSchema.properties).not.toHaveProperty(
                unknownKey,
              );
              const normalized = normalizeObjectInputAtBoundary({
                access: definition.access,
                schema: definition.inputSchema,
                value: { ...input, [unknownKey]: true },
              });
              if (!normalized.ok) {
                return;
              }
              expect(normalized.value[unknownKey]).toBe(true);
              expect(acceptsWire(normalized.value)).toBe(false);
              expect(
                v.safeParse(definition.inputSchemaSource, normalized.value)
                  .success,
              ).toBe(false);
            },
          ),
          propertyConfig({ numRuns: 20 }),
        );
      },
      propertyTestTimeout(10_000),
    );
  }
});
