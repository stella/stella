import { Result } from "better-result";
import { expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig, propertyTestTimeout } from "@stll/property-testing";

import type { SafeDb } from "@/api/db/safe-db";
import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { validateMessage } from "@/api/handlers/chat/chat-schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";
import { isRecord } from "@/api/lib/type-guards";

const CALL_ID = "call_property_continuation";
const HISTORICAL_CALL_ID = "call_property_historical";
const TOOL_NAME = "suggest_changes";
const OUTPUT = { ok: true };
const ACCEPTED = "accepted";
const REJECTED = "Chat continuation does not match its awaited interaction";
/** Keys the generator may draw, so the forged key below can never collide. */
const INPUT_KEYS = ["alpha", "beta", "gamma", "delta"] as const;
/** Keys a strict provider schema widens to null at every object level. */
const ABSENT_OPTIONAL_KEYS = ["omega", "sigma"] as const;
const FORGED_KEY = "forged";

const noDbReads: SafeDb = async () => {
  throw new Error("This validation path should not read the database");
};
// No input schema: the property is about continuation integrity, not about the
// tool contract, so every generated shape has to reach that check.
const clientTools = {
  [TOOL_NAME]: { name: TOOL_NAME, description: "A client-executed tool" },
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

const continuationOutcome = async ({
  canonicalInput,
  echoedInput,
  echoedArguments = stringifyDifferently(echoedInput),
  historicalToolName = TOOL_NAME,
  tools = clientTools,
}: {
  canonicalInput: Record<string, unknown>;
  echoedInput: Record<string, unknown>;
  echoedArguments?: string;
  historicalToolName?: typeof TOOL_NAME | ExternalToolName;
  tools?: ChatToolMap;
}): Promise<string> => {
  const id = toSafeId<"chatMessage">("msg_property_continuation");
  const persistedContent = chatMessageContentFromMessage(
    toPersistableChatMessage({
      id,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: HISTORICAL_CALL_ID,
          name: historicalToolName,
          arguments: JSON.stringify({ alpha: "history" }),
          input: { alpha: "history" },
          output: OUTPUT,
          state: "complete",
        },
        {
          type: "tool-result",
          toolCallId: HISTORICAL_CALL_ID,
          content: JSON.stringify(OUTPUT),
          state: "complete",
        },
        {
          type: "tool-call",
          id: CALL_ID,
          name: TOOL_NAME,
          arguments: JSON.stringify(canonicalInput),
          input: canonicalInput,
          state: "input-complete",
        },
      ],
    }),
  );
  const result = await validateMessage({
    message: {
      id,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: CALL_ID,
          name: TOOL_NAME,
          arguments: echoedArguments,
          input: echoedInput,
          output: OUTPUT,
          state: "complete",
        },
        {
          type: "tool-result",
          toolCallId: CALL_ID,
          content: JSON.stringify(OUTPUT),
          state: "complete",
        },
      ],
    },
    persistedMessage: { role: "assistant", content: persistedContent },
    resume: [
      {
        interruptId: `client_tool_${CALL_ID}`,
        payload: OUTPUT,
        status: "resolved",
      },
    ],
    safeDb: noDbReads,
    threadId: toSafeId<"chatThread">("thread_property_continuation"),
    tools,
    userId: toSafeId<"user">("user_property_continuation"),
  });
  return Result.isOk(result) ? ACCEPTED : result.error.message;
};

test(
  "a continuation is judged only by the awaited call, not historical snapshot shape",
  async () => {
    await fc.assert(
      fc.asyncProperty(inputArbitrary, async (canonicalInput) => {
        const echoedInput = nullWidenedRecord(canonicalInput);
        expect(await continuationOutcome({ canonicalInput, echoedInput })).toBe(
          ACCEPTED,
        );

        // A key the server never stored is a different call, null-folding or not.
        expect(
          await continuationOutcome({
            canonicalInput,
            echoedInput: { ...echoedInput, [FORGED_KEY]: "x" },
          }),
        ).toBe(REJECTED);

        // So is a changed value at any position: the generator never draws the
        // forged key, so `{ forged: true }` differs from whatever was stored.
        for (const replacedKey of Object.keys(canonicalInput)) {
          expect(
            await continuationOutcome({
              canonicalInput,
              echoedInput: {
                ...echoedInput,
                [replacedKey]: { [FORGED_KEY]: true },
              },
            }),
          ).toBe(REJECTED);
        }
      }),
      propertyConfig({ numRuns: 60 }),
    );
  },
  propertyTestTimeout(15_000),
);

type ExternalToolName = `mcp__${string}`;
// The one open-ended member of the tool-name type, and never in `clientTools`:
// to the validator it is as unknown as a since-renamed built-in.
const unregisteredToolNameArbitrary = fc
  .string({ minLength: 1, maxLength: 24 })
  .map((suffix): ExternalToolName => `mcp__${suffix}`);

// Which tools a request registers moves between two requests (an uninstalled
// skill, a closed feature gate, a renamed tool), so the server's own settled
// calls must never be re-judged against the current set.
test(
  "a settled historical call is accepted whatever tools this request registers",
  async () => {
    await fc.assert(
      fc.asyncProperty(
        inputArbitrary,
        unregisteredToolNameArbitrary,
        async (canonicalInput, historicalToolName) => {
          expect(
            await continuationOutcome({
              canonicalInput,
              echoedInput: nullWidenedRecord(canonicalInput),
              historicalToolName,
            }),
          ).toBe(ACCEPTED);
        },
      ),
      propertyConfig({ numRuns: 60 }),
    );
  },
  propertyTestTimeout(15_000),
);

test("the awaited call the client answers is still judged against the tool set", async () => {
  const canonicalInput = { alpha: "a" };
  expect(
    await continuationOutcome({
      canonicalInput,
      echoedInput: canonicalInput,
      tools: {},
    }),
  ).toBe("Invalid chat message");
});

test("a pathologically nested echo is rejected, not a server fault", async () => {
  const depth = 100_000;
  const canonicalInput = { alpha: "a" };
  let echoedInput: Record<string, unknown> = { alpha: "a" };
  for (let level = 0; level < depth; level += 1) {
    echoedInput = { alpha: echoedInput };
  }
  expect(
    await continuationOutcome({
      canonicalInput,
      echoedInput,
      echoedArguments: `${'{"alpha":'.repeat(depth + 1)}"a"${"}".repeat(depth + 1)}`,
    }),
  ).toBe(REJECTED);
});
