import { describe, expect, test } from "bun:test";

import { isPDFSearchWorkerResponseForRequest } from "@/lib/pdf/pdf-search-worker-protocol";
import type { PDFSearchWorkerResponse } from "@/lib/pdf/pdf-search-worker-protocol";

describe("PDF search worker protocol", () => {
  test("correlates responses with exactly one request", () => {
    const response = {
      status: "success",
      requestId: 7,
      result: null,
    } satisfies PDFSearchWorkerResponse;

    expect(isPDFSearchWorkerResponseForRequest(response, 7)).toBeTrue();
    expect(isPDFSearchWorkerResponseForRequest(response, 8)).toBeFalse();
  });
});
