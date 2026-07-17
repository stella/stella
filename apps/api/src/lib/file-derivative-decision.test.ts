import { describe, expect, it } from "bun:test";

import type { FieldContent } from "@/api/db/schema-validators";

import { decidePdfDerivativeAction } from "./file-derivative-decision";

type FileContent = Extract<FieldContent, { type: "file" }>;

// A convertible, non-natively-rendered MIME type (.xlsx) drives PDF generation.
const CONVERTIBLE_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
// A native PDF is not convertible, so no derivative is generated.
const NON_CONVERTIBLE_MIME = "application/pdf";

const fileContent = (overrides: Partial<FileContent> = {}): FileContent => ({
  version: 1,
  type: "file",
  id: "11111111-1111-1111-1111-111111111111",
  fileName: "report.xlsx",
  mimeType: CONVERTIBLE_MIME,
  sizeBytes: 1024,
  encrypted: false,
  sha256Hex: "a".repeat(64),
  pdfFileId: null,
  ...overrides,
});

describe("decidePdfDerivativeAction", () => {
  it("skips when the field is missing", () => {
    expect(decidePdfDerivativeAction(undefined)).toEqual({ type: "skip" });
  });

  it("skips non-file content", () => {
    const content: FieldContent = { version: 1, type: "pending" };
    expect(decidePdfDerivativeAction(content)).toEqual({ type: "skip" });
  });

  it("generates for a fresh convertible file with no pdf yet", () => {
    const content = fileContent({ pdfFileId: null, pdfDerivative: undefined });
    expect(decidePdfDerivativeAction(content)).toEqual({
      type: "generate",
      content,
    });
  });

  it("generates when status is explicitly pending", () => {
    const content = fileContent({ pdfDerivative: { status: "pending" } });
    expect(decidePdfDerivativeAction(content).type).toBe("generate");
  });

  it("skips non-convertible files (native PDF)", () => {
    const content = fileContent({
      mimeType: NON_CONVERTIBLE_MIME,
      fileName: "report.pdf",
    });
    expect(decidePdfDerivativeAction(content)).toEqual({ type: "skip" });
  });

  it("skips encrypted files", () => {
    const content = fileContent({ encrypted: true });
    expect(decidePdfDerivativeAction(content)).toEqual({ type: "skip" });
  });

  // The core bug: after the ready flip, `pdfFileId` is set. A retry that
  // previously threw during extraction/indexing must re-run extraction rather
  // than early-returning and silently dropping the document from search.
  it("re-runs extraction when the derivative is already ready", () => {
    const content = fileContent({
      pdfFileId: "22222222-2222-2222-2222-222222222222",
      pdfDerivative: { status: "ready" },
    });
    expect(decidePdfDerivativeAction(content)).toEqual({
      type: "extract-only",
    });
  });

  it("does not regenerate a failed derivative", () => {
    const content = fileContent({ pdfDerivative: { status: "failed" } });
    expect(decidePdfDerivativeAction(content)).toEqual({ type: "skip" });
  });

  it("does not regenerate a not-required derivative", () => {
    const content = fileContent({ pdfDerivative: { status: "not-required" } });
    expect(decidePdfDerivativeAction(content)).toEqual({ type: "skip" });
  });

  it("skips when a pdf already exists but status is not ready (foreign write)", () => {
    const content = fileContent({
      pdfFileId: "33333333-3333-3333-3333-333333333333",
      pdfDerivative: { status: "pending" },
    });
    expect(decidePdfDerivativeAction(content)).toEqual({ type: "skip" });
  });

  // Transient failure then successful retry: the first invocation flips the
  // derivative to `ready` (generate), and the retry re-runs extraction to
  // completion (extract-only). Both invocations act, so indexing is not lost.
  it("progresses generate -> extract-only across a transient-failure retry", () => {
    const first = fileContent({ pdfFileId: null, pdfDerivative: undefined });
    expect(decidePdfDerivativeAction(first).type).toBe("generate");

    const afterReadyFlip = fileContent({
      pdfFileId: "44444444-4444-4444-4444-444444444444",
      pdfDerivative: { status: "ready" },
    });
    expect(decidePdfDerivativeAction(afterReadyFlip).type).toBe("extract-only");
  });
});
