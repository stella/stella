import { describe, expect, test } from "bun:test";

import {
  buildImportSuggestions,
  normalizeFolderPath,
  normalizeSuggestedFileName,
} from "@/routes/_protected.workspaces/$workspaceId/-components/import-organizer.logic";

const file = (name: string) =>
  new File([""], name, { type: "application/pdf" });

describe("import organizer suggestions", () => {
  test("keeps fallback suggestions limited to filename cleanup", () => {
    const suggestions = buildImportSuggestions([
      file("2024-03-12 Lease Agreement ABC.pdf"),
      file("Statement_of_Claim_12.04.2024.pdf"),
      file("invoice-20240313.pdf"),
    ]);

    expect(suggestions[0]?.folderPath).toBe("");
    expect(suggestions[0]?.suggestedName).toBe(
      "2024 03 12 Lease Agreement ABC.pdf",
    );
    expect(suggestions[0]?.detectedDate).toBe("2024-03-12");

    expect(suggestions[1]?.folderPath).toBe("");
    expect(suggestions[1]?.suggestedName).toBe(
      "Statement of Claim 12 04 2024.pdf",
    );
    expect(suggestions[1]?.detectedDate).toBe("2024-04-12");

    expect(suggestions[2]?.folderPath).toBe("");
    expect(suggestions[2]?.suggestedName).toBe("invoice 20240313.pdf");
  });

  test("keeps duplicate suggestions unique within the same folder", () => {
    const suggestions = buildImportSuggestions([
      file("2024-03-12 contract ABC.pdf"),
      file("2024-03-12 contract ABC.pdf"),
    ]);

    expect(suggestions[0]?.suggestedName).toBe("2024 03 12 contract ABC.pdf");
    expect(suggestions[1]?.suggestedName).toBe(
      "2024 03 12 contract ABC (2).pdf",
    );
  });

  test("normalizes user overrides into safe path segments", () => {
    expect(normalizeFolderPath("  01 Contracts / Client: ABC  ")).toBe(
      "01 Contracts/Client ABC",
    );
    expect(normalizeSuggestedFileName("bad/name?.pdf", "fallback.pdf")).toBe(
      "bad name .pdf",
    );
    expect(normalizeSuggestedFileName("   ", "fallback.pdf")).toBe(
      "fallback.pdf",
    );
  });
});
