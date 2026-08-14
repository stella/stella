import { describe, expect, test } from "bun:test";

import { isSupportedOcrPageCount } from "@/api/lib/document-processing-ocr-result";
import {
  createOcrRequestInit,
  parsePaddleOcrResponse,
  readBoundedOcrJson,
} from "@/api/lib/document-processing-provider";
import { LIMITS } from "@/api/lib/limits";

describe("parsePaddleOcrResponse", () => {
  test("preserves page boundaries and recognized line order", () => {
    const result = parsePaddleOcrResponse({
      errorCode: 0,
      result: {
        ocrResults: [
          {
            prunedResult: {
              rec_boxes: [
                [10, 20, 110, 40],
                [10, 50, 160, 75],
              ],
              rec_scores: [0.99, 0.98],
              rec_texts: ["Soud", "Rozsudek"],
            },
          },
          {
            prunedResult: {
              rec_boxes: [
                [15, 30, 150, 55],
                [15, 60, 220, 90],
              ],
              rec_scores: [0.97, 0.96],
              rec_texts: ["Sygn. akt", "I ACa 12/26"],
            },
          },
        ],
        dataInfo: {
          type: "pdf",
          numPages: 2,
          pages: [
            { width: 1000, height: 1400 },
            { width: 1000, height: 1400 },
          ],
        },
      },
    });

    expect(result).toEqual({
      pageCount: 2,
      payload: {
        version: 1,
        pages: [
          {
            width: 1000,
            height: 1400,
            lines: [
              { box: [10, 20, 110, 40], confidence: 0.99, text: "Soud" },
              {
                box: [10, 50, 160, 75],
                confidence: 0.98,
                text: "Rozsudek",
              },
            ],
          },
          {
            width: 1000,
            height: 1400,
            lines: [
              {
                box: [15, 30, 150, 55],
                confidence: 0.97,
                text: "Sygn. akt",
              },
              {
                box: [15, 60, 220, 90],
                confidence: 0.96,
                text: "I ACa 12/26",
              },
            ],
          },
        ],
      },
      text: "Soud\nRozsudek\n\n\f\n\nSygn. akt\nI ACa 12/26",
      truncated: false,
    });
  });

  test("rejects malformed page output", () => {
    expect(
      parsePaddleOcrResponse({
        errorCode: 0,
        result: {
          ocrResults: [
            {
              prunedResult: {
                rec_boxes: [[0, 0, 10, 10]],
                rec_scores: [0.9],
                rec_texts: ["valid", 42],
              },
            },
          ],
          dataInfo: {
            type: "pdf",
            numPages: 1,
            pages: [{ width: 100, height: 100 }],
          },
        },
      }),
    ).toBeNull();
  });

  test("bounds persisted searchable text", () => {
    const result = parsePaddleOcrResponse({
      errorCode: 0,
      result: {
        ocrResults: [
          {
            prunedResult: {
              rec_boxes: [[0, 0, 100, 20]],
              rec_scores: [0.9],
              rec_texts: ["x".repeat(LIMITS.extractedContentMaxChars + 1)],
            },
          },
        ],
        dataInfo: {
          type: "pdf",
          numPages: 1,
          pages: [{ width: 100, height: 100 }],
        },
      },
    });

    expect(result?.text).toHaveLength(LIMITS.extractedContentMaxChars);
    expect(result?.truncated).toBe(true);
    expect(result?.payload.pages.at(0)?.lines.at(0)?.text).toHaveLength(
      LIMITS.extractedContentMaxChars + 1,
    );
  });
});

describe("isSupportedOcrPageCount", () => {
  test("enforces the bounded document limit", () => {
    expect(isSupportedOcrPageCount(1)).toBe(true);
    expect(isSupportedOcrPageCount(500)).toBe(true);
    expect(isSupportedOcrPageCount(501)).toBe(false);
  });
});

describe("createOcrRequestInit", () => {
  test("rejects redirects before they can forward a presigned source URL", () => {
    const signal = new AbortController().signal;
    const request = createOcrRequestInit({
      idempotencyKey: "ocr:run_1",
      signal,
      sourceUrl: "https://storage.example.test/presigned-document",
    });

    expect(request.redirect).toBe("error");
    expect(request.signal).toBe(signal);
  });
});

describe("readBoundedOcrJson", () => {
  test("parses a response within the byte boundary", async () => {
    const parsed = await readBoundedOcrJson(new Response('{"ok":true}'), 32);

    expect(parsed).toEqual({ ok: true });
  });

  test("rejects a response whose declared size exceeds the boundary", async () => {
    const rejection: unknown = await readBoundedOcrJson(
      new Response("abcd", { headers: { "content-length": "4" } }),
      3,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({ code: "response_too_large" });
  });

  test("rejects a chunked response that crosses the boundary", async () => {
    const body = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode("ab"));
        controller.enqueue(encoder.encode("cd"));
        controller.close();
      },
    });

    const rejection: unknown = await readBoundedOcrJson(
      new Response(body),
      3,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toMatchObject({ code: "response_too_large" });
  });

  test("rejects malicious tiny chunks before their allocations can exhaust the worker", async () => {
    let cancelled = false;
    let emittedChunks = 0;
    const maxBytes = 20_000;
    const body = new ReadableStream({
      cancel() {
        cancelled = true;
      },
      pull(controller) {
        emittedChunks += 1;
        controller.enqueue(new Uint8Array([0x20]));
      },
    });

    const rejection: unknown = await readBoundedOcrJson(
      new Response(body),
      maxBytes,
    ).then(
      () => null,
      (error: unknown) => error,
    );

    expect(emittedChunks).toBeLessThan(maxBytes);
    expect(cancelled).toBe(true);
    expect(rejection).toMatchObject({ code: "response_too_large" });
  });
});
