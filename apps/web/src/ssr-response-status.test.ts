import { describe, expect, test } from "bun:test";

import {
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
