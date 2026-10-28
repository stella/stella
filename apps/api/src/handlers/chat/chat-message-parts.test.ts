import type { ToolResultOutcome } from "@tanstack/ai";
import {
  convertMessagesToModelMessages,
  StreamProcessor,
  uiMessagesToWire,
} from "@tanstack/ai";
import { Panic, Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CHAT_RICH_PART_LIMITS,
  RESOURCE_TYPE,
  resourceRef,
} from "@stll/api-contract";
import { BROWSER_CONTROL_TOOL_NAME } from "@stll/api-contract/browser-control";
import {
  ASK_USER_TOOL_NAME,
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
  chatToolExecutor,
  CREATE_DOCUMENT_TOOL_NAME,
  createChatPastedTextPart,
  isServerChatToolCall,
} from "@stll/api-contract/chat";
import { REQUEST_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";
import { FOLIO_AGENT_TOOL_NAMES } from "@stll/folio-agents";
import { assertProperty } from "@stll/property-testing";

import {
  applyChatPartPersistenceBudget,
  attachTerminalTurnOutcome,
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  classifyChatPartForPersistence,
  createChatTextPart,
  getAwaitingUserInteraction,
  getAwaitingUserInteractions,
  getResumedUserInteraction,
  isChatAttachmentPart,
  isChatPart,
  isIncomingChatPart,
  isProviderVisibleChatPart,
  isServerOwnedChatPart,
  mergeAnonRestorations,
  normalizePersistedChatMessageContent,
  restoreServerOwnedChatParts,
  toPersistableChatMessage,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import { assembleMessageMarkdown } from "@/api/handlers/chat/export/export-shared";
import { clientMessageFromPageRow } from "@/api/handlers/chat/message-page";
import type {
  ChatPart,
  ChatTurnOutcome,
  PersistableChatMessageCandidate,
} from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { CHAT_REF_ENCODING } from "@/api/lib/chat/ref-token";
import { LIMITS } from "@/api/lib/limits";

import { richChatParts, unsafeScriptUrl } from "./__fixtures__/rich-chat-parts";

test("pasted text reaches the model exactly like native text", () => {
  const content = " \r\n<p>literal &amp; text</p>\n\t ";
  const part = createChatPastedTextPart(content);
  expect(new StreamProcessor().addUserMessage([part]).parts).toEqual([part]);
  const message = toPersistableChatMessage({
    id: toSafeId<"chatMessage">("msg_pasted_model"),
    role: "user",
    parts: [part],
  });
  expect(isIncomingChatPart(part)).toBe(true);
  expect(isProviderVisibleChatPart(part)).toBe(true);
  expect(uiMessagesToWire([message])).toEqual([
    { id: message.id, role: "user", content },
  ]);
  expect(convertMessagesToModelMessages([message])).toEqual(
    convertMessagesToModelMessages([
      { ...message, parts: [{ type: "text", content }] },
    ]),
  );
});

const budgetPropertyPartFromKind = (kind: number): ChatPart => {
  switch (kind) {
    case 1:
      return richChatParts[0];
    case 2:
      return richChatParts[1];
    case 3:
      return richChatParts[2];
    default:
      return createChatTextPart(String(kind));
  }
};

describe("persisted chat message parts", () => {
  test.each(["", " ", "\n\t", "\u00a0\u2003"])(
    "keeps invisible assistant text out of persistence: %j",
    (blank) => {
      const thinking: ChatPart = {
        type: "thinking",
        content: "Reviewing the clause.",
      };
      const answer = createChatTextPart(" \nAnswer.\t ");
      const parts: ChatPart[] = [thinking, createChatTextPart(blank), answer];
      const message: PersistableChatMessageCandidate = {
        id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
        parts,
        role: "assistant",
      };
      expect(toPersistableChatMessage(message).parts).toEqual([
        thinking,
        answer,
      ]);
      expect(
        toPersistableChatMessage({ ...message, role: "user" }).parts,
      ).toEqual(parts);
    },
  );

  test("stores one canonical parsed tool-call representation", () => {
    const input = { query: "nda" };
    const output = { results: [{ id: "document-1" }] };
    const parts = [
      {
        arguments: JSON.stringify(input),
        id: "search-1",
        input,
        name: "mcp__external__search",
        output,
        state: "complete",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
      {
        content: JSON.stringify(output),
        state: "complete",
        toolCallId: "search-1",
        type: "tool-result",
      },
    ] as const satisfies ChatPart[];

    const persisted = toPersistedChatMessageContentV3({
      data: [...parts],
    });

    expect(persisted.version).toBe(3);
    const persistedCall = persisted.data.at(0);
    expect(persistedCall?.type).toBe("tool-call");
    if (persistedCall?.type !== "tool-call") {
      return;
    }
    expect(persistedCall.input.status).toBe("parsed");
    if (persistedCall.input.status !== "parsed") {
      return;
    }
    expect(persistedCall.input.value).toEqual(input);
    expect(persistedCall.output?.value).toEqual(output);
    expect(persisted.data.at(1)).toEqual({
      state: "complete",
      toolCallId: "search-1",
      type: "tool-result",
    });
    expect(normalizePersistedChatMessageContent(persisted).parts).toEqual(
      parts,
    );
  });

  test("preserves raw arguments only while tool input is partial", () => {
    const part = {
      arguments: '{"query":"nd',
      id: "search-streaming",
      name: "mcp__external__search",
      state: "input-streaming",
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
      type: "tool-call",
    } as const satisfies ChatPart;

    const persisted = toPersistedChatMessageContentV3({
      data: [part],
    });

    expect(persisted.data).toEqual([
      {
        id: "search-streaming",
        input: { rawArguments: '{"query":"nd', status: "raw" },
        name: "mcp__external__search",
        state: "input-streaming",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
    ]);
    expect(normalizePersistedChatMessageContent(persisted).parts).toEqual([
      part,
    ]);
  });

  test("stores paired rich tool output once without flattening its parts", () => {
    const output = [
      { content: "Generated evidence", type: "text" },
      {
        source: {
          mimeType: "image/png",
          type: "url",
          value: "https://example.test/evidence.png",
        },
        type: "image",
      },
      {
        source: {
          mimeType: "audio/mpeg",
          type: "url",
          value: "https://example.test/evidence.mp3",
        },
        type: "audio",
      },
      {
        source: {
          mimeType: "video/mp4",
          type: "url",
          value: "https://example.test/evidence.mp4",
        },
        type: "video",
      },
      {
        source: {
          mimeType: "application/pdf",
          type: "url",
          value: "https://example.test/evidence.pdf",
        },
        type: "document",
      },
    ] satisfies Extract<ChatPart, { type: "tool-result" }>["content"];
    const parts = [
      {
        arguments: "{}",
        id: "rich-output",
        input: {},
        name: "mcp__external__evidence",
        output,
        state: "complete",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
      {
        content: output,
        state: "complete",
        toolCallId: "rich-output",
        type: "tool-result",
      },
    ] as const satisfies ChatPart[];

    const persisted = toPersistedChatMessageContentV3({ data: [...parts] });

    expect(persisted.data.at(1)).toEqual({
      content: { type: "paired-output-parts" },
      state: "complete",
      toolCallId: "rich-output",
      type: "tool-result",
    });
    expect(normalizePersistedChatMessageContent(persisted).parts).toEqual(
      parts,
    );
  });

  test("keeps ordinary JSON-array output as textual tool-result content", () => {
    const output = [{ id: "document-1" }];
    const parts = [
      {
        arguments: "{}",
        id: "json-array-output",
        input: {},
        name: "mcp__external__list",
        output,
        state: "complete",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
      {
        content: JSON.stringify(output),
        state: "complete",
        toolCallId: "json-array-output",
        type: "tool-result",
      },
    ] as const satisfies ChatPart[];

    const persisted = toPersistedChatMessageContentV3({ data: [...parts] });

    expect(persisted.data.at(1)).toEqual({
      state: "complete",
      toolCallId: "json-array-output",
      type: "tool-result",
    });
    expect(normalizePersistedChatMessageContent(persisted).parts).toEqual(
      parts,
    );
  });

  test("preserves unavailable input for a terminal error call", () => {
    const persisted = toPersistedChatMessageContentV3({
      data: [
        {
          arguments: '{"query":',
          id: "failed-input",
          name: "mcp__external__search",
          output: { error: "Invalid arguments" },
          state: "error",
          metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
          type: "tool-call",
        },
      ],
    });

    expect(persisted.data.at(0)).toMatchObject({
      id: "failed-input",
      input: { rawArguments: '{"query":', status: "raw" },
      state: "error",
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
      type: "tool-call",
    });
  });

  test("preserves string result content that differs from canonical output", () => {
    const parts = [
      {
        arguments: "{}",
        id: "formatted-output",
        input: {},
        name: "mcp__external__search",
        output: { value: "canonical" },
        state: "complete",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
      {
        content: "Provider-formatted result",
        state: "complete",
        toolCallId: "formatted-output",
        type: "tool-result",
      },
    ] as const satisfies ChatPart[];

    const persisted = toPersistedChatMessageContentV3({ data: [...parts] });

    expect(persisted.data.at(1)).toEqual({
      content: { type: "text", value: "Provider-formatted result" },
      state: "complete",
      toolCallId: "formatted-output",
      type: "tool-result",
    });
    expect(normalizePersistedChatMessageContent(persisted).parts).toEqual(
      parts,
    );
  });

  test("preserves independent rich result content beside terminal call output", () => {
    const persisted = toPersistedChatMessageContentV3({
      data: [
        {
          arguments: "{}",
          id: "mismatched-output",
          input: {},
          name: "mcp__external__search",
          output: [{ content: "canonical", type: "text" }],
          state: "complete",
          metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
          type: "tool-call",
        },
        {
          content: [{ content: "stale", type: "text" }],
          state: "complete",
          toolCallId: "mismatched-output",
          type: "tool-result",
        },
      ],
    });
    expect(normalizePersistedChatMessageContent(persisted).parts.at(1)).toEqual(
      {
        content: [{ content: "stale", type: "text" }],
        state: "complete",
        toolCallId: "mismatched-output",
        type: "tool-result",
      },
    );
  });

  test("rejects malformed v3 parsed input at the database boundary", () => {
    const persisted = toPersistedChatMessageContentV3({
      data: [
        {
          arguments: "{}",
          id: "malformed-row",
          input: {},
          name: "mcp__external__search",
          state: "input-complete",
          metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
          type: "tool-call",
        },
      ],
    });
    const call = persisted.data.at(0);
    if (call === undefined) {
      return;
    }
    Reflect.set(call, "input", { status: "parsed", value: new Date() });

    expect(() => normalizePersistedChatMessageContent(persisted)).toThrow(
      "Cannot mark an invalid tool input as parsed",
    );
  });

  test("rejects non-JSON canonical tool output", () => {
    expect(() =>
      chatMessageContentFromMessage(
        toPersistableChatMessage({
          id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111112"),
          parts: [
            {
              arguments: "{}",
              id: "invalid-output",
              input: {},
              name: "mcp__external__search",
              output: new Date("2026-01-01T00:00:00.000Z"),
              state: "complete",
              metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
              type: "tool-call",
            },
          ],
          role: "assistant",
        }),
      ),
    ).toThrow("Cannot mark an invalid tool output as parsed");
  });

  test("classifies every ask-user tool-call state for turn ownership", () => {
    type ToolCallState = Extract<ChatPart, { type: "tool-call" }>["state"];

    const getInteractionForState = (state: ToolCallState) => {
      const call = {
        arguments: '{"question":"Which jurisdiction applies?"}',
        id: `ask-${state}`,
        name: "ask-user",
        state,
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      } satisfies ChatPart;

      return getAwaitingUserInteraction({
        parts: [call],
        role: "assistant",
      });
    };

    expect({
      "approval-requested": getInteractionForState("approval-requested"),
      "approval-responded": getInteractionForState("approval-responded"),
      "awaiting-input": getInteractionForState("awaiting-input"),
      complete: getInteractionForState("complete"),
      error: getInteractionForState("error"),
      "input-complete": getInteractionForState("input-complete"),
      "input-streaming": getInteractionForState("input-streaming"),
    } satisfies Record<
      ToolCallState,
      ReturnType<typeof getInteractionForState>
    >).toEqual({
      "approval-requested": {
        toolCallId: "ask-approval-requested",
        type: "approval",
      },
      "approval-responded": null,
      "awaiting-input": null,
      complete: null,
      error: null,
      "input-complete": {
        toolCallId: "ask-input-complete",
        type: "ask-user",
      },
      "input-streaming": null,
    } as const satisfies Record<
      ToolCallState,
      ReturnType<typeof getInteractionForState>
    >);
  });

  test("keeps every pending approval actionable", () => {
    const parts = [
      {
        arguments: '{"title":"First"}',
        id: "approval-first",
        name: "create-document",
        state: "approval-requested",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
      {
        arguments: '{"title":"Second"}',
        id: "approval-second",
        name: "create-document",
        state: "approval-requested",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
    ] as const satisfies ChatPart[];

    expect(
      getAwaitingUserInteractions({ parts: [...parts], role: "assistant" }),
    ).toEqual([
      { toolCallId: "approval-first", type: "approval" },
      { toolCallId: "approval-second", type: "approval" },
    ]);
  });

  test("executor ownership excludes deferred servers but keeps approvals and client calls", () => {
    const server = {
      arguments: "{}",
      id: "server",
      name: "list_templates",
      state: "input-complete",
      type: "tool-call",
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
    } as const;
    const client = {
      ...server,
      id: "client",
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
    };
    const approval = {
      ...server,
      id: "approval",
      state: "approval-requested",
    } as const;
    expect(
      getAwaitingUserInteractions({
        role: "assistant",
        parts: [server, client, approval],
      }),
    ).toEqual([
      { toolCallId: "client", type: "client-tool" },
      { toolCallId: "approval", type: "approval" },
    ]);
  });

  test("stored calls require an executor and preserve both ownership tags", () => {
    const call = {
      arguments: "{}",
      input: {},
      id: "call",
      name: "list_templates",
      state: "input-complete",
      type: "tool-call",
    } as const;
    expect(() => toPersistedChatMessageContentV3({ data: [call] })).toThrow(
      "Cannot persist a tool call without executor ownership",
    );
    for (const executor of ["client", "server"] as const) {
      const tagged = {
        ...call,
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: executor },
      };
      const content = toPersistedChatMessageContentV3({ data: [tagged] });
      const parts = normalizePersistedChatMessageContent(content).parts;
      expect(parts).toEqual([tagged]);
      expect(getAwaitingUserInteractions({ role: "assistant", parts })).toEqual(
        executor === "client"
          ? [{ toolCallId: call.id, type: "client-tool" }]
          : [],
      );
    }
  });

  test("older v3 calls retain fixed ownership across canonical rewrites", () => {
    const definitions = [
      { name: "list_templates", executor: "server" },
      { name: "mcp__external__lookup", executor: "server" },
      { name: "mcp__unregistered__lookup", executor: "server" },
      ...Object.values(FOLIO_AGENT_TOOL_NAMES)
        .filter(
          (name) =>
            name !== FOLIO_AGENT_TOOL_NAMES.readPage &&
            name !== FOLIO_AGENT_TOOL_NAMES.readSelection &&
            name !== FOLIO_AGENT_TOOL_NAMES.scrollToBlock,
        )
        .map((name) => ({ name, executor: "client" }) as const),
      ...(
        [
          ASK_USER_TOOL_NAME,
          CREATE_DOCUMENT_TOOL_NAME,
          REQUEST_SECRET_TOOL_NAME,
          BROWSER_CONTROL_TOOL_NAME,
        ] as const
      ).map((name) => ({ name, executor: "client" }) as const),
    ] as const;
    for (const { name, executor } of definitions) {
      const call = {
        arguments: "{}",
        input: {},
        id: "call",
        name,
        state: "input-complete",
        type: "tool-call",
        metadata: { provider: "retained" },
      } as const;
      const tagged = {
        ...call,
        metadata: {
          ...call.metadata,
          [CHAT_TOOL_EXECUTOR_METADATA_KEY]: executor,
        },
      };
      const current = toPersistedChatMessageContentV3({ data: [tagged] });
      const stored = current.data.at(0);
      expect(stored?.type).toBe("tool-call");
      if (stored?.type !== "tool-call") {
        continue;
      }
      const { metadata: _metadata, ...untagged } = stored;
      const contentWithoutMetadata = {
        ...current,
        data: [untagged],
      };
      const contentWithProviderMetadata = {
        ...current,
        data: [{ ...untagged, metadata: call.metadata }],
      };
      const contents = [
        current,
        contentWithProviderMetadata,
        contentWithoutMetadata,
      ];
      for (const content of contents) {
        const parts = normalizePersistedChatMessageContent(content).parts;
        expect(parts.at(0)).toMatchObject({ type: "tool-call" });
        if (content !== contentWithoutMetadata) {
          expect(parts.at(0)).toMatchObject({
            metadata: { provider: "retained" },
          });
        }
        expect(chatToolExecutor(parts.at(0))).toBe(executor);
        expect(isServerChatToolCall(parts.at(0))).toBe(executor === "server");
        expect(
          getAwaitingUserInteractions({ role: "assistant", parts }),
        ).toEqual(
          executor === "server"
            ? []
            : [
                {
                  toolCallId: call.id,
                  type:
                    name === ASK_USER_TOOL_NAME ? "ask-user" : "client-tool",
                },
              ],
        );
        const written = toPersistedChatMessageContentV3({ data: parts });
        expect(normalizePersistedChatMessageContent(written).parts).toEqual(
          parts,
        );
      }
      // Recorded ownership remains authoritative even for an alternate registration.
      const override = {
        ...call,
        metadata: {
          [CHAT_TOOL_EXECUTOR_METADATA_KEY]:
            executor === "server" ? "client" : "server",
        },
      };
      expect(
        normalizePersistedChatMessageContent(
          toPersistedChatMessageContentV3({ data: [override] }),
        ).parts,
      ).toEqual([override]);
    }
  });

  test("malformed stored tool metadata is rejected as corrupted state", () => {
    const call = {
      type: "tool-call",
      name: "list_templates",
      id: "call",
      state: "complete",
      arguments: "{}",
      input: {},
      output: {},
    } as const;
    const canonical = toPersistedChatMessageContentV3({
      data: [
        { ...call, metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" } },
      ],
    });
    const stored = canonical.data.at(0);
    expect(stored?.type).toBe("tool-call");
    if (stored?.type !== "tool-call") {
      return;
    }
    const { metadata: _metadata, ...untagged } = stored;
    for (const metadata of [
      null,
      "provider",
      42,
      [],
      { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "unknown" },
    ]) {
      const content = { ...canonical, data: [{ ...untagged, metadata }] };
      const result = Result.try({
        try: () => normalizePersistedChatMessageContent(content),
        catch: (error) => error,
      });
      expect(Result.isError(result)).toBe(true);
      if (Result.isError(result)) {
        expect(result.error).toBeInstanceOf(Panic);
        if (result.error instanceof Panic) {
          expect(result.error.message).toContain(
            "Stored tool call has invalid",
          );
        }
      }
    }
  });

  test("completed stored tool calls render and export without a tool catalog", () => {
    const call = {
      type: "tool-call",
      id: "completed-server",
      name: "list_templates",
      arguments: "{}",
      input: {},
      state: "complete",
      output: { templates: [{ name: "Template" }] },
      metadata: {
        provider: "legacy",
        [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server",
      },
    } as const;
    const result = {
      type: "tool-result",
      toolCallId: call.id,
      state: "complete",
      content: JSON.stringify(call.output),
    } as const;
    const markdown = "# Templates\n\nOne template is available.";
    const text = createChatTextPart(markdown);
    const content = toPersistedChatMessageContentV3({
      data: [call, result, text],
    });
    const page = clientMessageFromPageRow(
      {
        content,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        id: toSafeId<"chatMessage">("msg_legacy_completed"),
        role: "assistant",
        revision: 0,
      },
      new Map(),
    );
    const expected = [
      {
        ...call,
        metadata: {
          ...call.metadata,
          [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server",
        },
      },
      result,
      text,
    ];
    expect(page.parts).toEqual(expected);
    expect(getAwaitingUserInteractions(page)).toEqual([]);
    const exported = normalizePersistedChatMessageContent(content).parts;
    expect(exported).toEqual(page.parts);
    expect(assembleMessageMarkdown(exported)).toBe(markdown);
  });

  test("prefers an explicit approval response over an unchanged ask-user call", () => {
    const parts = [
      {
        arguments:
          '{"analysis":"Need jurisdiction","questions":[{"question":"Which court?","reason":"Jurisdiction determines the law."}]}',
        id: "ask-1",
        input: {
          analysis: "Need jurisdiction",
          questions: [
            {
              question: "Which court?",
              reason: "Jurisdiction determines the law.",
            },
          ],
        },
        name: "ask-user",
        state: "input-complete",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
      {
        arguments: '{"name":"Agreement","source":"@title Agreement"}',
        id: "approval-1",
        input: { name: "Agreement", source: "@title Agreement" },
        name: "create-document",
        state: "approval-responded",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
    ] as const satisfies ChatPart[];

    expect(
      getAwaitingUserInteractions({ parts: [...parts], role: "assistant" }),
    ).toEqual([{ toolCallId: "ask-1", type: "ask-user" }]);
    expect(
      getResumedUserInteraction({
        awaited: [
          { toolCallId: "ask-1", type: "ask-user" },
          { toolCallId: "approval-1", type: "approval" },
        ],
        message: { parts: [...parts], role: "assistant" },
      }),
    ).toEqual({ toolCallId: "approval-1", type: "approval" });
  });

  test("awaits a client-executed tool call whose input is complete", () => {
    const parts = [
      {
        arguments: '{"query":"nda"}',
        id: "search-1",
        input: { query: "nda" },
        name: "mcp__external__search",
        output: { matters: [] },
        state: "complete",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
      {
        arguments: '{"name":"NDA","source":"@title NDA"}',
        id: "draft-1",
        input: { name: "NDA", source: "@title NDA" },
        name: "create-document",
        state: "input-complete",
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
        type: "tool-call",
      },
    ] as const satisfies ChatPart[];

    expect(
      getAwaitingUserInteractions({ parts: [...parts], role: "assistant" }),
    ).toEqual([{ toolCallId: "draft-1", type: "client-tool" }]);
  });

  test("resolves a client-tool interaction only through its awaited call", () => {
    const awaited = [
      { toolCallId: "draft-1", type: "client-tool" },
    ] as const satisfies Parameters<
      typeof getResumedUserInteraction
    >[0]["awaited"];
    const resolvedDraft = {
      arguments: '{"name":"NDA","source":"@title NDA"}',
      id: "draft-1",
      input: { name: "NDA", source: "@title NDA" },
      name: "create-document",
      output: { destination: "draft", fileName: "NDA.docx", success: true },
      state: "complete",
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
      type: "tool-call",
    } as const satisfies ChatPart;
    // A completed server tool after the awaited call is not an answer.
    const completedServerCall = {
      arguments: '{"query":"nda"}',
      id: "search-1",
      input: { query: "nda" },
      name: "mcp__external__search",
      output: { matters: [] },
      state: "complete",
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "client" },
      type: "tool-call",
    } as const satisfies ChatPart;

    expect(
      getResumedUserInteraction({
        awaited,
        message: {
          parts: [resolvedDraft, completedServerCall],
          role: "assistant",
        },
      }),
    ).toEqual({ toolCallId: "draft-1", type: "client-tool" });
    // A cancelled native resume leaves the awaited call untouched; the turn
    // still names its owner so the execution claim can proceed.
    const { output: _output, ...untouchedDraft } = resolvedDraft;
    expect(
      getResumedUserInteraction({
        awaited,
        message: {
          parts: [{ ...untouchedDraft, state: "input-complete" }],
          role: "assistant",
        },
      }),
    ).toEqual({ toolCallId: "draft-1", type: "client-tool" });
    expect(
      getResumedUserInteraction({
        awaited: [],
        message: { parts: [resolvedDraft], role: "assistant" },
      }),
    ).toBeNull();
  });

  test("preserves activity payloads through persistence and reload without provider exposure", () => {
    const part = {
      activityType: "progress",
      content: { completed: 2, steps: ["read", "write"] },
      subagentRunId: "child-run",
      type: "activity",
    } as const satisfies ChatPart;
    const stored = toPersistedChatMessageContentV3({ data: [part] });
    expect(normalizePersistedChatMessageContent(stored).parts).toEqual([part]);
    expect(isProviderVisibleChatPart(part)).toBe(false);
    expect(isIncomingChatPart(part)).toBe(false);
    expect(() =>
      classifyChatPartForPersistence({
        ...part,
        content: { completed: undefined },
      }),
    ).toThrow("Cannot persist malformed chat part type: activity");
  });

  test("persists every structured-output terminal and streaming state", () => {
    const parts = [
      { raw: '{"answer":', status: "streaming", type: "structured-output" },
      {
        data: { answer: 42 },
        raw: '{"answer":42}',
        status: "complete",
        type: "structured-output",
      },
      {
        errorMessage: "Invalid structured output",
        raw: "not-json",
        status: "error",
        type: "structured-output",
      },
    ] as const satisfies ChatPart[];

    expect(
      toPersistableChatMessage({
        id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
        parts: [...parts],
        role: "assistant",
      }).parts,
    ).toEqual(parts);
  });

  test("rejects malformed structured-output states at the persistence boundary", () => {
    const malformedParts = [
      { raw: "{}", status: "future", type: "structured-output" },
      { raw: 42, status: "streaming", type: "structured-output" },
      {
        raw: "{}",
        reasoning: 42,
        status: "streaming",
        type: "structured-output",
      },
      { raw: "{}", status: "complete", type: "structured-output" },
      { raw: "{}", status: "error", type: "structured-output" },
      {
        errorMessage: 42,
        raw: "{}",
        status: "error",
        type: "structured-output",
      },
    ];

    for (const part of malformedParts) {
      // Every fixture keeps type: "structured-output", so persistence
      // rejects each the same way (see the invalidHandling !== "drop" panic).
      expect(() => classifyChatPartForPersistence(part)).toThrow(
        "Cannot persist malformed chat part type: structured-output",
      );
    }
  });

  test("preserves server-owned search-summary provenance", () => {
    const message = chatMessageFromPersisted({
      id: toSafeId<"chatMessage">("019eb9fa-c91f-7000-9b9c-9365977dda78"),
      role: "assistant",
      content: toPersistedChatMessageContentV3({
        data: [{ type: "text", content: "Summary" }],
        metadata: {
          serverProvenance: { type: "search-summary", version: 1 },
        },
      }),
    });

    expect(message.metadata).toEqual({
      serverProvenance: { type: "search-summary", version: 1 },
    });
  });

  test("preserves server-owned ref metadata", () => {
    const entityId = toSafeId<"entity">("entity-1");
    const workspaceId = toSafeId<"workspace">("workspace-1");
    const refContext = {
      version: 1 as const,
      entities: [
        {
          entity: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
          toolCallId: "tool-1",
          workspace: resourceRef({
            type: RESOURCE_TYPE.WORKSPACE,
            id: workspaceId,
          }),
        },
      ],
      unresolvedInputs: [],
      workspaceScope: [],
    };
    const message = chatMessageFromPersisted({
      id: toSafeId<"chatMessage">("019eb9fa-c91f-7000-9b9c-9365977dda80"),
      role: "assistant",
      content: toPersistedChatMessageContentV3({
        data: [{ type: "text", content: "Summary" }],
        metadata: {
          refContext,
          refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
        },
      }),
    });

    expect(message.metadata).toEqual({
      refContext,
      refEncoding: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
    });
  });

  test("preserves usage-only metadata", () => {
    const message = chatMessageFromPersisted({
      id: toSafeId<"chatMessage">("019eb9fa-c91f-7000-9b9c-9365977dda79"),
      role: "assistant",
      content: toPersistedChatMessageContentV3({
        data: [{ type: "text", content: "Ahoj" }],
        metadata: {
          usage: {
            completionTokens: 20,
            completionTokensDetails: { reasoningTokens: 12 },
            promptTokens: 10,
            totalTokens: 30,
          },
        },
      }),
    });

    expect(message.metadata).toEqual({
      usage: {
        completionTokens: 20,
        completionTokensDetails: { reasoningTokens: 12 },
        promptTokens: 10,
        totalTokens: 30,
      },
    });
  });
});

test("native resume identity survives persistence only while the turn awaits the user", () => {
  const resumeSnapshot = {
    resumeState: { threadId: "paused-thread", runId: "paused-run" },
    pendingInterrupts: [
      { id: "approval_1", reason: "tool-approval", toolCallId: "call_1" },
    ],
  };
  const outcomes = {
    "awaiting-user": {
      type: "awaiting-user",
      interaction: { type: "approval", toolCallId: "call_1" },
    },
    completed: { type: "completed" },
    cancelled: { type: "cancelled", reason: "user-stop" },
    failed: { type: "failed", error: "unknown" },
    interrupted: { type: "interrupted", reason: "owner-lost" },
  } as const satisfies Record<ChatTurnOutcome["type"], ChatTurnOutcome>;
  for (const turnOutcome of Object.values(outcomes)) {
    const settled = attachTerminalTurnOutcome({
      message: toPersistableChatMessage({
        id: toSafeId<"chatMessage">("019eb9fa-c91f-7000-9b9c-9365977dda80"),
        role: "assistant",
        parts: [{ type: "text", content: "Approval requested" }],
        metadata: { resumeSnapshot },
      }),
      turnOutcome,
    });
    const restored = chatMessageFromPersisted({
      id: settled.id,
      role: settled.role,
      content: chatMessageContentFromMessage(settled),
    });
    expect(restored.metadata?.resumeSnapshot).toEqual(
      turnOutcome.type === "awaiting-user" ? resumeSnapshot : undefined,
    );
    expect(restored.metadata?.turnOutcome).toEqual(turnOutcome);
  }
});

describe("chat attachment parts", () => {
  test("rejects malformed attachment parts with null source", () => {
    expect(isChatAttachmentPart({ type: "image", source: null })).toBe(false);
  });

  test("persists rich output without accepting or replaying it", () => {
    for (const part of richChatParts) {
      expect(isChatPart(part)).toBe(true);
      expect(isIncomingChatPart(part)).toBe(false);
      expect(isProviderVisibleChatPart(part)).toBe(false);
      expect(classifyChatPartForPersistence(part).type).toBe("persist");
    }
  });

  test("persists only canonical rich output fields", () => {
    assertProperty(
      "persists only canonical rich output fields",
      fc.property(
        fc.jsonValue(),
        fc.dictionary(fc.string(), fc.jsonValue()),
        (metadata, meta) => {
          for (const part of [richChatParts[0], richChatParts[1]]) {
            expect(
              classifyChatPartForPersistence({
                ...part,
                metadata,
                unexpected: meta,
              }),
            ).toEqual({ type: "persist", part });
          }

          const uiResource = richChatParts[2];
          expect(
            classifyChatPartForPersistence({
              ...uiResource,
              meta,
              unexpected: metadata,
              resource: { ...uiResource.resource, unexpected: meta },
            }),
          ).toEqual({
            type: "persist",
            part: { ...uiResource, meta },
          });
        },
      ),
      {},
    );
  });

  test("bounds every mixed rich-part sequence and reaches a fixed point", () => {
    assertProperty(
      "bounds every mixed rich-part sequence and reaches a fixed point",
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 100 }),
        (kinds) => {
          const parts = kinds.map(budgetPropertyPartFromKind);
          const first = applyChatPartPersistenceBudget(parts);
          const second = applyChatPartPersistenceBudget(first.parts);
          const inputText = parts.filter((part) => part.type === "text");
          const outputText = first.parts.filter((part) => part.type === "text");

          expect(outputText).toEqual(inputText);
          expect(first.richPartCount).toBeLessThanOrEqual(
            LIMITS.chatRichPartsPerMessageMax,
          );
          expect(first.richPartBytes).toBeLessThanOrEqual(
            LIMITS.chatRichPartsTotalMaxBytes,
          );
          expect(second.parts).toEqual(first.parts);
          expect(second.droppedPartTypes).toHaveLength(0);
        },
      ),
      {},
    );
  });

  test("drops rich resources after their cumulative byte budget", () => {
    const largeResource = {
      ...richChatParts[2],
      resource: {
        ...richChatParts[2].resource,
        text: "x".repeat(CHAT_RICH_PART_LIMITS.uiResourceContentMaxChars),
      },
    };
    const parts = Array.from({ length: 6 }, () => largeResource);

    const budgeted = applyChatPartPersistenceBudget(parts);

    expect(budgeted.richPartBytes).toBeLessThanOrEqual(
      LIMITS.chatRichPartsTotalMaxBytes,
    );
    expect(budgeted.parts.length).toBeLessThan(parts.length);
    expect(budgeted.droppedPartTypes.length).toBeGreaterThan(0);
  });

  test("restores exactly the persisted server-owned sequence", () => {
    assertProperty(
      "restores exactly the persisted server-owned sequence",
      fc.property(
        fc.array(fc.integer({ min: 0, max: 3 }), { maxLength: 20 }),
        fc.array(fc.integer({ min: 1, max: 3 }), { maxLength: 10 }),
        (persistedKinds, forgedKinds) => {
          const persistedParts = persistedKinds.map(budgetPropertyPartFromKind);
          const incomingParts: ChatPart[] = persistedParts.filter(
            (part) => !isServerOwnedChatPart(part),
          );
          incomingParts.push(...forgedKinds.map(budgetPropertyPartFromKind));

          expect(
            restoreServerOwnedChatParts({ incomingParts, persistedParts }),
          ).toEqual(persistedParts);
        },
      ),
      {},
    );
  });

  test("rejects unsafe rich output shapes", () => {
    expect(
      isChatPart({
        type: "audio",
        source: { type: "data", value: "Zm9v" },
      }),
    ).toBe(false);
    expect(
      isChatPart({
        type: "audio",
        source: { type: "data", value: "A=", mimeType: "audio/mpeg" },
      }),
    ).toBe(false);
    expect(
      isChatPart({
        type: "video",
        source: {
          type: "url",
          value: unsafeScriptUrl,
          mimeType: "video/mp4",
        },
      }),
    ).toBe(false);
    expect(
      isChatPart({
        type: "ui-resource",
        resource: {
          uri: "ui://widget",
          mimeType: "text/html",
          text: "<p>Widget</p>",
        },
        toolCallId: "call-1",
        toolName: "widget",
      }),
    ).toBe(false);
    expect(
      isChatPart({
        type: "ui-resource",
        resource: {
          uri: "ui://widget",
          mimeType: "text/html;profile=mcp-app",
          text: "",
        },
        toolCallId: "call-1",
        toolName: "widget",
      }),
    ).toBe(false);
    expect(
      isChatPart({
        ...richChatParts[2],
        meta: {
          oversized: "x".repeat(LIMITS.chatRichPartsTotalMaxBytes),
        },
      }),
    ).toBe(false);
  });

  test("fails loudly for malformed parts whose type must be persisted", () => {
    expect(() =>
      classifyChatPartForPersistence({ type: "tool-call", state: "new-state" }),
    ).toThrow("Cannot persist malformed chat part type: tool-call");
  });

  test("persists a tool call that ended in a recoverable execution error", () => {
    const part = {
      type: "tool-call" as const,
      id: "call-1",
      name: "load-skill",
      arguments: JSON.stringify({ skillName: "missing-skill" }),
      state: "error" as const,
    } satisfies ChatPart;

    expect(classifyChatPartForPersistence(part)).toEqual({
      type: "persist",
      part,
    });
  });
});

describe("merging a message's anonymization restorations", () => {
  test("holds each placeholder once, under its first original", () => {
    const merged = mergeAnonRestorations(
      { pairs: [{ placeholder: "[PERSON_1]", original: "Alice" }] },
      {
        pairs: [
          { placeholder: "[PERSON_1]", original: "Alice" },
          { placeholder: "[PERSON_1]", original: "Bob" },
          { placeholder: "[PERSON_2]", original: "Bob" },
        ],
      },
    );

    expect(merged.restorations.pairs).toEqual([
      { placeholder: "[PERSON_1]", original: "Alice" },
      { placeholder: "[PERSON_2]", original: "Bob" },
    ]);
    expect(merged.conflicts).toBe(1);
  });
});

const TOOL_RESULT_OUTCOME_CASES = {
  cancelled: "cancelled",
  denied: "denied",
} as const satisfies Record<ToolResultOutcome, ToolResultOutcome>;

test.each(Object.values(TOOL_RESULT_OUTCOME_CASES))(
  "preserves the %s tool outcome through persistence and reload",
  (outcome) => {
    const part = {
      content: "Tool did not run",
      error: "Tool did not run",
      outcome,
      state: "error",
      toolCallId: "tool-outcome",
      type: "tool-result",
    } as const satisfies ChatPart;
    const content = toPersistedChatMessageContentV3({ data: [part] });
    const restored = chatMessageFromPersisted({
      content,
      id: toSafeId<"chatMessage">("11111111-1111-4111-8111-111111111111"),
      role: "assistant",
    });
    expect(restored.parts).toEqual([part]);
  },
);

test("rejects unknown tool outcomes at the wire boundary", () => {
  expect(
    isChatPart({
      content: "Tool did not run",
      outcome: "unknown",
      state: "error",
      toolCallId: "tool-outcome",
      type: "tool-result",
    }),
  ).toBe(false);
});
