import { Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import { validateToolCallParts } from "@/api/handlers/chat/chat-schema";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { isRecord } from "@/api/lib/type-guards";

const CALL_ID = "call_property_tool_call";
// A registered chat tool name, since the map's keys are that union; the
// contract under test is the one declared below, not that tool's.
const TOOL_NAME = "suggest_changes";
const ACCEPTED = "accepted";
/** Keys the generator may draw, so the forged key below can never collide. */
const INPUT_KEYS = ["alpha", "beta", "gamma", "delta"] as const;
/** Optional keys a strict provider schema widens to null at every level. */
const ABSENT_OPTIONAL_KEYS = ["omega", "sigma"] as const;
const FORGED_KEY = "forged";

/**
 * The tool contract declares the optionals a strict provider widens. It is
 * loose about the generated keys so every drawn shape reaches the schema, and
 * the null it rejects is the top-level `omega`/`sigma` the widening writes.
 */
const tools = {
  [TOOL_NAME]: {
    name: TOOL_NAME,
    description: "A tool with optional fields",
    inputSchema: toTanStackToolSchema(
      v.looseObject({
        omega: v.optional(v.string()),
        sigma: v.optional(v.string()),
      }),
    ),
  },
} satisfies ChatToolMap;

const leafArbitrary = fc.oneof(
  fc.string({ maxLength: 8 }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.boolean(),
);
const keyArbitrary = fc.constantFrom(...INPUT_KEYS);
const nestedRecordArbitrary = fc.dictionary(
  keyArbitrary,
  fc.oneof(leafArbitrary, fc.array(leafArbitrary, { maxLength: 3 })),
  { maxKeys: 3 },
);
const inputArbitrary = fc.dictionary(
  keyArbitrary,
  fc.oneof(
    leafArbitrary,
    nestedRecordArbitrary,
    fc.array(fc.oneof(leafArbitrary, nestedRecordArbitrary), { maxLength: 3 }),
  ),
  { minKeys: 1, maxKeys: 4 },
);

const withNullWidenedOptionals = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => withNullWidenedOptionals(entry));
  }
  return isRecord(value) ? nullWidenedRecord(value) : value;
};

/** What a strict provider schema streams: absent optionals spelled as null. */
const nullWidenedRecord = (
  value: Record<string, unknown>,
): Record<string, unknown> => {
  const widened: Record<string, unknown> = {};
  for (const key of ABSENT_OPTIONAL_KEYS) {
    widened[key] = null;
  }
  for (const [key, entry] of Object.entries(value)) {
    widened[key] = withNullWidenedOptionals(entry);
  }
  return widened;
};

/** A different serialization of the same value: reversed keys, indented. */
const stringifyDifferently = (value: unknown): string =>
  JSON.stringify(
    value,
    (_key, entry: unknown) =>
      isRecord(entry)
        ? Object.fromEntries(Object.entries(entry).toReversed())
        : entry,
    2,
  );

type ToolCallOutcome =
  | { outcome: typeof ACCEPTED; persisted: unknown }
  | { outcome: string };

/** Validate one server-authored call: the provider text plus the adapter's input. */
const toolCallOutcome = ({
  argumentsText,
  input,
}: {
  argumentsText: string;
  input?: unknown;
}): ToolCallOutcome => {
  const result = validateToolCallParts({
    message: {
      id: toSafeId<"chatMessage">("msg_property_tool_call"),
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: CALL_ID,
          name: TOOL_NAME,
          arguments: argumentsText,
          ...(input === undefined ? {} : { input }),
          state: "input-complete",
        },
      ],
    },
    tools,
  });
  return Result.isOk(result)
    ? { outcome: ACCEPTED, persisted: result.value.at(0) }
    : { outcome: result.error.message };
};

test(
  "a strict provider's null-widened text is the call its folded input describes",
  () => {
    fc.assert(
      fc.property(inputArbitrary, (input) => {
        const widenedText = stringifyDifferently(nullWidenedRecord(input));

        // With the adapter's folded input the call is accepted, and one
        // spelling is persisted: that input and the text derived from it.
        expect(toolCallOutcome({ argumentsText: widenedText, input })).toEqual({
          outcome: ACCEPTED,
          persisted: {
            type: "tool-call",
            id: CALL_ID,
            name: TOOL_NAME,
            arguments: JSON.stringify(input),
            input,
            state: "input-complete",
          },
        });

        // The text alone is folded the same way, so a part with no `input`
        // persists the same call (the text's key order is its own).
        const textOnly = toolCallOutcome({ argumentsText: widenedText });
        const persistedText =
          "persisted" in textOnly &&
          isRecord(textOnly.persisted) &&
          typeof textOnly.persisted["arguments"] === "string"
            ? textOnly.persisted["arguments"]
            : "";
        expect(textOnly).toMatchObject({
          outcome: ACCEPTED,
          persisted: { input, state: "input-complete" },
        });
        expect(JSON.parse(persistedText)).toEqual(input);

        // Folding nulls never admits a different call: a key the adapter never
        // parsed, or a changed value at any position.
        const mismatch = `Chat tool input does not match arguments for ${TOOL_NAME}`;
        expect(
          toolCallOutcome({
            argumentsText: stringifyDifferently({
              ...nullWidenedRecord(input),
              [FORGED_KEY]: "x",
            }),
            input,
          }).outcome,
        ).toBe(mismatch);
        for (const replacedKey of Object.keys(input)) {
          expect(
            toolCallOutcome({
              argumentsText: stringifyDifferently({
                ...nullWidenedRecord(input),
                [replacedKey]: { [FORGED_KEY]: true },
              }),
              input,
            }).outcome,
          ).toBe(mismatch);
        }
      }),
      propertyConfig({ numRuns: 60 }),
    );
  },
  propertyTestTimeout(15_000),
);
