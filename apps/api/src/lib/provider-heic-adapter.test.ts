import { chat } from "@tanstack/ai";
import { createGeminiChat } from "@tanstack/ai-gemini";
import { describe, expect, test } from "bun:test";

import { DEFAULT_MODELS } from "@stll/ai-catalog";
import type { HeicMimeType } from "@stll/ai-catalog";

describe("native HEIC provider transport", () => {
  test.each(["image/heic", "image/heif"] satisfies HeicMimeType[])(
    "preserves original %s bytes and MIME type through Gemini's real adapter",
    async (mimeType) => {
      const originalBytes = Buffer.from([
        0, 0, 0, 24, 102, 116, 121, 112, 104, 101, 105, 99,
      ]);
      const base64 = originalBytes.toString("base64");
      let requestBody: unknown;
      using server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          requestBody = await request.json();
          return Response.json(
            {
              error: {
                code: 400,
                message: "synthetic stop",
                status: "INVALID_ARGUMENT",
              },
            },
            { status: 400 },
          );
        },
      });
      const adapter = createGeminiChat(
        DEFAULT_MODELS.google.pdf,
        "test-google-key",
        {
          httpOptions: { baseUrl: server.url.toString() },
        },
      );

      for await (const _chunk of chat({
        adapter,
        debug: false,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", content: "Extract the invoice total." },
              {
                type: "image",
                source: { type: "data", value: base64, mimeType },
              },
            ],
          },
        ],
        stream: true,
      })) {
        // The local HTTP 400 ends the stream after real request serialization.
      }

      expect(requestBody).toMatchObject({
        contents: [
          {
            role: "user",
            parts: [
              { text: "Extract the invoice total." },
              { inlineData: { data: base64, mimeType } },
            ],
          },
        ],
      });
    },
  );
});
