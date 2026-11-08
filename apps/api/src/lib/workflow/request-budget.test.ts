import { Result } from "better-result";
import { describe, expect, spyOn, test } from "bun:test";
import fc from "fast-check";

import type { FolioAIBlock } from "@stll/folio-core/server";
import { assertProperty } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import { DocumentTooLargeError } from "@/api/lib/errors/tagged-errors";
import { logger } from "@/api/lib/observability/logger";
import { sanitizeForPrompt, untrustedText } from "@/api/lib/prompt-safety";
import {
  buildDocxBlocksMessage,
  buildExtractedFileMessage,
} from "@/api/lib/workflow/ai-prompts";
import type {
  PreparedDocxFile,
  PreparedInputFile,
} from "@/api/lib/workflow/generate-batch";
import {
  fitDocxFilesToRequestBudget,
  fitFilesToRequestBudget,
  logRequestFit,
  PROMPT_INPUT_TRUNCATED_EVENT,
  requestBudgetBytes,
} from "@/api/lib/workflow/request-budget";
import { PDF_MIME_TYPE } from "@/api/mime-types";

const block = (id: string, text: string): FolioAIBlock => ({
  id,
  kind: "paragraph",
  statedNumbering: { kind: "inherit" },
  text,
});

const docx = (index: number, texts: readonly string[]): PreparedDocxFile => ({
  kind: "docx",
  fileFieldId: toSafeId<"field">(`field-${String(index)}`),
  fileId: `file-${String(index)}`,
  simplifiedName: `F${String(index)}`,
  blocks: texts.map((text, position) =>
    block(`seq-${String(index)}-${String(position)}`, text),
  ),
});

const fileMessage = (file: PreparedInputFile): string => {
  switch (file.kind) {
    case "docx":
      return buildDocxBlocksMessage({
        simplifiedName: file.simplifiedName,
        blocks: file.blocks,
      });
    case "extracted-text":
      return buildExtractedFileMessage({
        simplifiedName: file.simplifiedName,
        content: sanitizeForPrompt(untrustedText(file.content)),
      });
    case "pdf":
      return "";
    default:
      file satisfies never;
      return "";
  }
};

const promptBytes = (files: readonly PreparedInputFile[]): number => {
  let total = 0;
  for (const file of files) {
    total += Buffer.byteLength(fileMessage(file));
  }
  return total;
};

// Each script has a different bytes-to-characters ratio, and quotes and
// newlines grow under JSON escaping, so the budget must hold for all of them.
const paragraph = fc.oneof(
  fc.string({ maxLength: 4000 }),
  fc.string({ maxLength: 2000, unit: "binary" }),
  fc.string({ maxLength: 2000, unit: fc.constantFrom("契", "約", "条") }),
  fc.string({ maxLength: 2000, unit: fc.constantFrom("ع", "ق", "د") }),
  fc.string({ maxLength: 1000, unit: fc.constantFrom("😀", "𠮷") }),
  fc.string({ maxLength: 2000, unit: fc.constantFrom('"', "\\", "\n", "\t") }),
  fc.constantFrom("x".repeat(30_000), "é".repeat(20_000)),
);

const documents = fc.array(fc.array(paragraph, { maxLength: 30 }), {
  minLength: 1,
  maxLength: 4,
});

const budget = fc.integer({ min: 2000, max: 300_000 });

describe("fitting documents to a request budget", () => {
  test("output never exceeds the budget", () => {
    assertProperty(
      "output never exceeds the budget",
      fc.property(documents, budget, (texts, budgetBytes) => {
        const fit = fitFilesToRequestBudget({
          files: texts.map((blocks, index) => docx(index, blocks)),
          budgetBytes,
        });
        if (Result.isOk(fit)) {
          expect(promptBytes(fit.value.files)).toBeLessThanOrEqual(budgetBytes);
        }
      }),
    );
  });

  test("files within budget come back untouched", () => {
    assertProperty(
      "files within budget come back untouched",
      fc.property(documents, (texts) => {
        const files = texts.map((blocks, index) => docx(index, blocks));
        const fit = fitFilesToRequestBudget({
          files,
          budgetBytes: Number.MAX_SAFE_INTEGER,
        });

        expect(Result.isOk(fit) && fit.value.type).toBe("whole");
        expect(Result.isOk(fit) && fit.value.files).toEqual(files);
      }),
    );
  });

  test("every block id survives", () => {
    assertProperty(
      "every block id survives",
      fc.property(documents, budget, (texts, budgetBytes) => {
        const files = texts.map((blocks, index) => docx(index, blocks));
        const fit = fitDocxFilesToRequestBudget({ files, budgetBytes });
        if (Result.isOk(fit)) {
          expect(
            fit.value.files.map((file) => file.blocks.map(({ id }) => id)),
          ).toEqual(files.map((file) => file.blocks.map(({ id }) => id)));
        }
      }),
    );
  });

  test("the same input gives the same bytes", () => {
    assertProperty(
      "the same input gives the same bytes",
      fc.property(documents, budget, (texts, budgetBytes) => {
        const files = texts.map((blocks, index) => docx(index, blocks));

        expect(fitFilesToRequestBudget({ files, budgetBytes })).toEqual(
          fitFilesToRequestBudget({ files, budgetBytes }),
        );
      }),
    );
  });

  test("a cut never withholds more than half of the characters", () => {
    assertProperty(
      "a cut never withholds more than half of the characters",
      fc.property(documents, budget, (texts, budgetBytes) => {
        const fit = fitFilesToRequestBudget({
          files: texts.map((blocks, index) => docx(index, blocks)),
          budgetBytes,
        });
        if (Result.isError(fit) || fit.value.type === "whole") {
          return;
        }
        const characters = texts
          .flat()
          .reduce((total, text) => total + Array.from(text).length, 0);
        const withheld = fit.value.withheld.reduce(
          (total, source) => total + source.charactersWithheld,
          0,
        );
        expect(withheld).toBeLessThanOrEqual(characters / 2);
      }),
    );
  });

  test("a short block is never cut while a longer one keeps more", () => {
    assertProperty(
      "a short block is never cut while a longer one keeps more",
      fc.property(documents, budget, (texts, budgetBytes) => {
        const files = texts.map((blocks, index) => docx(index, blocks));
        const fit = fitDocxFilesToRequestBudget({ files, budgetBytes });
        if (Result.isError(fit) || fit.value.type === "whole") {
          return;
        }
        const pairs = files.flatMap((file, fileIndex) =>
          file.blocks.map((original, blockIndex) => ({
            original: original.text,
            kept: fit.value.files[fileIndex]?.blocks[blockIndex]?.text ?? "",
          })),
        );
        const size = (text: string) =>
          Buffer.byteLength(JSON.stringify(text)) - 2;
        const cut = pairs.filter(({ original, kept }) => original !== kept);
        const whole = pairs.filter(({ original, kept }) => original === kept);

        expect(cut.length).toBeGreaterThan(0);
        const shortestCutOriginal = Math.min(
          ...cut.map(({ original }) => size(original)),
        );
        for (const { original } of whole) {
          expect(size(original)).toBeLessThan(shortestCutOriginal);
        }
      }),
    );
  });

  test("a cut block keeps its start and end around a counted marker", () => {
    const text = `${"start ".repeat(4000)}${"middle ".repeat(4000)}provided that notice is given.`;
    const fit = fitDocxFilesToRequestBudget({
      files: [docx(0, ["Short clause.", text])],
      budgetBytes: 40_000,
    });

    expect(Result.isOk(fit)).toBe(true);
    if (Result.isError(fit) || fit.value.type !== "cut") {
      throw new Error("Expected a cut");
    }
    const [shortBlock, cutBlock] = fit.value.files.at(0)?.blocks ?? [];
    const [{ passagesCut, charactersWithheld, charactersTotal }] =
      fit.value.withheld;

    expect(shortBlock?.text).toBe("Short clause.");
    expect(cutBlock?.text.startsWith("start start")).toBe(true);
    expect(cutBlock?.text.endsWith("provided that notice is given.")).toBe(
      true,
    );
    expect(cutBlock?.text).toContain(
      `[… ${String(charactersWithheld)} characters withheld …]`,
    );
    expect(passagesCut).toBe(1);
    expect(charactersTotal).toBe(text.length + "Short clause.".length);
    expect(charactersWithheld).toBeGreaterThan(0);
  });

  test("a cut never splits a surrogate pair", () => {
    const fit = fitDocxFilesToRequestBudget({
      files: [docx(0, ["😀".repeat(10_000)])],
      budgetBytes: 30_000,
    });

    if (Result.isError(fit) || fit.value.type !== "cut") {
      throw new Error("Expected a cut");
    }
    expect(fit.value.files.at(0)?.blocks.at(0)?.text.isWellFormed()).toBe(true);
  });

  test("small files leave their room to a larger one", () => {
    const large = "l".repeat(60_000);
    const fit = fitDocxFilesToRequestBudget({
      files: [docx(0, ["small"]), docx(1, ["tiny"]), docx(2, [large])],
      budgetBytes: 40_000,
    });

    if (Result.isError(fit) || fit.value.type !== "cut") {
      throw new Error("Expected a cut");
    }
    expect(fit.value.withheld.map(({ fileFieldId }) => fileFieldId)).toEqual([
      "field-2",
    ]);
    expect(fit.value.files.at(0)?.blocks.at(0)?.text).toBe("small");
    expect(fit.value.files.at(2)?.blocks.at(0)?.text.length).toBeGreaterThan(
      30_000,
    );
  });

  test("extracted text counts as one long block", () => {
    const content = "e".repeat(200_000);
    const fit = fitFilesToRequestBudget({
      files: [
        {
          kind: "extracted-text",
          fileFieldId: toSafeId<"field">("field-0"),
          fileId: "file-0",
          simplifiedName: "F0",
          content,
        },
      ],
      budgetBytes: 150_000,
    });

    if (Result.isError(fit) || fit.value.type !== "cut") {
      throw new Error("Expected a cut");
    }
    expect(promptBytes(fit.value.files)).toBeLessThanOrEqual(150_000);
  });

  test("a long extracted file now fits whole on the smallest window", () => {
    const content = "e".repeat(62_000);
    const fit = fitFilesToRequestBudget({
      files: [
        {
          kind: "extracted-text",
          fileFieldId: toSafeId<"field">("field-0"),
          fileId: "file-0",
          simplifiedName: "F0",
          content,
        },
      ],
      budgetBytes: requestBudgetBytes("unknown-model"),
    });

    expect(Result.isOk(fit) && fit.value.type).toBe("whole");
  });

  test.each([
    ["more than half the text withheld", 100_000, 30_000],
    ["a block list whose framing alone exceeds the budget", 100, 200],
  ])("refuses %s", (_, blockCount, budgetBytes) => {
    const fit = fitDocxFilesToRequestBudget({
      files: [
        docx(
          0,
          Array.from({ length: blockCount }, () => "y".repeat(10)),
        ),
      ],
      budgetBytes,
    });

    expect(Result.isError(fit) && DocumentTooLargeError.is(fit.error)).toBe(
      true,
    );
  });

  test("a PDF reserves room per page and is never altered", () => {
    const pdf: PreparedInputFile = {
      kind: "pdf",
      fileFieldId: toSafeId<"field">("field-pdf"),
      fileId: "file-pdf",
      content: new Uint8Array([1, 2, 3]),
      pageCount: 10,
      mimeType: PDF_MIME_TYPE,
      simplifiedName: "F1",
    };
    const text = "t".repeat(60_000);

    const withRoom = fitFilesToRequestBudget({
      files: [docx(0, [text]), pdf],
      budgetBytes: 200_000,
    });
    const squeezed = fitFilesToRequestBudget({
      files: [docx(0, [text]), pdf],
      budgetBytes: 100_000,
    });
    const onlyThePdf = fitFilesToRequestBudget({
      files: [pdf],
      budgetBytes: 1000,
    });

    expect(Result.isOk(withRoom) && withRoom.value.type).toBe("whole");
    expect(Result.isOk(squeezed) && squeezed.value.type).toBe("cut");
    expect(Result.isOk(squeezed) && squeezed.value.files.at(1)).toBe(pdf);
    expect(Result.isError(onlyThePdf)).toBe(true);
  });

  test("ordinary long contracts stay whole on the smallest window", () => {
    // About 106,000 characters, like the largest DOCX template in the repository.
    const contract = Array.from({ length: 615 }, () => "c".repeat(170));

    const fit = fitFilesToRequestBudget({
      files: [docx(0, contract)],
      budgetBytes: requestBudgetBytes("unknown-model"),
    });

    expect(Result.isOk(fit) && fit.value.type).toBe("whole");
  });

  describe("recording a cut", () => {
    test("records each cut file by kind, and nothing for a whole request", () => {
      const logInfo = spyOn(logger, "info").mockImplementation(() => {});
      try {
        const whole = fitFilesToRequestBudget({
          files: [docx(0, ["short"])],
          budgetBytes: Number.MAX_SAFE_INTEGER,
        });
        if (Result.isOk(whole)) {
          logRequestFit(whole.value);
        }
        expect(logInfo).not.toHaveBeenCalled();

        const cut = fitFilesToRequestBudget({
          files: [docx(0, ["short", "l".repeat(60_000)])],
          budgetBytes: 40_000,
        });
        if (Result.isError(cut) || cut.value.type !== "cut") {
          throw new Error("Expected a cut");
        }
        logRequestFit(cut.value);

        const [source] = cut.value.withheld;
        expect(logInfo).toHaveBeenCalledTimes(1);
        expect(logInfo).toHaveBeenCalledWith(PROMPT_INPUT_TRUNCATED_EVENT, {
          input: "docx_blocks",
          truncated_parts: "1",
          dropped_chars: String(source.charactersWithheld),
          withheld_share: "up_to_50pct",
        });
      } finally {
        logInfo.mockRestore();
      }
    });
  });
});
