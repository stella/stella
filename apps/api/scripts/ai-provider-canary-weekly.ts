import { toolDefinition } from "@tanstack/ai";
import type { Tool } from "@tanstack/ai";
import * as v from "valibot";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";

import type { WeeklyToolShape } from "./ai-provider-canary-config";

export const WEEKLY_TOOL_RESULT = "stella-weekly-tool-round-trip-ok";

const nestedOptionalInputSchema = v.strictObject({
  details: v.strictObject({
    optionalNote: v.optional(v.literal("must-not-be-sent")),
    value: v.literal("stella-weekly"),
  }),
  type: v.literal("nested"),
});

const arrayItemOptionalInputSchema = v.strictObject({
  items: v.array(
    v.strictObject({
      id: v.literal("item-1"),
      optionalLabel: v.optional(v.literal("must-not-be-sent")),
    }),
  ),
  type: v.literal("array"),
});

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
  expectedInput: unknown;
  prompt: string;
  tool: Tool;
};

export const createWeeklyToolShapeDefinition = (
  shape: WeeklyToolShape,
  observedInputs: unknown[],
): WeeklyToolShapeDefinition => {
  switch (shape) {
    case "nested-optional": {
      const name = "canary_weekly_nested_optional";
      return {
        expectedInput: {
          details: { value: "stella-weekly" },
          type: "nested",
        },
        prompt:
          `Call ${name} exactly once with type "nested" and details.value ` +
          '"stella-weekly". Omit details.optionalNote. Then reply with only ' +
          "the confirmation returned by the tool.",
        tool: toolDefinition({
          name,
          description: "Exercise a nested optional tool input.",
          inputSchema: toTanStackToolSchema(nestedOptionalInputSchema),
          outputSchema: toTanStackToolSchema(outputSchema),
        }).server((input) => {
          observedInputs.push(input);
          return { confirmation: WEEKLY_TOOL_RESULT };
        }),
      };
    }
    case "array-item-optional": {
      const name = "canary_weekly_array_item_optional";
      return {
        expectedInput: { items: [{ id: "item-1" }], type: "array" },
        prompt:
          `Call ${name} exactly once with type "array" and one item whose id ` +
          'is "item-1". Omit items[0].optionalLabel. Then reply with only ' +
          "the confirmation returned by the tool.",
        tool: toolDefinition({
          name,
          description: "Exercise an optional field inside an array item.",
          inputSchema: toTanStackToolSchema(arrayItemOptionalInputSchema),
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
        expectedInput: { type: "map", values: { source: "canary" } },
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
        expectedInput: {
          payload: {
            kind: "nullable",
            note: null,
            value: "stella-weekly",
          },
          type: "union",
        },
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
