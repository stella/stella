import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { extractOfficeEvidence } from "@/api/lib/files/extract-office-evidence";
import { LIMITS } from "@/api/lib/limits";

const readFixture = async (fileName: string): Promise<ArrayBuffer> =>
  await Bun.file(
    `${import.meta.dir}/../search/__fixtures__/${fileName}`,
  ).arrayBuffer();

const unwrapAvailable = async (fileName: string, format: "pptx" | "xlsx") => {
  const result = await extractOfficeEvidence(
    await readFixture(fileName),
    format,
  );
  if (Result.isError(result) || result.value.status !== "available") {
    throw new Error(`Expected available ${format} evidence`);
  }
  return result.value.payload;
};

describe("Office evidence extraction", () => {
  test("creates bounded spreadsheet blocks with exact ranges", async () => {
    const payload = await unwrapAvailable("schedule.xlsx", "xlsx");

    expect(payload.format).toBe("xlsx");
    expect(payload.blocks.length).toBeGreaterThan(0);
    expect(payload.blocks.length).toBeLessThanOrEqual(
      LIMITS.officeCitationBlocksMax,
    );
    expect(payload.blocks.map(({ text }) => text).join("\n")).toContain(
      "Acme s.r.o.",
    );
    for (const block of payload.blocks) {
      expect(block.id).toMatch(/^xlsx-[0-9a-f]{16}$/u);
      expect(block.text.length).toBeLessThanOrEqual(
        LIMITS.officeCitationBlockTextMaxChars,
      );
      expect(block.locator.type).toBe("xlsx");
      if (block.locator.type === "xlsx") {
        expect(block.locator.range).toMatch(
          /^[A-Z]+[1-9]\d*(?::[A-Z]+[1-9]\d*)?$/u,
        );
      }
    }
  });

  test("creates one navigable evidence block per text-bearing slide", async () => {
    const payload = await unwrapAvailable("deck.pptx", "pptx");

    expect(payload.format).toBe("pptx");
    expect(payload.blocks.map(({ text }) => text).join("\n")).toContain(
      "Deal Overview",
    );
    for (const block of payload.blocks) {
      expect(block.id).toMatch(/^pptx-[0-9a-f]{16}$/u);
      expect(block.locator.type).toBe("pptx");
      if (block.locator.type === "pptx") {
        expect(block.locator.slideIndex).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("classifies malformed input without crashing the parent", async () => {
    const result = await extractOfficeEvidence(
      new TextEncoder().encode("not an OOXML file").buffer,
      "xlsx",
    );

    expect(Result.isError(result)).toBe(false);
    if (!Result.isError(result)) {
      expect(result.value.status).toBe("unavailable");
    }
  });
});
