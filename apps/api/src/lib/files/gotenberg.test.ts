import { describe, expect, test } from "bun:test";

import {
  isConvertibleMimeType,
  isNativelyRenderableMimeType,
  pdfDerivativeStateForFile,
  shouldGeneratePdfDerivative,
} from "@/api/lib/files/gotenberg";
import {
  DOCX_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from "@/api/mime-types";

describe("PDF derivative policy", () => {
  test("does not generate derivatives for natively renderable OOXML files", () => {
    for (const mimeType of [DOCX_MIME_TYPE, PPTX_MIME_TYPE, XLSX_MIME_TYPE]) {
      for (const variant of [
        mimeType,
        `${mimeType.toUpperCase()}; charset=binary`,
      ]) {
        expect(
          shouldGeneratePdfDerivative({
            encrypted: false,
            mimeType: variant,
          }),
        ).toBe(false);

        expect(
          pdfDerivativeStateForFile({
            encrypted: false,
            mimeType: variant,
          }),
        ).toEqual({ status: "not-required" });
      }
    }
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

  test("does not generate PDF derivatives for email files", () => {
    expect(
      shouldGeneratePdfDerivative({
        encrypted: false,
        mimeType: "message/rfc822",
      }),
    ).toBe(false);

    expect(
      shouldGeneratePdfDerivative({
        encrypted: false,
        mimeType: "application/vnd.ms-outlook",
      }),
    ).toBe(false);
  });

  test("does not treat inherited object properties as MIME types", () => {
    for (const inheritedProperty of ["constructor", "toString"]) {
      expect(isConvertibleMimeType(inheritedProperty)).toBe(false);
      expect(isNativelyRenderableMimeType(inheritedProperty)).toBe(false);
    }
  });
});
