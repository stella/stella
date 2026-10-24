import { chat, maxIterations, toolDefinition } from "@tanstack/ai";
import type { ModelMessage, UIMessage } from "@tanstack/ai";
import { ChatClient } from "@tanstack/ai-client";
import { panic, Result } from "better-result";
import { expect, test } from "bun:test";
import * as v from "valibot";

import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";

import type { SafeDb } from "@/api/db/safe-db";
import {
  chatMessageContentFromMessage,
  isChatPart,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import {
  validateMessage,
  validateToolCallParts,
} from "@/api/handlers/chat/chat-schema";
import {
  createPastChatTools,
  PAST_CHAT_SCOPE_TYPE,
  SEARCH_ALL_PAST_CHATS_TOOL_NAME,
} from "@/api/handlers/chat/tools/past-chat-tools";
import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { LIMITS } from "@/api/lib/limits";
import { isRecord } from "@/api/lib/type-guards";
import { createScriptedTextAdapter } from "@/api/tests/helpers/chat-round-trip";

const assistantFromSdk = (candidate: UIMessage | ModelMessage | undefined) => {
  if (candidate === undefined) {
    panic("Missing SDK assistant message");
  }
  if (!("parts" in candidate) || candidate.role !== "assistant") {
    panic("Expected an SDK assistant message");
  }
  return {
    id: toSafeId<"chatMessage">(candidate.id),
    role: candidate.role,
    parts: candidate.parts,
    metadata: candidate.metadata,
  } satisfies Parameters<typeof validateMessage>[0]["message"];
};

const noDbReads: SafeDb = async () =>
  panic("Approval validation must not read the database");
const threadId = toSafeId<"chatThread">("thread-approval-seam");
const userId = toSafeId<"user">("user-approval-seam");
const searchTool = createPastChatTools({
  organizationId: toSafeId<"organization">("org-approval-seam"),
  refRegistry: createChatRefRegistry(),
  safeDb: noDbReads,
  scope: { type: PAST_CHAT_SCOPE_TYPE.allChats },
  threadId,
  userId,
})[SEARCH_ALL_PAST_CHATS_TOOL_NAME];
const noDefaultsTool = toolDefinition({
  name: "approval-without-defaults",
  description: "A tool without defaulted input",
  inputSchema: toTanStackToolSchema(v.strictObject({ query: v.string() })),
}).server(async () => ({ ok: true }));

for (const definition of [searchTool, noDefaultsTool]) {
  for (const approved of [true, false]) {
    test(`accepts the SDK approval resume for ${definition.name} (${approved})`, async () => {
      const executions: unknown[] = [];
      const tool = {
        ...definition,
        needsApproval: true,
        execute: async (input: unknown) => {
          executions.push(input);
          return {
            query: "search phrase",
            scope: PAST_CHAT_SCOPE_TYPE.allChats,
            hint: null,
            results: [],
          };
        },
      };
      const tools = { [tool.name]: tool };
      const adapter = createScriptedTextAdapter([
        {
          type: "tool-call",
          toolName: tool.name,
          toolCallId: "approval-call",
          arguments: '{"query":"search phrase"}',
        },
      ]);
      const submitted =
        Promise.withResolvers<Parameters<typeof validateMessage>[0]>();
      let stored: Parameters<typeof validateMessage>[0]["persistedMessage"] =
        null;
      const client = new ChatClient({
        threadId,
        connection: {
          async *connect(messages, _data, _signal, runContext) {
            if (runContext?.resume !== undefined) {
              submitted.resolve({
                message: assistantFromSdk(messages.at(-1)),
                persistedMessage: stored,
                resume: runContext.resume,
                safeDb: noDbReads,
                threadId,
                tools,
                userId,
              });
              return;
            }
            yield* chat({
              adapter,
              agentLoopStrategy: maxIterations(2),
              messages,
              tools: [tool],
              threadId,
              runId: runContext?.runId,
            });
          },
        },
        onError: submitted.reject,
      });
      await client.sendMessage("Search earlier chats");
      const generated = assistantFromSdk(client.getMessages().at(-1));
      const generatedParts = generated.parts;
      if (!generatedParts.every(isChatPart)) {
        panic("The SDK approval must contain supported chat parts");
      }
      const canonicalParts = validateToolCallParts({
        message: {
          id: generated.id,
          role: generated.role,
          parts: generatedParts,
        },
        tools,
      })
        .unwrap()
        .map((part) => {
          if (part.type !== "tool-call") {
            return part;
          }
          if (part.metadata !== undefined && !isRecord(part.metadata)) {
            panic("Expected object metadata on the validated tool call");
          }
          return {
            ...part,
            metadata: {
              ...part.metadata,
              [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server",
            },
          };
        });
      stored = {
        role: "assistant",
        content: chatMessageContentFromMessage(
          toPersistableChatMessage({
            id: generated.id,
            role: generated.role,
            parts: canonicalParts,
          }),
        ),
      };
      const interrupt = client.getInterrupts().at(0);
      if (interrupt?.kind !== "generic") {
        panic(
          "The dynamically registered server tool must expose a native interrupt",
        );
      }
      const interruptedRunId =
        client.getResumeState()?.runId ?? panic("Missing interrupted run");
      expect(executions).toHaveLength(0);
      interrupt.resolveInterrupt({ approved });
      const request = await submitted.promise;
      const incomingCall = request.message.parts.find(
        (part) =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "tool-call",
      );
      expect(incomingCall).toMatchObject({
        input: { query: "search phrase" },
        state: "approval-responded",
        approval: { approved },
      });
      if (definition.name === SEARCH_ALL_PAST_CHATS_TOOL_NAME) {
        expect(canonicalParts).toContainEqual(
          expect.objectContaining({
            input: {
              query: "search phrase",
              limit: LIMITS.chatHistorySearchPageSizeDefault,
            },
          }),
        );
      }
      const result = await validateMessage(request);
      expect(Result.isOk(result)).toBe(true);
      if (Result.isError(result)) {
        panic(result.error.message);
      }
      expect(result.value.message.parts).toContainEqual(
        expect.objectContaining({
          state: "approval-responded",
          approval: expect.objectContaining({ approved }),
        }),
      );
      const changed = await validateMessage({
        ...request,
        message: {
          ...request.message,
          parts:
            client
              .getMessages()
              .at(-1)
              ?.parts.map((part) =>
                part.type === "tool-call"
                  ? {
                      ...part,
                      input: { query: "different phrase" },
                      arguments: '{"query":"different phrase"}',
                    }
                  : part,
              ) ?? panic("Missing continued message"),
        },
      });
      expect(Result.isError(changed)).toBe(true);

      const resumed = await Array.fromAsync(
        chat({
          adapter: createScriptedTextAdapter([
            { type: "text", text: "Search complete", finishReason: "stop" },
          ]),
          agentLoopStrategy: maxIterations(2),
          messages: [result.value.message],
          tools: [tool],
          threadId,
          runId: "approval-follow-up",
          parentRunId: interruptedRunId,
          resume: request.resume,
        }),
      );
      expect(resumed).toContainEqual(
        expect.objectContaining({ type: "RUN_FINISHED" }),
      );
      expect(executions).toHaveLength(approved ? 1 : 0);
      if (approved) {
        expect(executions.at(0)).toEqual(
          definition.name === SEARCH_ALL_PAST_CHATS_TOOL_NAME
            ? {
                query: "search phrase",
                limit: LIMITS.chatHistorySearchPageSizeDefault,
              }
            : { query: "search phrase" },
        );
      }
    });
  }
}
