import { describe, expect, test } from "bun:test";

import {
  documentStatus,
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
