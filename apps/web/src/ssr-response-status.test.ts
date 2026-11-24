import { describe, expect, test } from "bun:test";

import {
  documentStatus,
  markRetryableDocumentFailure,
  RETRYABLE_DOCUMENT_RETRY_AFTER_SECONDS,
  SSR_STATUS_HEADER,
  ssrStatusFromHeader,
  ssrStatusHeaders,
} from "@/ssr-response-status";

describe("ssrStatusFromHeader", () => {
  test("reads back what a route asked for", () => {
    expect(
      ssrStatusFromHeader(ssrStatusHeaders(503)[SSR_STATUS_HEADER] ?? null),
    ).toBe(503);
  });

  test("a document that asked for nothing keeps the router's status", () => {
    expect(ssrStatusFromHeader(null)).toBeNull();
  });

  test("drops a value the Response constructor would reject", () => {
    expect(ssrStatusFromHeader("0")).toBeNull();
    expect(ssrStatusFromHeader("600")).toBeNull();
    expect(ssrStatusFromHeader("503 Service Unavailable")).toBeNull();
  });
});

describe("documentStatus", () => {
  test("a status the route asked for wins over the router's", () => {
    expect(documentStatus(new Headers(ssrStatusHeaders(503)), 200)).toBe(503);
  });

  test("without a valid request the router's status stands", () => {
    expect(documentStatus(new Headers(), 500)).toBe(500);
    expect(
      documentStatus(new Headers({ [SSR_STATUS_HEADER]: "700" }), 200),
    ).toBe(200);
  });
});

describe("markRetryableDocumentFailure", () => {
  const retryable = new Error("busy");
  const broken = new Error("broken");
  const isRetryable = (error: unknown) => error === retryable;

  test("a 500 from reads that asking again fixes is sent as 503", () => {
    const headers = new Headers();
    markRetryableDocumentFailure({
      errors: [retryable],
      headers,
      isRetryable,
      routerStatus: 500,
    });
    expect(documentStatus(headers, 500)).toBe(503);
    expect(headers.get("Retry-After")).toBe(
      String(RETRYABLE_DOCUMENT_RETRY_AFTER_SECONDS),
    );
  });

  test("any other failure keeps the 500", () => {
    const headers = new Headers();
    markRetryableDocumentFailure({
      errors: [retryable, broken],
      headers,
      isRetryable,
      routerStatus: 500,
    });
    expect(documentStatus(headers, 500)).toBe(500);
    expect(headers.has("Retry-After")).toBe(false);
  });

  test("a document without a router error is left alone", () => {
    for (const [errors, routerStatus] of [
      [[], 500],
      [[retryable], 200],
      [[retryable], 404],
    ] as const) {
      const headers = new Headers();
      markRetryableDocumentFailure({
        errors,
        headers,
        isRetryable,
        routerStatus,
      });
      expect(documentStatus(headers, routerStatus)).toBe(routerStatus);
    }
  });

  test("a status the route asked for stands", () => {
    const headers = new Headers(ssrStatusHeaders(502));
    markRetryableDocumentFailure({
      errors: [retryable],
      headers,
      isRetryable,
      routerStatus: 500,
    });
    expect(documentStatus(headers, 500)).toBe(502);
  });
});
