/** Rich output variants emitted by TanStack that Stella persists for the UI.
 * Shared so stream, property, and boundary tests exercise one canonical shape. */
export const richChatParts = [
  {
    type: "audio",
    source: {
      type: "url",
      value: "https://example.test/a.mp3",
      mimeType: "audio/mpeg",
    },
  },
  {
    type: "video",
    source: {
      type: "url",
      value: "https://example.test/v.mp4",
      mimeType: "video/mp4",
    },
  },
  {
    type: "ui-resource",
    resource: {
      uri: "ui://widget",
      mimeType: "text/html;profile=mcp-app",
      text: "<p>Widget</p>",
    },
    toolCallId: "call-1",
    toolName: "widget",
  },
] as const;

export const unsafeScriptUrl = ["java", "script:alert(1)"].join("");
