import { chat } from "@tanstack/ai";
import type { ContentPart } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";

import { StellaOpenRouterTextAdapter } from "@/api/lib/stella-openrouter-text-adapter";

class InspectableOpenRouterAdapter extends StellaOpenRouterTextAdapter {
  convertForRequest(part: ContentPart) {
    return this.convertContentPart(part);
  }
}

const adapter = new InspectableOpenRouterAdapter(
  { apiKey: "test-openrouter-key" },
  "google/gemini-2.5-flash",
);

describe("OpenRouter document transport", () => {
  test("serializes inline PDF bytes as file_data instead of a URL or text", () => {
    const base64 = Buffer.from("%PDF-1.4\nsynthetic").toString("base64");

    expect(
      adapter.convertForRequest({
        type: "document",
        source: {
          type: "data",
          value: base64,
          mimeType: "application/pdf",
        },
        metadata: { filename: "contract.pdf" },
      }),
    ).toEqual({
      type: "file",
      file: {
        fileData: `data:application/pdf;base64,${base64}`,
        filename: "contract.pdf",
      },
    });
  });

  test("serializes a remote PDF as a file reference, never document prompt text", () => {
    expect(
      adapter.convertForRequest({
        type: "document",
        source: {
          type: "url",
          value: "https://example.com/contract.pdf",
          mimeType: "application/pdf",
        },
      }),
    ).toEqual({
      type: "file",
      file: { fileData: "https://example.com/contract.pdf" },
    });
  });

  test("emits the official snake_case file_data shape on the HTTP wire", async () => {
    const originalFetch = globalThis.fetch;
    let requestBody: unknown;
    const fetchStub = async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(input.toString(), init);
      requestBody = await request.clone().json();
      return new Response(
        JSON.stringify({
          error: { code: "invalid_request", message: "synthetic stop" },
        }),
        {
          status: 400,
          headers: { "content-type": "application/json" },
        },
      );
    };
    globalThis.fetch = Object.assign(fetchStub, {
      preconnect: originalFetch.preconnect,
    });

    try {
      const base64 = Buffer.from("%PDF-1.4\nwire").toString("base64");
      const wireAdapter = new StellaOpenRouterTextAdapter(
        { apiKey: "test-openrouter-key" },
        "google/gemini-2.5-flash",
      );
      for await (const _chunk of chat({
        adapter: wireAdapter,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", content: "Read the attached PDF." },
              {
                type: "document",
                source: {
                  type: "data",
                  value: base64,
                  mimeType: "application/pdf",
                },
                metadata: { filename: "contract.pdf" },
              },
            ],
          },
        ],
        stream: true,
      })) {
        // The synthetic HTTP 400 ends the stream after request serialization.
      }

      expect(requestBody).toMatchObject({
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Read the attached PDF." },
              {
                type: "file",
                file: {
                  file_data: `data:application/pdf;base64,${base64}`,
                  filename: "contract.pdf",
                },
              },
            ],
          },
        ],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
