import { describe, expect, test } from "bun:test";

import {
  pdfDerivativeStateForFile,
  shouldGeneratePdfDerivative,
} from "@/api/handlers/files/gotenberg";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

describe("PDF derivative policy", () => {
  test("does not generate derivatives for natively renderable DOCX files", () => {
    expect(
      shouldGeneratePdfDerivative({
        encrypted: false,
        mimeType: DOCX_MIME_TYPE,
      }),
    ).toBe(false);

    expect(
      pdfDerivativeStateForFile({
        encrypted: false,
        mimeType: DOCX_MIME_TYPE,
      }),
    ).toEqual({ status: "not-required" });
  });

  test("generates derivatives for convertible files that are not native", () => {
    expect(
      shouldGeneratePdfDerivative({
        encrypted: false,
        mimeType: "application/msword",
      }),
    ).toBe(true);

    expect(
      pdfDerivativeStateForFile({
        encrypted: false,
        mimeType: "application/msword",
      }),
    ).toEqual({ status: "pending" });
  });

  test("does not generate derivatives for encrypted files", () => {
    expect(
      shouldGeneratePdfDerivative({
        encrypted: true,
        mimeType:
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    ).toBe(false);
  });
});
