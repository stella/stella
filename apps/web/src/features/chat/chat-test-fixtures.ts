import { EventType, uiMessagesToWire } from "@tanstack/ai";
import type { ModelMessage, StreamChunk, UIMessage } from "@tanstack/ai";

type MessagesSnapshotChunk = Extract<
  StreamChunk,
  { type: EventType.MESSAGES_SNAPSHOT }
>;

/** Native wire history uses the SDK serializer without interrupt-time splitting. */
export const buildWireSnapshot = (
  history: readonly (ModelMessage | UIMessage)[],
): MessagesSnapshotChunk => ({
  type: EventType.MESSAGES_SNAPSHOT,
  messages: uiMessagesToWire([...history], {
    includeSnapshotStructuredOutput: true,
  }),
});
