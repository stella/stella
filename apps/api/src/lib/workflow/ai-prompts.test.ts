import { describe, expect, spyOn, test } from "bun:test";
import * as v from "valibot";

import { toSafeId } from "@/api/lib/branded-types";
import { logger } from "@/api/lib/observability/logger";
import {
  buildBatchSchema,
  buildDocxBlocksMessage,
  DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS,
  PROMPT_INPUT_TRUNCATED_EVENT,
  PROMPT_TRUNCATION_MARKER,
} from "@/api/lib/workflow/ai-prompts";
import type { BatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { JustificationFilenames } from "@/api/lib/workflow/parse-justifications";

const noFilenames: JustificationFilenames = [];

const aiModelTool = {
  version: 1 as const,
  type: "ai-model" as const,
  prompt: "test",
};

const textProperty: BatchProperty = {
  id: toSafeId<"property">("prop-text"),
  status: "stale",
  content: { version: 1, type: "text" },
  dependencies: [],
  tool: aiModelTool,
};

const intProperty: BatchProperty = {
  id: toSafeId<"property">("prop-int"),
  status: "stale",
  content: { version: 1, type: "int" },
  dependencies: [],
  tool: aiModelTool,
};

const selectProperty: BatchProperty = {
  id: toSafeId<"property">("prop-select"),
  status: "stale",
  content: {
    version: 1,
    type: "single-select",
    options: [
      { color: "red", value: "Yes" },
      { color: "green", value: "No" },
    ],
    fallback: null,
  },
  dependencies: [],
  tool: aiModelTool,
};

const multiSelectProperty: BatchProperty = {
  id: toSafeId<"property">("prop-multi"),
  status: "stale",
  content: {
    version: 1,
    type: "multi-select",
    options: [
      { color: "red", value: "A" },
      { color: "green", value: "B" },
    ],
    fallback: null,
  },
  dependencies: [],
  tool: aiModelTool,
};

describe("buildBatchSchema — absent answers", () => {
  test("accepts a null answer for a text property", () => {
    const schema = buildBatchSchema([textProperty], noFilenames);
    const output = v.parse(schema, {
      [textProperty.id]: { answer: null, justification: [] },
    });
    expect(output[textProperty.id]?.answer).toBeNull();
  });

  test("accepts a null answer for an int property", () => {
    const schema = buildBatchSchema([intProperty], noFilenames);
    const output = v.parse(schema, {
      [intProperty.id]: { answer: null, justification: [] },
    });
    expect(output[intProperty.id]?.answer).toBeNull();
  });

  test("still accepts a real amount for an int property", () => {
    const schema = buildBatchSchema([intProperty], noFilenames);
    const output = v.parse(schema, {
      [intProperty.id]: {
        answer: { amount: 1500, currency: "USD" },
        justification: [],
      },
    });
    expect(output[intProperty.id]?.answer).toEqual({
      amount: 1500,
      currency: "USD",
    });
  });
});

describe("buildBatchSchema — select answers pass through for downstream validation", () => {
  // The picklist is guidance in the description, not a JSON Schema enum: an
  // out-of-picklist answer must reach `validateAIOutput` as a visible
  // validation error, so parsing it here must not throw and must not
  // silently rewrite it to null (see ai-validators.test.ts for the
  // validation-error assertion).
  test("does not reject or null out an out-of-picklist single-select answer", () => {
    const schema = buildBatchSchema([selectProperty], noFilenames);
    const output = v.parse(schema, {
      [selectProperty.id]: { answer: "Maybe", justification: [] },
    });
    expect(output[selectProperty.id]?.answer).toBe("Maybe");
  });

  test("does not reject or null out an out-of-picklist multi-select answer", () => {
    const schema = buildBatchSchema([multiSelectProperty], noFilenames);
    const output = v.parse(schema, {
      [multiSelectProperty.id]: { answer: ["A", "Z"], justification: [] },
    });
    expect(output[multiSelectProperty.id]?.answer).toEqual(["A", "Z"]);
  });
});

describe("buildDocxBlocksMessage", () => {
  const messageFor = (text: string) =>
    buildDocxBlocksMessage({
      simplifiedName: "F0",
      blocks: [
        {
          id: "b1",
          kind: "paragraph",
          statedNumbering: { kind: "inherit" },
          text,
        },
      ],
    });

  test("keeps a term at the end of a long paragraph", () => {
    const clause = `${"Supplier shall provide the services. ".repeat(200)}Either party may terminate on 90 days' notice.`;

    expect(messageFor(clause)).toContain(JSON.stringify(clause));
  });

  test("cuts only a paragraph above the guard, and marks the cut", () => {
    const longest = "a".repeat(DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS);
    const kept =
      DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS - PROMPT_TRUNCATION_MARKER.length;

    expect(messageFor(longest)).toContain(JSON.stringify(longest));
    expect(messageFor(`${longest}a`)).toContain(
      JSON.stringify(`${"a".repeat(kept)}${PROMPT_TRUNCATION_MARKER}`),
    );
  });

  describe("records a cut", () => {
    test("counts each cut block and the characters it dropped", () => {
      const logInfo = spyOn(logger, "info").mockImplementation(() => {});
      try {
        const over = DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS + 10;

        buildDocxBlocksMessage({
          simplifiedName: "F0",
          blocks: [
            {
              id: "b1",
              kind: "paragraph",
              statedNumbering: { kind: "inherit" },
              text: "a".repeat(over),
            },
            {
              id: "b2",
              kind: "paragraph",
              statedNumbering: { kind: "inherit" },
              text: "short",
            },
          ],
        });

        expect(logInfo).toHaveBeenCalledTimes(1);
        expect(logInfo).toHaveBeenCalledWith(PROMPT_INPUT_TRUNCATED_EVENT, {
          input: "docx_blocks",
          truncated_parts: "1",
          dropped_chars: String(
            over -
              (DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS -
                PROMPT_TRUNCATION_MARKER.length),
          ),
          max_chars: String(DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS),
        });
      } finally {
        logInfo.mockRestore();
      }
    });

    test("records nothing when every block fits", () => {
      const logInfo = spyOn(logger, "info").mockImplementation(() => {});
      try {
        messageFor("a".repeat(DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS));

        expect(logInfo).not.toHaveBeenCalled();
      } finally {
        logInfo.mockRestore();
      }
    });
  });
});
