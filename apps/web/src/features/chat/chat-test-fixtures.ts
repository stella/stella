import {
  EventType,
  uiMessagesToWire,
  withInterruptBinding,
} from "@tanstack/ai";
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

type ToolApprovalFixtureOptions = {
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
};

export const buildToolApprovalInterrupt = ({
  id,
  runId,
  toolCallId,
  toolName,
  input,
}: ToolApprovalFixtureOptions) =>
  withInterruptBinding(
    {
      id,
      reason: "approval_required",
      toolCallId,
      metadata: { kind: "approval", toolName, input },
    },
    {
      v: 1,
      kind: "tool-approval",
      interruptId: id,
      interruptedRunId: runId,
      generation: 0,
      toolCallId,
      toolName,
      originalArgs: input,
      inputSchemaHash: "server-owned",
      approvalSchemaHash: "server-owned",
      responseSchemaHash: "server-owned",
    },
  );
