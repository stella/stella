import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { IntlProvider } from "use-intl";

import { propertyConfig } from "@stll/property-testing";

import type { RichChatPart } from "@/components/chat/chat-rich-message-part";
import messages from "@/i18n/langs/en.json";
import type Messages from "@/i18n/langs/messages.gen";

process.env["VITE_API_URL"] ??= "https://api.example.test";

const unsafeScriptUrl = ["java", "script:alert(1)"].join("");

const {
  ChatRichMessagePart,
  RichContentErrorBoundary,
  normalizeUiResourcePart,
  toRenderableMediaSource,
} = await import("@/components/chat/chat-rich-message-part");

const renderMediaPart = (part: RichChatPart) =>
  renderToStaticMarkup(
    createElement(IntlProvider, {
      children: createElement(ChatRichMessagePart, { part }),
      locale: "en",
      // SAFETY: this mirrors the app provider boundary; locale files are
      // checked separately, while use-intl preserves English literal values.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      messages: messages as Messages,
      timeZone: "UTC",
    }),
  );

describe("rich chat message parts", () => {
  test("renders the local fallback after a rich-part failure", () => {
    const boundary = new RichContentErrorBoundary({
      children: createElement("div", null, "interactive resource"),
      fallback: createElement("div", null, "rich content unavailable"),
    });

    expect(renderToStaticMarkup(boundary.render())).toContain(
      "interactive resource",
    );

    boundary.state = RichContentErrorBoundary.getDerivedStateFromError();

    expect(renderToStaticMarkup(boundary.render())).toContain(
      "rich content unavailable",
    );
  });

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

  test("does not advertise a caption track when no captions were provided", () => {
    const audio = renderMediaPart({
      type: "audio",
      source: {
        type: "url",
        value: "https://example.test/audio.mp3",
        mimeType: "audio/mpeg",
      },
    });
    const video = renderMediaPart({
      type: "video",
      source: {
        type: "url",
        value: "https://example.test/video.mp4",
        mimeType: "video/mp4",
      },
    });

    expect(audio).toContain("<audio");
    expect(video).toContain("<video");
    expect(audio).not.toContain("<track");
    expect(video).not.toContain("<track");
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
