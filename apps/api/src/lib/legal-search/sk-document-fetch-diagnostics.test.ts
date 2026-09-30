import { describe, expect, test } from "bun:test";

import {
  type SkDocumentFetchErrorKind,
  skDocumentErrorDiagnostics,
  skDocumentResponseDiagnostics,
} from "@stll/legal-atlas/sk-document-fetch-diagnostics";

import { AdapterFetchError } from "@/api/lib/errors/tagged-errors";

import { SkDocumentNonPdfError } from "./sk-document-fetch-diagnostics";

describe("safe SK document fetch diagnostics", () => {
  test("HTTP failures retain status without publishing error context", () => {
    for (const [status, kind, statusClass] of [
      [429, "rate-limited", "4xx"],
      [401, "publisher-refused", "4xx"],
      [403, "publisher-refused", "4xx"],
      [503, "publisher-server-error", "5xx"],
      [400, "publisher-status", "4xx"],
      [302, "publisher-status", "3xx"],
    ] as const satisfies readonly (readonly [
      number,
      SkDocumentFetchErrorKind,
      string,
    ])[]) {
      const error = new AdapterFetchError({
        message: "private response body",
        adapterKey: "sk-courts",
        cursor: "private identifier",
        httpStatus: status,
        cause: new Error("private URL"),
      });
      expect(skDocumentErrorDiagnostics(error)).toEqual({
        kind,
        httpStatus: status,
        httpStatusClass: statusClass,
      });
    }
  });

  test("MIME classes never copy arbitrary header parameters", () => {
    for (const [mime, contentTypeClass] of [
      ["Application/PDF; filename=private.pdf", "pdf"],
      ["application/octet-stream", "binary"],
      ["text/html; charset=utf-8", "html"],
      ["application/problem+json", "json"],
      ["text/private-value", "other"],
      ["", "missing"],
    ] as const) {
      expect(
        skDocumentResponseDiagnostics(
          new Response(null, { headers: { "Content-Type": mime } }),
        ),
      ).toEqual({
        httpStatus: 200,
        httpStatusClass: "2xx",
        contentTypeClass,
        failureKind: "none",
      });
    }
  });

  test("timeouts, network failures and unrelated bugs stay distinct", () => {
    expect(
      skDocumentErrorDiagnostics(new DOMException("private", "TimeoutError")),
    ).toEqual({ kind: "timeout" });
    expect(
      skDocumentErrorDiagnostics(new DOMException("private", "AbortError")),
    ).toEqual({ kind: "aborted" });
    for (const code of [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "ConnectionClosed",
    ]) {
      expect(
        skDocumentErrorDiagnostics(
          Object.assign(new Error("private"), { code }),
        ),
      ).toEqual({ kind: "network" });
    }
    expect(
      skDocumentErrorDiagnostics(new TypeError("programming bug")),
    ).toEqual({
      kind: "unknown",
    });
    expect(skDocumentErrorDiagnostics("private value")).toEqual({
      kind: "unknown",
    });
    expect(
      skDocumentErrorDiagnostics(
        new SkDocumentNonPdfError({
          message: "private response; classification does not parse this",
          adapterKey: "sk-courts",
          cursor: null,
        }),
      ),
    ).toEqual({ kind: "non-pdf" });
  });
});
