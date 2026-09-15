import { modelMessageToUIMessage, uiMessagesToWire } from "@tanstack/ai/client";
import { Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import type { SafeDb } from "@/api/db/safe-db";
import {
  chatMessageContentFromMessage,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { validateMessage } from "@/api/handlers/chat/chat-schema";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { toSafeId } from "@/api/lib/branded-types";
import type { ChatToolMap } from "@/api/lib/chat/chat-tool-types";

const CALL_ID = "call_seam_suggest_changes";
const TOOL_NAME = "suggest_changes";
const MESSAGE_ID = toSafeId<"chatMessage">("msg_seam_suggest_changes");
const ACCEPTED = "accepted";
const REJECTED = "Chat continuation does not match its awaited interaction";
const OUTPUT = { ok: true, queued: ["op-1", "op-2"] };

const noDbReads: SafeDb = async () => {
  throw new Error("This validation path should not read the database");
};

const clientTools = {
  [TOOL_NAME]: {
    name: TOOL_NAME,
    description: "Propose document edits for review",
    inputSchema: toTanStackToolSchema(
      v.looseObject({
        operations: v.array(v.looseObject({ type: v.string() })),
      }),
    ),
  },
} satisfies ChatToolMap;

/**
 * The provider's own text for the call. A strict tool schema forces every
 * property into `required` and widens absent optionals with `null`, and the
 * model's whitespace and key order are its own, not `JSON.stringify`'s.
 */
const providerArguments = (blockIds: readonly [string, string]): string =>
  `{
  "documentVersion": null,
  "operations": [
    { "severity": "medium", "type": "deleteBlock", "blockId": ${JSON.stringify(blockIds[0])},
      "area": "Profiling", "comment": null, "moveId": null, "precondition": null },
    { "severity": "low", "type": "deleteBlock", "blockId": ${JSON.stringify(blockIds[1])},
      "area": "Retention", "comment": null, "moveId": null, "precondition": null }
  ]
}`;

const CANONICAL_BLOCK_IDS = ["b_42", "b_43"] as const;

/**
 * The persisted assistant message, built the way the run builds it: the raw
 * provider text plus the adapter's parse of it, through the real v3 write path.
 */
const persistedAssistantContent = () =>
  chatMessageContentFromMessage(
    toPersistableChatMessage({
      id: MESSAGE_ID,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: CALL_ID,
          name: TOOL_NAME,
          arguments: providerArguments(CANONICAL_BLOCK_IDS),
          input: {
            operations: [
              {
                type: "deleteBlock",
                blockId: "b_42",
                severity: "medium",
                area: "Profiling",
              },
              {
                type: "deleteBlock",
                blockId: "b_43",
                severity: "low",
                area: "Retention",
              },
            ],
          },
          state: "input-complete",
        },
      ],
    }),
  );

/**
 * The continuation parts the browser sends back, derived rather than written
 * out: server UI message to AG-UI wire (`uiMessagesToWire`), wire back to a UI
 * message (`modelMessageToUIMessage`, which is what the snapshot normalizer
 * delegates to for an assistant message), then `addToolResult`'s edit. The wire
 * carries only `arguments`, so the rebuilt part's `input` is a re-parse of the
 * provider's text, nulls and all: that is the seam this binds.
 */
const clientContinuationParts = (rawArguments: string) => {
  const wireAnchor = uiMessagesToWire([
    {
      id: MESSAGE_ID,
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: CALL_ID,
          name: TOOL_NAME,
          arguments: rawArguments,
          state: "input-complete",
        },
      ],
    },
  ]).at(0);
  if (wireAnchor === undefined || wireAnchor.role !== "assistant") {
    throw new Error("The snapshot wire message lost its assistant anchor");
  }

  const rebuiltCall = modelMessageToUIMessage(
    {
      role: "assistant",
      content: wireAnchor.content ?? null,
      ...(wireAnchor.toolCalls && { toolCalls: wireAnchor.toolCalls }),
    },
    wireAnchor.id,
  ).parts.find((part) => part.type === "tool-call");
  if (rebuiltCall === undefined) {
    throw new Error("The rebuilt UI message lost its tool call");
  }

  return [
    { ...rebuiltCall, output: OUTPUT, state: "complete" },
    {
      type: "tool-result",
      toolCallId: CALL_ID,
      content: JSON.stringify(OUTPUT),
      state: "complete",
    },
  ];
};

const continuationOutcome = async (rawArguments: string): Promise<string> => {
  const result = await validateMessage({
    message: {
      id: MESSAGE_ID,
      role: "assistant",
      parts: clientContinuationParts(rawArguments),
    },
    persistedMessage: {
      role: "assistant",
      content: persistedAssistantContent(),
    },
    resume: [
      {
        interruptId: `client_tool_${CALL_ID}`,
        payload: OUTPUT,
        status: "resolved",
      },
    ],
    safeDb: noDbReads,
    threadId: toSafeId<"chatThread">("thread_seam_suggest_changes"),
    tools: clientTools,
    userId: toSafeId<"user">("user_seam_suggest_changes"),
  });
  return Result.isOk(result) ? ACCEPTED : result.error.message;
};

test("accepts the continuation the client library rebuilds from the snapshot", async () => {
  expect(
    await continuationOutcome(providerArguments(CANONICAL_BLOCK_IDS)),
  ).toBe(ACCEPTED);
});

test("rejects a continuation whose rebuilt call edits a different block", async () => {
  expect(await continuationOutcome(providerArguments(["b_42", "b_99"]))).toBe(
    REJECTED,
  );
});
