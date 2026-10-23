import { describe, expect, test } from "bun:test";

import { CompoundFileParseError } from "@/api/lib/files/compound-file";
import { EmailParseError } from "@/api/lib/files/email-to-html";

import {
  formatWorkerErrorLine,
  getWorkerErrorClass,
  parseWorkerErrorClass,
} from "./extraction-worker-error";

describe("extraction worker error line", () => {
  test("reads the class the worker writes from a composed failure", () => {
    const message = `Worker failed (exit 1): ${formatWorkerErrorLine("PdfParseError")}`;
    expect(parseWorkerErrorClass(message)).toBe("PdfParseError");
  });

  test("rejects stderr content that is not a class identifier", () => {
    expect(
      parseWorkerErrorClass(
        "extraction-worker error: privileged matter detail",
      ),
    ).toBeNull();
  });

  test("uses the worker's final marker", () => {
    const message = [
      formatWorkerErrorLine("NoisyLibWarning"),
      formatWorkerErrorLine("RangeError"),
    ].join("\n");
    expect(parseWorkerErrorClass(message)).toBe("RangeError");
  });

  test("preserves distinct tagged parser classes through the worker marker", () => {
    const errors = [
      new EmailParseError({
        message: "email parser failed",
        mimeType: "message/rfc822",
      }),
      new CompoundFileParseError({
        message: "compound document parser failed",
        limitReached: false,
      }),
    ];
    const classes = errors.map(getWorkerErrorClass);
    const markers = classes.map(formatWorkerErrorLine);

    expect(markers).toEqual([
      formatWorkerErrorLine("EmailParseError"),
      formatWorkerErrorLine("CompoundFileParseError"),
    ]);
    expect(markers.map(parseWorkerErrorClass)).toEqual([
      "EmailParseError",
      "CompoundFileParseError",
    ]);
    expect(classes.map((errorClass) => `parser_failed:${errorClass}`)).toEqual([
      "parser_failed:EmailParseError",
      "parser_failed:CompoundFileParseError",
    ]);
  });

  test("replaces an invalid original error class before writing the marker", () => {
    const error = new Error("parser failed");
    error.name = "invalid class: leaked detail";

    expect(getWorkerErrorClass(error)).toBe("UnknownError");
  });
});
