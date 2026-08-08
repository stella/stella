import { chat } from "@tanstack/ai";
import type { ModelMessage } from "@tanstack/ai";
import { createAnthropicChat } from "@tanstack/ai-anthropic";
import { createOpenaiChat } from "@tanstack/ai-openai";
import { describe, expect, test } from "bun:test";

const PDF_BASE64 = Buffer.from("%PDF-1.4\nsynthetic").toString("base64");
const PDF_FILENAME = "contract.pdf";

const messages = [
  {
    role: "user",
    content: [
      { type: "text", content: "Read the attached PDF." },
      {
        type: "document",
        source: {
          type: "data",
          value: PDF_BASE64,
          mimeType: "application/pdf",
        },
        metadata: {
          filename: PDF_FILENAME,
          placeholder: "Attachment: contract.pdf",
        },
      },
    ],
  },
] satisfies ModelMessage[];

const inlinePdfWithoutFilenameMessages = [
  {
    role: "user",
    content: [
      {
        type: "document",
        source: {
          type: "data",
          value: PDF_BASE64,
          mimeType: "application/pdf",
        },
        metadata: { mediaType: "application/pdf" },
      },
    ],
  },
] satisfies ModelMessage[];

const inlineDocxWithoutFilenameMessages = [
  {
    role: "user",
    content: [
      {
        type: "document",
        source: {
          type: "data",
          value: "UEsDBAoAAAAAA",
          mimeType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        },
      },
    ],
  },
] satisfies ModelMessage[];

const createRequestRecorder = (errorBody: unknown) => {
  let requestBody: unknown;
  const fetch = Object.assign(
    async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      const request =
        input instanceof Request ? input : new Request(input.toString(), init);
      requestBody = await request.clone().json();
      return new Response(JSON.stringify(errorBody), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    },
    { preconnect: globalThis.fetch.preconnect },
  );

  return {
    fetch,
    requestBody: () => requestBody,
  };
};

describe("provider document transport", () => {
  test("serializes OpenAI PDFs as Responses API input_file items", async () => {
    const recorder = createRequestRecorder({
      error: {
        code: "invalid_request_error",
        message: "synthetic stop",
        type: "invalid_request_error",
      },
    });
    const adapter = createOpenaiChat("gpt-5.2", "test-openai-key", {
      fetch: recorder.fetch,
    });

    for await (const _chunk of chat({
      adapter,
      debug: false,
      messages,
      stream: true,
    })) {
      // The synthetic HTTP 400 ends the stream after request serialization.
    }

    expect(recorder.requestBody()).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Read the attached PDF." },
            {
              type: "input_file",
              file_data: `data:application/pdf;base64,${PDF_BASE64}`,
              filename: PDF_FILENAME,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(recorder.requestBody())).not.toContain("placeholder");
  });

  test("maps shared metadata to Anthropic's document contract", async () => {
    const recorder = createRequestRecorder({
      error: { message: "synthetic stop", type: "invalid_request_error" },
      type: "error",
    });
    const adapter = createAnthropicChat(
      "claude-sonnet-4-6",
      "test-anthropic-key",
      { fetch: recorder.fetch },
    );

    for await (const _chunk of chat({
      adapter,
      debug: false,
      messages,
      stream: true,
    })) {
      // The synthetic HTTP 400 ends the stream after request serialization.
    }

    expect(recorder.requestBody()).toMatchObject({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Read the attached PDF." },
            {
              type: "document",
              source: {
                type: "base64",
                data: PDF_BASE64,
                media_type: "application/pdf",
              },
              title: PDF_FILENAME,
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(recorder.requestBody())).not.toContain("filename");
    expect(JSON.stringify(recorder.requestBody())).not.toContain("placeholder");
  });

  test("defaults the filename for inline OpenAI PDFs", async () => {
    const recorder = createRequestRecorder({
      error: {
        code: "invalid_request_error",
        message: "synthetic stop",
        type: "invalid_request_error",
      },
    });
    const adapter = createOpenaiChat("gpt-5.2", "test-openai-key", {
      fetch: recorder.fetch,
    });

    for await (const _chunk of chat({
      adapter,
      debug: false,
      messages: inlinePdfWithoutFilenameMessages,
      stream: true,
    })) {
      // The synthetic HTTP 400 ends the stream after request serialization.
    }

    expect(recorder.requestBody()).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              file_data: `data:application/pdf;base64,${PDF_BASE64}`,
              filename: "document.pdf",
            },
          ],
        },
      ],
    });
  });

  test("derives the filename extension for inline OpenAI documents", async () => {
    const recorder = createRequestRecorder({
      error: {
        code: "invalid_request_error",
        message: "synthetic stop",
        type: "invalid_request_error",
      },
    });
    const adapter = createOpenaiChat("gpt-5.2", "test-openai-key", {
      fetch: recorder.fetch,
    });

    for await (const _chunk of chat({
      adapter,
      debug: false,
      messages: inlineDocxWithoutFilenameMessages,
      stream: true,
    })) {
      // The synthetic HTTP 400 ends the stream after request serialization.
    }

    expect(recorder.requestBody()).toMatchObject({
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: "document.docx",
            },
          ],
        },
      ],
    });
  });
});
