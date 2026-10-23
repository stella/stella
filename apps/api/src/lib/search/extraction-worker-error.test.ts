import { describe, expect, test } from "bun:test";

import {
  formatWorkerErrorLine,
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
});
