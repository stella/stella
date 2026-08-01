/** Every `MessagePart` variant explicitly dropped by the persistence policy.
 * Shared so a future TanStack union change cannot update one stream-path test
 * in isolation. */
export const nonPersistableChatParts = [
  {
    type: "audio",
    source: { type: "url", value: "https://example.test/a.mp3" },
  },
  {
    type: "video",
    source: { type: "url", value: "https://example.test/v.mp4" },
  },
  {
    type: "ui-resource",
    resource: { uri: "ui://widget", mimeType: "text/html" },
    toolCallId: "call-1",
    toolName: "widget",
  },
] as const;
