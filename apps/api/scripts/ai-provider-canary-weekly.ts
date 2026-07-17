import { toolDefinition } from "@tanstack/ai";
import type { Tool } from "@tanstack/ai";
import * as v from "valibot";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";

// Reused rather than duplicated: same allow-list and impossible-match
// pattern the daily round-trip probe uses to make the omission-vs-null
// duality deterministic (see ai-provider-canary.ts, #1194/#1196).
import {
  NEVER_MATCH_PATTERN,
  NULL_WIDENING_CANARY_PROVIDERS,
} from "./ai-provider-canary-config";
import type {
  CanaryProvider,
  WeeklyToolShape,
} from "./ai-provider-canary-config";

export const WEEKLY_TOOL_RESULT = "stella-weekly-tool-round-trip-ok";

// Mistral rejects `pattern` in strict tool schemas (see the flat round-trip
// probe's MISTRAL_TOOL_ROUND_TRIP_JSON_SCHEMA). Mirror the same workaround
// here: an empty string enum is the deterministic omission marker instead of
// an impossible regex.
const NESTED_OPTIONAL_MISTRAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    details: {
      type: "object",
      properties: {
        optionalNote: { type: "string", enum: [] },
        value: { type: "string", enum: ["stella-weekly"] },
      },
      required: ["value"],
      additionalProperties: false,
    },
    type: { type: "string", enum: ["nested"] },
  },
  required: ["details", "type"],
  additionalProperties: false,
} as const;

const ARRAY_ITEM_OPTIONAL_MISTRAL_JSON_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string", enum: ["item-1"] },
          optionalLabel: { type: "string", enum: [] },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    type: { type: "string", enum: ["array"] },
  },
  required: ["items", "type"],
  additionalProperties: false,
} as const;

// Same duality the flat round-trip probe uses: null-widening providers are
// asked to set the field to the synthetic null their strict mode forces,
// everyone else is asked to omit it outright.
const fieldOmissionInstruction = (
  provider: CanaryProvider,
  fieldPath: string,
): string =>
  NULL_WIDENING_CANARY_PROVIDERS.has(provider)
    ? `Set ${fieldPath} to null.`
    : `Omit ${fieldPath}.`;

const openMapInputSchema = v.strictObject({
  type: v.literal("map"),
  values: v.record(v.string(), v.literal("canary")),
});

const discriminatedUnionInputSchema = v.strictObject({
  payload: v.variant("kind", [
    v.strictObject({
      kind: v.literal("optional"),
      note: v.optional(v.literal("must-not-be-sent")),
      value: v.literal("stella-weekly"),
    }),
    v.strictObject({
      kind: v.literal("nullable"),
      note: v.nullable(v.literal("must-not-be-sent")),
      value: v.literal("stella-weekly"),
    }),
  ]),
  type: v.literal("union"),
});

const outputSchema = v.strictObject({
  confirmation: v.literal(WEEKLY_TOOL_RESULT),
});

export type WeeklyToolShapeDefinition = {
  expectedInputs: unknown[];
  prompt: string;
  tool: Tool;
};

export const createWeeklyToolShapeDefinition = (
  shape: WeeklyToolShape,
  provider: CanaryProvider,
  observedInputs: unknown[],
): WeeklyToolShapeDefinition => {
  switch (shape) {
    case "nested-optional": {
      const name = "canary_weekly_nested_optional";
      const isNullWidening = NULL_WIDENING_CANARY_PROVIDERS.has(provider);
      const nestedOptionalInputSchema = v.strictObject({
        details: v.strictObject({
          optionalNote: v.optional(
            v.pipe(v.string(), v.regex(NEVER_MATCH_PATTERN)),
          ),
          value: v.literal("stella-weekly"),
        }),
        type: v.literal("nested"),
      });
      const nestedOptionalStandardSchema = toTanStackToolSchema(
        nestedOptionalInputSchema,
      );
      const inputSchema =
        provider === "mistral"
          ? {
              ...nestedOptionalStandardSchema,
              "~standard": {
                ...nestedOptionalStandardSchema["~standard"],
                jsonSchema: {
                  ...nestedOptionalStandardSchema["~standard"].jsonSchema,
                  input: () => NESTED_OPTIONAL_MISTRAL_JSON_SCHEMA,
                },
              },
            }
          : nestedOptionalStandardSchema;
      const expectedInputs: unknown[] = [
        { details: { value: "stella-weekly" }, type: "nested" },
      ];
      if (isNullWidening) {
        expectedInputs.push({
          details: { optionalNote: null, value: "stella-weekly" },
          type: "nested",
        });
      }

      return {
        expectedInputs,
        prompt:
          `Call ${name} exactly once with type "nested" and details.value ` +
          `"stella-weekly". ${fieldOmissionInstruction(provider, "details.optionalNote")} ` +
          "Then reply with only the confirmation returned by the tool.",
        tool: toolDefinition({
          name,
          description: "Exercise a nested optional tool input.",
          inputSchema,
          outputSchema: toTanStackToolSchema(outputSchema),
        }).server((input) => {
          observedInputs.push(input);
          return { confirmation: WEEKLY_TOOL_RESULT };
        }),
      };
    }
    case "array-item-optional": {
      const name = "canary_weekly_array_item_optional";
      const isNullWidening = NULL_WIDENING_CANARY_PROVIDERS.has(provider);
      const arrayItemOptionalInputSchema = v.strictObject({
        items: v.array(
          v.strictObject({
            id: v.literal("item-1"),
            optionalLabel: v.optional(
              v.pipe(v.string(), v.regex(NEVER_MATCH_PATTERN)),
            ),
          }),
        ),
        type: v.literal("array"),
      });
      const arrayItemOptionalStandardSchema = toTanStackToolSchema(
        arrayItemOptionalInputSchema,
      );
      const inputSchema =
        provider === "mistral"
          ? {
              ...arrayItemOptionalStandardSchema,
              "~standard": {
                ...arrayItemOptionalStandardSchema["~standard"],
                jsonSchema: {
                  ...arrayItemOptionalStandardSchema["~standard"].jsonSchema,
                  input: () => ARRAY_ITEM_OPTIONAL_MISTRAL_JSON_SCHEMA,
                },
              },
            }
          : arrayItemOptionalStandardSchema;
      const expectedInputs: unknown[] = [
        { items: [{ id: "item-1" }], type: "array" },
      ];
      if (isNullWidening) {
        expectedInputs.push({
          items: [{ id: "item-1", optionalLabel: null }],
          type: "array",
        });
      }

      return {
        expectedInputs,
        prompt:
          `Call ${name} exactly once with type "array" and one item whose id ` +
          `is "item-1". ${fieldOmissionInstruction(provider, "items[0].optionalLabel")} ` +
          "Then reply with only the confirmation returned by the tool.",
        tool: toolDefinition({
          name,
          description: "Exercise an optional field inside an array item.",
          inputSchema,
          outputSchema: toTanStackToolSchema(outputSchema),
        }).server((input) => {
          observedInputs.push(input);
          return { confirmation: WEEKLY_TOOL_RESULT };
        }),
      };
    }
    case "open-map": {
      const name = "canary_weekly_open_map";
      return {
        expectedInputs: [{ type: "map", values: { source: "canary" } }],
        prompt:
          `Call ${name} exactly once with type "map" and values containing ` +
          'only source="canary". Then reply with only the confirmation ' +
          "returned by the tool.",
        tool: toolDefinition({
          name,
          description: "Exercise a free-form map tool input.",
          inputSchema: toTanStackToolSchema(openMapInputSchema),
          outputSchema: toTanStackToolSchema(outputSchema),
        }).server((input) => {
          observedInputs.push(input);
          return { confirmation: WEEKLY_TOOL_RESULT };
        }),
      };
    }
    case "discriminated-union": {
      const name = "canary_weekly_discriminated_union";
      return {
        expectedInputs: [
          {
            payload: {
              kind: "nullable",
              note: null,
              value: "stella-weekly",
            },
            type: "union",
          },
        ],
        prompt:
          `Call ${name} exactly once with type "union" and payload kind ` +
          '"nullable", value "stella-weekly", and note null. Then reply with ' +
          "only the confirmation returned by the tool.",
        tool: toolDefinition({
          name,
          description: "Exercise genuine nullability in a union branch.",
          inputSchema: toTanStackToolSchema(discriminatedUnionInputSchema),
          outputSchema: toTanStackToolSchema(outputSchema),
        }).server((input) => {
          observedInputs.push(input);
          return { confirmation: WEEKLY_TOOL_RESULT };
        }),
      };
    }
    default: {
      const _exhaustive: never = shape;
      return _exhaustive;
    }
  }
};
