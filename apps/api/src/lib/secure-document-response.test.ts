import { describe, expect, test } from "bun:test";

import { contentDisposition } from "@/api/lib/content-disposition";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import {
  parseContentLengthHeader,
  secureDocumentResponse,
} from "@/api/lib/secure-document-response";
import { RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS } from "@/api/lib/security-headers";

describe("secure document responses", () => {
  test("required document headers cannot be overridden by callers", () => {
    const fileName = sanitizeFilename("../../client\r\nbrief.pdf");
    const response = secureDocumentResponse({
      body: "pdf",
      contentType: "application/pdf",
      disposition: "attachment",
      fileName,
      contentLength: 3,
      additionalHeaders: {
        ...Object.fromEntries(
          Object.keys(RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS).map((key) => [
            key,
            "unsafe",
          ]),
        ),
        "Content-Disposition": 'inline; filename="unsafe.html"',
        "Content-Length": "999",
        "Content-Type": "text/html",
        "X-Document-Diagnostic": "preserved",
      },
    });

    for (const [key, value] of Object.entries(
      RAW_DOCUMENT_RESPONSE_SECURITY_HEADERS,
    )) {
      expect(response.headers.get(key)).toBe(value);
    }
    expect(response.headers.get("Content-Disposition")).toBe(
      contentDisposition(fileName, "attachment"),
    );
    expect(response.headers.get("Content-Length")).toBe("3");
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("X-Document-Diagnostic")).toBe("preserved");
  });

  test.each([
    ["0", 0],
    ["42", 42],
    ["0042", 42],
  ])("parses a valid upstream content length (%s)", (value, expected) => {
    expect(parseContentLengthHeader(value)).toBe(expected);
  });

  test.each([null, "", "-1", "1.5", "1, 1", "9007199254740992"])(
    "rejects an unsafe upstream content length (%s)",
    (value) => {
      expect(parseContentLengthHeader(value)).toBeUndefined();
    },
  );
});
