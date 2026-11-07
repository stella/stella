import { describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import { toJsonSchema } from "@/api/lib/json-schema/valibot-to-json-schema";
import { logger } from "@/api/lib/observability/logger";
import { answerSchemaForContent } from "@/api/lib/workflow/ai-answer-schema";
import type { AnswerShape } from "@/api/lib/workflow/ai-answer-schema";
import {
  buildBatchSchema,
  buildDocxBlocksMessage,
  DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS,
  encodeDocxBlockLine,
  PROMPT_INPUT_TRUNCATED_EVENT,
  PROMPT_TRUNCATION_MARKER,
} from "@/api/lib/workflow/ai-prompts";
import type { AIBatchProperty } from "@/api/lib/workflow/get-execution-plan";
import type { JustificationFilenames } from "@/api/lib/workflow/parse-justifications";

const noFilenames: JustificationFilenames = [];

const aiModelTool = {
  version: 1 as const,
  type: "ai-model" as const,
  prompt: "test",
};

const textProperty: AIBatchProperty = {
  id: toSafeId<"property">("prop-text"),
  status: "stale",
  answerShape: "value",
  content: { version: 1, type: "text" },
  dependencies: [],
  tool: aiModelTool,
};

const intProperty: AIBatchProperty = {
  id: toSafeId<"property">("prop-int"),
  status: "stale",
  answerShape: "value",
  content: { version: 1, type: "int" },
  dependencies: [],
  tool: aiModelTool,
};

const selectProperty: AIBatchProperty = {
  id: toSafeId<"property">("prop-select"),
  status: "stale",
  answerShape: "value",
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

const multiSelectProperty: AIBatchProperty = {
  id: toSafeId<"property">("prop-multi"),
  status: "stale",
  answerShape: "value",
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

describe("buildBatchSchema — text answer length", () => {
  test("the length limit gives way when the prompt asks for quoted wording", () => {
    expect(answerSchemaForContent(textProperty.content)).toMatchObject({
      pipe: expect.arrayContaining([
        expect.objectContaining({
          description: expect.stringMatching(
            /less than 100 characters, unless the prompt asks for the source's wording to be quoted/u,
          ),
        }),
      ]),
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

    expect(messageFor(clause)).toContain(clause);
  });

  test("cuts only a paragraph above the guard, and marks the cut", () => {
    const longest = "a".repeat(DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS);
    const kept =
      DOCX_PROMPT_BLOCK_TEXT_MAX_CHARS - PROMPT_TRUNCATION_MARKER.length;

    expect(messageFor(longest)).toContain(longest);
    expect(messageFor(`${longest}a`)).toContain(
      `${"a".repeat(kept)}${PROMPT_TRUNCATION_MARKER.replaceAll("\n", "\\n")}`,
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

describe("buildBatchSchema — answer shapes", () => {
  const docxFilenames: JustificationFilenames = [
    {
      kind: "docx-folio",
      original: "file",
      simplified: "F0",
      fileFieldId: toSafeId<"field">("file_field"),
      blocksById: new Map([["b1", "A clause."]]),
    },
  ];
  const withShape = (answerShape: AnswerShape): AIBatchProperty => ({
    ...textProperty,
    answerShape,
  });
  const propertySchema = (property: AIBatchProperty) =>
    JSON.stringify(toJsonSchema(buildBatchSchema([property], docxFilenames)));

  test("a clause summary asks for a short answer and for every term's block", () => {
    const schema = propertySchema(withShape("clause-summary"));
    expect(schema).toContain("less than 100 characters");
    expect(schema).toContain("Cite every block");
    expect(schema).not.toContain("verbatim and in full");
  });

  test("a clause quote asks for the wording and keeps the ordinary citations", () => {
    const schema = propertySchema(withShape("clause-quote"));
    expect(schema).toContain("verbatim and in full");
    expect(schema).not.toContain("Cite every block");
  });

  test("a value answer has no clause instructions", () => {
    const schema = propertySchema(withShape("value"));
    expect(schema).not.toContain("Cite every block");
    expect(schema).not.toContain("A reviewer reads");
    expect(schema).not.toContain("every term the question covers");
  });

  test("a non-text clause answer keeps its type and still cites every term", () => {
    const schema = propertySchema({
      ...intProperty,
      answerShape: "clause-summary",
    });
    expect(schema).toContain('"amount"');
    expect(schema).toContain("Cite every block");
  });
});

describe("encodeDocxBlockLine", () => {
  const decodeField = (field: string): string =>
    field.replace(/\\(u[0-9a-f]{4}|.)/gu, (_, code: string) => {
      switch (code) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "\\":
          return "\\";
        default:
          return String.fromCodePoint(Number.parseInt(code.slice(1), 16));
      }
    });

  const anyText = fc.string({
    unit: fc.constantFrom(
      ..."ab \\\n\r\t\v\f\u0085\u2028\u2029un0".split(""),
      "<ins>",
      '"',
    ),
  });

  test("any block is one line and gives back its id and text", () => {
    assertProperty(
      "docx-block-line/one-line-round-trip",
      fc.property(anyText, anyText, (id, text) => {
        const line = encodeDocxBlockLine({
          id,
          kind: "paragraph",
          statedNumbering: { kind: "inherit" },
          text,
        });
        expect(line.split(/\r\n|[\n\r\v\f\u0085\u2028\u2029]/u)).toHaveLength(
          1,
        );
        const fields = line.split("\t");
        expect(fields).toHaveLength(5);
        expect(decodeField(fields[0] ?? "")).toBe(id);
        expect(decodeField(fields[4] ?? "")).toBe(text);
      }),
    );
  });

  test("the same block always encodes to the same bytes", () => {
    const block = {
      id: "1A2B3C4D",
      kind: "paragraph",
      statedNumbering: { kind: "inherit" },
      text: "Line one\nLine two",
      displayLabel: "4.1",
      styleId: "Heading2",
    } as const;
    expect(encodeDocxBlockLine(block)).toBe(
      "1A2B3C4D\tparagraph\t4.1\tHeading2\tLine one\\nLine two",
    );
    expect(encodeDocxBlockLine(block)).toBe(encodeDocxBlockLine(block));
  });

  test("review tags stay in the text", () => {
    const text = '<ins author="A">new</ins> and <del author="B">old</del>';
    expect(
      encodeDocxBlockLine({
        id: "b1",
        kind: "paragraph",
        statedNumbering: { kind: "inherit" },
        text,
      }),
    ).toEndWith(text);
  });
});
