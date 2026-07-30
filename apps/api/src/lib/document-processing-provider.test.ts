import { describe, expect, test } from "bun:test";

import {
  isSupportedOcrPageCount,
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
          { prunedResult: { rec_texts: ["Soud", "Rozsudek"] } },
          { prunedResult: { rec_texts: ["Sygn. akt", "I ACa 12/26"] } },
        ],
      },
    });

    expect(result).toEqual({
      pageCount: 2,
      text: "Soud\nRozsudek\n\n\f\n\nSygn. akt\nI ACa 12/26",
      truncated: false,
    });
  });

  test("rejects malformed page output", () => {
    expect(
      parsePaddleOcrResponse({
        errorCode: 0,
        result: {
          ocrResults: [{ prunedResult: { rec_texts: ["valid", 42] } }],
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
              rec_texts: ["x".repeat(LIMITS.extractedContentMaxChars + 1)],
            },
          },
        ],
      },
    });

    expect(result?.text).toHaveLength(LIMITS.extractedContentMaxChars);
    expect(result?.truncated).toBe(true);
  });
});

describe("isSupportedOcrPageCount", () => {
  test("enforces the bounded document limit", () => {
    expect(isSupportedOcrPageCount(1)).toBe(true);
    expect(isSupportedOcrPageCount(500)).toBe(true);
    expect(isSupportedOcrPageCount(501)).toBe(false);
  });
});

describe("readBoundedOcrJson", () => {
  test("parses a response within the byte boundary", async () => {
    await expect(
      readBoundedOcrJson(new Response('{"ok":true}'), 32),
    ).resolves.toEqual({ ok: true });
  });

  test("rejects a response whose declared size exceeds the boundary", async () => {
    await expect(
      readBoundedOcrJson(
        new Response("abcd", { headers: { "content-length": "4" } }),
        3,
      ),
    ).rejects.toMatchObject({ code: "response_too_large" });
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

    await expect(
      readBoundedOcrJson(new Response(body), 3),
    ).rejects.toMatchObject({ code: "response_too_large" });
  });
});
