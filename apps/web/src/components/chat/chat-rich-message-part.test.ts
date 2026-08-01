import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

process.env["VITE_API_URL"] ??= "https://api.example.test";

const unsafeScriptUrl = ["java", "script:alert(1)"].join("");

const { normalizeUiResourcePart, toRenderableMediaSource } =
  await import("@/components/chat/chat-rich-message-part");

describe("rich chat message parts", () => {
  test("creates playable sources only for matching safe media", () => {
    expect(
      toRenderableMediaSource({
        type: "audio",
        source: { type: "data", value: "Zm9v", mimeType: "audio/mpeg" },
      }),
    ).toBe("data:audio/mpeg;base64,Zm9v");
    expect(
      toRenderableMediaSource({
        type: "video",
        source: {
          type: "url",
          value: unsafeScriptUrl,
          mimeType: "video/mp4",
        },
      }),
    ).toBeNull();
    expect(
      toRenderableMediaSource({
        type: "audio",
        source: {
          type: "url",
          value: "https://example.test/audio.mp3",
          mimeType: "video/mp4",
        },
      }),
    ).toBeNull();
  });

  test("normalizes base64 MCP App HTML without weakening its contract", () => {
    const part = normalizeUiResourcePart({
      type: "ui-resource",
      resource: {
        uri: "ui://widget",
        mimeType: "text/html;profile=mcp-app",
        blob: "PHA+V2lkZ2V0PC9wPg==",
      },
      toolCallId: "call-1",
      toolName: "widget",
    });

    expect(part?.resource).toEqual({
      uri: "ui://widget",
      mimeType: "text/html;profile=mcp-app",
      text: "<p>Widget</p>",
    });
    expect(
      normalizeUiResourcePart({
        type: "ui-resource",
        resource: {
          uri: "https://example.test/widget",
          mimeType: "text/html;profile=mcp-app",
          text: "<p>Widget</p>",
        },
        toolCallId: "call-1",
        toolName: "widget",
      }),
    ).toBeNull();
    expect(
      normalizeUiResourcePart({
        type: "ui-resource",
        resource: {
          uri: "ui://widget",
          mimeType: "text/html;profile=mcp-app",
          blob: "A=",
        },
        toolCallId: "call-1",
        toolName: "widget",
      }),
    ).toBeNull();
  });

  test("handles every resource blob without throwing", () => {
    fc.assert(
      fc.property(fc.string(), (blob) => {
        expect(() =>
          normalizeUiResourcePart({
            type: "ui-resource",
            resource: {
              uri: "ui://widget",
              mimeType: "text/html;profile=mcp-app",
              blob,
            },
            toolCallId: "call-1",
            toolName: "widget",
          }),
        ).not.toThrow();
      }),
      propertyConfig(),
    );
  });
});
