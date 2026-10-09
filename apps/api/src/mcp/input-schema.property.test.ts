import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import {
  propertyConfig,
  propertySeed,
  propertyTestTimeout,
} from "@stll/property-testing";

import { isRuntimeOnlyCheckIssue } from "@/api/lib/json-schema/valibot-to-json-schema";
import { isRecord } from "@/api/lib/type-guards";
import { normalizeObjectInputAtBoundary } from "@/api/mcp/input-normalization";
import { plainRecord } from "@/api/mcp/input-schemas";
import { ALL_MCP_TOOL_DEFINITIONS } from "@/api/mcp/static-tool-definitions";
import {
  compileWireSchema,
  createWireSchemaValidator,
  schemaComparisonArbitrary,
} from "@/api/tests/helpers/wire-json-schema";

describe("MCP input contracts", () => {
  const validator = createWireSchemaValidator();

  test("map inputs retain their declared shape", () => {
    const schema = plainRecord(v.unknown());
    fc.assert(
      fc.property(fc.jsonValue(), (input) => {
        const parsed = v.safeParse(schema, input);
        expect(parsed.success).toBe(isRecord(input));
        if (parsed.success && isRecord(input)) {
          expect(parsed.output).toEqual(input);
        }
      }),
      propertyConfig({ numRuns: 100, seed: propertySeed() }),
    );
  });

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
        const property = fc.property(
          schemaComparisonArbitrary([definition.inputSchema]),
          (input) => {
            const parsed = v.safeParse(
              definition.inputSchemaSource.advertisedSchema,
              input,
            );
            // Explicit projection waivers and declared runtime-only checks
            // stay at runtime. Every other rejection must agree with the
            // published schema.
            const onlyWaivedIssues =
              !parsed.success &&
              parsed.issues.every(
                (issue) =>
                  isRuntimeOnlyCheckIssue(issue) ||
                  definition.inputSchemaProjectionWaiver?.ignoreActions.some(
                    (action) => action === issue.type,
                  ),
              );
            expect(acceptsWire(input)).toBe(parsed.success || onlyWaivedIssues);

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
        );
        if (definition.name === "preview_template_conditions") {
          fc.assert(
            property,
            propertyConfig({
              seed: -232_809_522,
              path: "19:0:0:0:0:0:0:0:2",
              numRuns: 1,
              endOnFailure: true,
            }),
          );
        }
        fc.assert(
          property,
          propertyConfig({ numRuns: 20, seed: propertySeed() }),
        );
      },
      propertyTestTimeout(10_000),
    );
  }
});
