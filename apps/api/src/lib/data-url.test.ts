import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toDataUrl, parseDataUrl, validateDataUrl } from "@/api/lib/data-url";

describe("data URL helpers", () => {
  test("builds and parses a valid base64 data URL", () => {
    const url = toDataUrl(
      new Uint8Array(Buffer.from("hello", "utf-8")),
      "text/plain",
    );
    const result = parseDataUrl({
      expectedMimeType: "text/plain",
      maxBytes: 1024,
      url,
    });

    expect(Result.isOk(result)).toBe(true);
  });

  test("rejects a data URL without a comma separator", () => {
    const result = validateDataUrl({
      url: "data:text/plain;base64aGVsbG8=",
    });

    expect(Result.isError(result)).toBe(true);

    if (Result.isOk(result)) {
      throw new Error("Expected invalid data URL");
    }

    expect(result.error.message).toBe("Data URLs must start with 'data:'");
  });

  test("rejects a data URL without the base64 metadata token", () => {
    const result = validateDataUrl({
      url: "data:text/plain,hello",
    });

    expect(Result.isError(result)).toBe(true);

    if (Result.isOk(result)) {
      throw new Error("Expected invalid data URL");
    }

    expect(result.error.message).toBe("Data URLs must use base64 encoding");
  });

  test("rejects a data URL whose MIME type does not match the expected type", () => {
    const result = validateDataUrl({
      expectedMimeType: "application/pdf",
      url: "data:text/plain;base64,aGVsbG8=",
    });

    expect(Result.isError(result)).toBe(true);

    if (Result.isOk(result)) {
      throw new Error("Expected invalid data URL");
    }

    expect(result.error.message).toBe(
      "Data URL MIME type does not match expected type",
    );
  });

  test("rejects a data URL without a MIME type", () => {
    const result = validateDataUrl({
      url: "data:;base64,aGVsbG8=",
    });

    expect(Result.isError(result)).toBe(true);

    if (Result.isOk(result)) {
      throw new Error("Expected invalid data URL");
    }

    expect(result.error.message).toBe("Data URLs must use base64 encoding");
  });

  test("rejects an encoded payload that cannot fit within maxBytes", () => {
    const result = parseDataUrl({
      maxBytes: 2,
      url: "data:text/plain;base64,aaaaaaaa",
    });

    expect(Result.isError(result)).toBe(true);

    if (Result.isOk(result)) {
      throw new Error("Expected oversized data URL");
    }

    expect(result.error.message).toBe("Data URL payload exceeds size limit");
  });

  test("reports invalid encoding before checking payload size", () => {
    const result = parseDataUrl({
      maxBytes: 2,
      url: "data:text/plain,aaaaaaaa",
    });

    expect(Result.isError(result)).toBe(true);

    if (Result.isOk(result)) {
      throw new Error("Expected invalid data URL");
    }

    expect(result.error.message).toBe("Data URLs must use base64 encoding");
  });

  test("rejects decoded payloads larger than maxBytes", () => {
    const result = parseDataUrl({
      maxBytes: 2,
      url: "data:text/plain;base64,aaaa",
    });

    expect(Result.isError(result)).toBe(true);

    if (Result.isOk(result)) {
      throw new Error("Expected oversized data URL");
    }

    expect(result.error.message).toBe("Data URL payload exceeds size limit");
  });
});
