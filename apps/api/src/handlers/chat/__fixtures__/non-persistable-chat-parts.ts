/** Every `MessagePart` variant excluded from `PersistableChatPart`. Shared so a
 *  new non-persistable type is added in one place, not per test file. */
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
