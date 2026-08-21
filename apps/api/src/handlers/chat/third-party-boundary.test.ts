import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import { TEXT_PLAIN_MIME_TYPE } from "@/api/handlers/chat/attachment-validation";
import {
  createChatAttachmentPart,
  getChatAttachmentUrl,
  isChatAttachmentPart,
} from "@/api/handlers/chat/chat-message-parts";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { toDataUrl } from "@/api/lib/data-url";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import {
  asTestExecutable,
  asTestToolSet,
} from "@/api/tests/helpers/test-tool-set";
import { createScopedDbMock } from "@/api/tests/scoped-db-mock";

import { richChatParts } from "./__fixtures__/rich-chat-parts";

const anonymizeTextFieldsMock = mock(
  async ({
    fields,
  }: {
    fields: string[];
    forcedSensitiveValues?: readonly string[] | undefined;
    workspaceId: string;
  }) => {
    const swaps: [string, string][] = [
      ["[PERSON_1]", "Jan Novák"],
      ["[CUSTOM_1]", "Secret"],
    ];
    const seen = new Set<string>();
    const redactionMap = new Map<string, string>();
    const anonymized = fields.map((field) => {
      let next = field;
      for (const [placeholder, original] of swaps) {
        if (next.includes(original)) {
          next = next.replaceAll(original, () => placeholder);
          if (!seen.has(placeholder)) {
            redactionMap.set(placeholder, original);
            seen.add(placeholder);
          }
        }
      }
      return next;
    });
    return {
      entityCount: fields.length,
      fields: anonymized,
      redactionMap,
    };
  },
);

const {
  createChatThirdPartyBoundary,
  prepareMcpToolSourceForThirdParty,
  prepareMessagesForThirdParty,
  prepareTextForThirdParty,
  prepareToolsForThirdParty,
  prepareUnknownForThirdParty,
  reserveThirdPartyBoundarySourcePlaceholders,
} = await import("@/api/handlers/chat/third-party-boundary");

const createBoundary = () => {
  const { scopedDb } = createScopedDbMock({});

  return createChatThirdPartyBoundary({
    anonymizeFields: anonymizeTextFieldsMock,
    anonymizationScopeId: "workspace-A",
    organizationId: toSafeId<"organization">(
      "11111111-1111-4111-8111-111111111111",
    ),
    scopedDb,
    sendMode: CHAT_SEND_MODE.anonymized,
  });
};

const createRawBoundary = () => {
  const { scopedDb } = createScopedDbMock({});

  return createChatThirdPartyBoundary({
    anonymizeFields: anonymizeTextFieldsMock,
    anonymizationScopeId: "workspace-A",
    organizationId: toSafeId<"organization">(
      "11111111-1111-4111-8111-111111111111",
    ),
    scopedDb,
    sendMode: CHAT_SEND_MODE.rawOverride,
  });
};

describe("chat third-party anonymization boundary", () => {
  beforeEach(() => {
    anonymizeTextFieldsMock.mockClear();
  });

  test("forwards a UUID-shaped anonymizationScopeId verbatim into the anonymize call", async () => {
    const scopeId = "22222222-2222-4222-8222-222222222222";
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeTextFieldsMock,
      anonymizationScopeId: scopeId,
      organizationId: toSafeId<"organization">(
        "11111111-1111-4111-8111-111111111111",
      ),
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
    });

    const prepared = await prepareTextForThirdParty({
      boundary,
      text: "Some text to anonymize.",
    });

    expect(Result.isOk(prepared)).toBe(true);
    // Exact equality: a scope-id plumbing regression (truncation,
    // re-wrapping, falling back to a different id) must fail here, not
    // just "receives some string".
    expect(anonymizeTextFieldsMock.mock.calls.at(0)?.[0].workspaceId).toBe(
      scopeId,
    );
    expect(
      anonymizeTextFieldsMock.mock.calls.at(0)?.[0].forcedSensitiveValues,
    ).toEqual(["11111111-1111-4111-8111-111111111111", scopeId]);
  });

  test("forces boundary IDs through structured technical keys", async () => {
    const organizationId = toSafeId<"organization">(
      "11111111-1111-4111-8111-111111111111",
    );
    const scopeId = "22222222-2222-4222-8222-222222222222";
    const anonymizeIds = mock(async ({ fields }: { fields: string[] }) => {
      const redactionMap = new Map<string, string>();
      const anonymized = fields.map((field, index) => {
        const placeholder = `[MISC_${String(index + 1)}]`;
        redactionMap.set(placeholder, field);
        return placeholder;
      });
      return {
        entityCount: fields.length,
        fields: anonymized,
        redactionMap,
      };
    });
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeIds,
      anonymizationScopeId: scopeId,
      organizationId,
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
    });

    const prepared = await prepareUnknownForThirdParty({
      boundary,
      value: {
        organizationId,
        id: `ref_${organizationId}`,
        scopeId: `scope:${scopeId}`,
        documentId: "doc_123",
      },
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    expect(prepared.value).toEqual({
      organizationId: "[MISC_1]",
      id: "[MISC_2]",
      scopeId: "[MISC_3]",
      documentId: "doc_123",
    });
    expect(anonymizeIds.mock.calls.at(0)?.[0].fields).toEqual([
      organizationId,
      `ref_${organizationId}`,
      `scope:${scopeId}`,
    ]);
  });

  test("omits UI-only rich output before every provider boundary", async () => {
    const preparedBoundaries = await Promise.all(
      [createRawBoundary(), createBoundary()].map(
        async (boundary) =>
          await prepareMessagesForThirdParty({
            boundary,
            messages: [
              {
                id: "msg_1",
                role: "assistant",
                parts: [
                  { type: "text", content: "Provider context" },
                  ...richChatParts,
                ],
              },
            ],
          }),
      ),
    );

    for (const prepared of preparedBoundaries) {
      expect(Result.isOk(prepared)).toBe(true);
      if (Result.isError(prepared)) {
        throw prepared.error;
      }
      expect(prepared.value.at(0)?.parts).toEqual([
        { type: "text", content: "Provider context" },
      ]);
    }
  });

  test("anonymizes system text and message text before provider use", async () => {
    const boundary = createBoundary();
    const system = await prepareTextForThirdParty({
      boundary,
      text: "System context mentions Jan Novák and Secret.",
    });

    expect(Result.isOk(system)).toBe(true);
    if (Result.isError(system)) {
      throw system.error;
    }

    expect(system.value).toBe(
      "System context mentions [PERSON_1] and [CUSTOM_1].",
    );

    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [
          {
            type: "text",
            content: "Does Jan Novák appear in Secret contract?",
          },
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }

    expect(prepared.value.at(0)?.parts.at(0)).toEqual({
      type: "text",
      content: "Does [PERSON_1] appear in [CUSTOM_1] contract?",
    });
  });

  test("refuses attachments that cannot be safely anonymized as text", async () => {
    const boundary = createBoundary();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [
          createChatAttachmentPart({
            filename: "Jan Novák draft.docx",
            mimeType: DOCX_MIME_TYPE,
            url: toDataUrl(new Uint8Array([1, 2, 3]), DOCX_MIME_TYPE),
          }),
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isError(prepared)).toBe(true);
    if (Result.isOk(prepared)) {
      throw new TypeError("Expected attachment refusal");
    }

    expect(prepared.error.status).toBe(422);
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
  });

  test("rewrites plain-text attachment data URLs with anonymized content", async () => {
    const boundary = createBoundary();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [
          createChatAttachmentPart({
            filename: "Jan Novák notes.txt",
            mimeType: TEXT_PLAIN_MIME_TYPE,
            url: toDataUrl(
              Buffer.from("Secret notes for Jan Novák", "utf-8"),
              TEXT_PLAIN_MIME_TYPE,
            ),
          }),
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }

    const part = prepared.value.at(0)?.parts.at(0);

    expect(part).toMatchObject({
      type: "document",
      metadata: { filename: "[PERSON_1] notes.txt" },
      source: { mimeType: TEXT_PLAIN_MIME_TYPE },
    });
    if (!part || !isChatAttachmentPart(part)) {
      throw new TypeError("Expected prepared attachment part");
    }
    expect(getChatAttachmentUrl(part)).toContain(
      Buffer.from("[CUSTOM_1] notes for [PERSON_1]", "utf-8").toString(
        "base64",
      ),
    );
  });

  test("removes restoration metadata before provider preparation", async () => {
    const boundary = createBoundary();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "assistant",
        metadata: {
          anonRestorations: {
            pairs: [{ placeholder: "[PERSON_1]", original: "Jan Novák" }],
          },
        },
        parts: [{ type: "text", content: "Visible answer." }],
      },
      {
        id: "msg_2",
        role: "assistant",
        metadata: {
          anonRestorations: {
            pairs: [{ placeholder: "[CUSTOM_1]", original: "Secret" }],
          },
        },
        parts: [],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }

    expect(prepared.value).toEqual([
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ type: "text", content: "Visible answer." }],
      },
    ]);
    expect(boundary.type).toBe("anonymized");
    if (boundary.type === "anonymized") {
      expect(boundary.redactionMap.size).toBe(0);
    }
    expect(anonymizeTextFieldsMock).toHaveBeenCalledTimes(1);
    expect(anonymizeTextFieldsMock.mock.calls.at(0)?.[0].fields).toEqual([
      "Visible answer.",
    ]);
  });

  test("handles tool parts without approval", async () => {
    const boundary = createBoundary();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "call_1",
            name: "mcp__test__read_secret",
            arguments: JSON.stringify({ query: "Jan Novák" }),
            state: "complete",
            input: { query: "Jan Novák" },
            output: { text: "Secret notes" },
          },
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }

    expect(prepared.value.at(0)?.parts.at(0)).toMatchObject({
      input: { query: "[PERSON_1]" },
      output: { text: "[CUSTOM_1] notes" },
    });
  });

  test("anonymizes JSON tool-result content before provider replay", async () => {
    const boundary = createBoundary();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "call_1",
            name: "mcp__test__read_secret",
            arguments: JSON.stringify({ question: "Who signed?" }),
            state: "complete",
            output: {
              documentId: "doc_123",
              text: "Secret notes for Jan Novák",
            },
          },
          {
            type: "tool-result",
            toolCallId: "call_1",
            content: JSON.stringify({
              documentId: "doc_123",
              text: "Secret notes for Jan Novák",
            }),
            state: "complete",
          },
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }

    const resultPart = prepared.value.at(0)?.parts.at(1);
    expect(resultPart).toMatchObject({
      type: "tool-result",
      toolCallId: "call_1",
      state: "complete",
    });
    if (!resultPart || resultPart.type !== "tool-result") {
      throw new TypeError("Expected prepared tool-result part");
    }
    if (typeof resultPart.content !== "string") {
      throw new TypeError("Expected JSON tool-result content");
    }

    expect(JSON.parse(resultPart.content)).toEqual({
      documentId: "doc_123",
      text: "[CUSTOM_1] notes for [PERSON_1]",
    });
  });

  test("anonymizes text tool-result content parts before provider replay", async () => {
    const boundary = createBoundary();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "call_1",
            name: "mcp__test__read_secret",
            arguments: JSON.stringify({ question: "Who signed?" }),
            state: "complete",
            output: "Secret notes for Jan Novák",
          },
          {
            type: "tool-result",
            toolCallId: "call_1",
            content: [{ type: "text", content: "Secret notes for Jan Novák" }],
            state: "complete",
          },
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }

    expect(prepared.value.at(0)?.parts.at(1)).toMatchObject({
      type: "tool-result",
      content: [{ type: "text", content: "[CUSTOM_1] notes for [PERSON_1]" }],
      state: "complete",
      toolCallId: "call_1",
    });
  });

  test("anonymizes every rich tool-result source before provider replay", async () => {
    const organizationId = toSafeId<"organization">(
      "11111111-1111-4111-8111-111111111111",
    );
    const anonymizeIds = mock(async ({ fields }: { fields: string[] }) => ({
      entityCount: 1,
      fields: fields.map((field) =>
        field.replaceAll(organizationId, () => "[MISC_1]"),
      ),
      redactionMap: new Map([["[MISC_1]", organizationId]]),
    }));
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeIds,
      anonymizationScopeId: "workspace-A",
      organizationId,
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
    });
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          {
            type: "tool-call",
            id: "call_1",
            name: "mcp__test__read_rich_result",
            arguments: "{}",
            state: "complete",
          },
          {
            type: "tool-result",
            toolCallId: "call_1",
            content: [
              {
                type: "image",
                source: {
                  type: "url",
                  value: `https://example.test/${organizationId}/image.png`,
                  mimeType: "image/png",
                },
                metadata: { traceId: `ref_${organizationId}` },
              },
              {
                type: "audio",
                source: {
                  type: "url",
                  value: `https://example.test/${organizationId}/audio.mp3`,
                  mimeType: "audio/mpeg",
                },
              },
              {
                type: "video",
                source: {
                  type: "url",
                  value: `https://example.test/${organizationId}/video.mp4`,
                  mimeType: "video/mp4",
                },
              },
              {
                type: "document",
                source: {
                  type: "url",
                  value: `https://example.test/${organizationId}/document.pdf`,
                  mimeType: "application/pdf",
                },
              },
            ],
            state: "complete",
          },
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    const resultPart = prepared.value.at(0)?.parts.at(1);
    if (!resultPart || resultPart.type !== "tool-result") {
      throw new TypeError("Expected prepared tool-result part");
    }
    expect(resultPart.content).toEqual([
      {
        type: "image",
        source: {
          type: "url",
          value: "https://example.test/[MISC_1]/image.png",
          mimeType: "image/png",
        },
        metadata: { traceId: "[MISC_1]" },
      },
      {
        type: "audio",
        source: {
          type: "url",
          value: "https://example.test/[MISC_1]/audio.mp3",
          mimeType: "audio/mpeg",
        },
      },
      {
        type: "video",
        source: {
          type: "url",
          value: "https://example.test/[MISC_1]/video.mp4",
          mimeType: "video/mp4",
        },
      },
      {
        type: "document",
        source: {
          type: "url",
          value: "https://example.test/[MISC_1]/document.pdf",
          mimeType: "application/pdf",
        },
      },
    ]);
    expect(anonymizeIds.mock.calls.at(0)?.[0].fields).toEqual([
      `https://example.test/${organizationId}/image.png`,
      `https://example.test/${organizationId}/audio.mp3`,
      `https://example.test/${organizationId}/video.mp4`,
      `https://example.test/${organizationId}/document.pdf`,
      `ref_${organizationId}`,
    ]);
  });

  test("returns anonymized live tool output values", async () => {
    const boundary = createBoundary();
    const tools = {
      read_secret: applyChatToolPolicy(
        toolDefinition({
          name: "read_secret",
          description: "Read a secret fixture.",
        }).server(async () => ({
          documentId: "doc_123",
          ids: ["person_456"],
          nationalId: "Secret-123",
          participants: ["Jan Novák", "Secret"],
          text: "Secret notes for Jan Novák",
        })),
        CHAT_TOOL_POLICY_KIND.internal,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      tools: asTestToolSet(tools),
    });
    const executable = asTestExecutable<unknown, unknown>(
      prepared["read_secret"],
    );

    expect(await executable?.execute?.(undefined)).toEqual({
      documentId: "doc_123",
      ids: ["person_456"],
      nationalId: "[CUSTOM_1]-123",
      participants: ["[PERSON_1]", "[CUSTOM_1]"],
      text: "[CUSTOM_1] notes for [PERSON_1]",
    });
  });

  test("returns anonymized external MCP source tool output values", async () => {
    const boundary = createBoundary();
    const sourceTool = toolDefinition({
      name: "mcp__test__read_secret",
      description: "Read a secret fixture.",
    }).server(async () => ({
      documentId: "doc_123",
      participants: ["Jan Novák", "Secret"],
      text: "Secret notes for Jan Novák",
    }));
    const source = prepareMcpToolSourceForThirdParty({
      boundary,
      source: {
        close: async () => {},
        tools: async () => [sourceTool],
      },
    });
    const [preparedTool] = await source.tools();
    const executable = asTestExecutable<unknown, unknown>(preparedTool);

    expect(await executable?.execute?.(undefined)).toEqual({
      documentId: "doc_123",
      participants: ["[PERSON_1]", "[CUSTOM_1]"],
      text: "[CUSTOM_1] notes for [PERSON_1]",
    });
  });

  test("aliases late literal placeholders in runtime tool output", async () => {
    const { deanonymizeFromBoundary, deanonymizeUnknownStringsFromBoundary } =
      await import("@/api/handlers/chat/third-party-boundary");
    const boundary = createBoundary();
    await prepareTextForThirdParty({
      boundary,
      text: "Jan Novák prepared the memo.",
    });
    const tools = {
      literal_output: applyChatToolPolicy(
        toolDefinition({
          name: "literal_output",
          description: "Return a literal placeholder fixture.",
        }).server(async () => ({ text: "Keep [PERSON_1] literal" })),
        CHAT_TOOL_POLICY_KIND.internal,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      tools: asTestToolSet(tools),
    });
    const executable = asTestExecutable<unknown, unknown>(
      prepared["literal_output"],
    );
    const output = await executable?.execute?.(undefined);

    expect(output).toEqual({
      text: "Keep [LITERAL_PLACEHOLDER_1] literal",
    });
    expect(deanonymizeUnknownStringsFromBoundary(boundary, output)).toEqual({
      text: "Keep [PERSON_1] literal",
    });
    expect(
      deanonymizeFromBoundary({
        boundary,
        text: "[PERSON_1]; Keep [LITERAL_PLACEHOLDER_1] literal",
      }),
    ).toBe("Jan Novák; Keep [PERSON_1] literal");
  });

  test("chooses late aliases absent from the complete runtime output", async () => {
    const { deanonymizeUnknownStringsFromBoundary } =
      await import("@/api/handlers/chat/third-party-boundary");
    const boundary = createBoundary();
    await prepareTextForThirdParty({
      boundary,
      text: "Jan Novák prepared the memo.",
    });
    const outputs = [
      "[PERSON_1] [LITERAL_PLACEHOLDER_1]",
      "[PERSON_1] [LITERAL_PLACEHOLDER_2]",
    ];
    const tools = {
      literal_output: applyChatToolPolicy(
        toolDefinition({
          name: "literal_output",
          description: "Return colliding literal placeholder fixtures.",
        }).server(async () => ({ text: outputs.shift() })),
        CHAT_TOOL_POLICY_KIND.internal,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      tools: asTestToolSet(tools),
    });
    const executable = asTestExecutable<unknown, unknown>(
      prepared["literal_output"],
    );

    const first = await executable?.execute?.(undefined);
    const second = await executable?.execute?.(undefined);

    expect(first).toEqual({
      text: "[LITERAL_PLACEHOLDER_2] [LITERAL_PLACEHOLDER_1]",
    });
    expect(second).toEqual({
      text: "[LITERAL_PLACEHOLDER_3] [LITERAL_PLACEHOLDER_4]",
    });
    expect(deanonymizeUnknownStringsFromBoundary(boundary, first)).toEqual({
      text: "[PERSON_1] [LITERAL_PLACEHOLDER_1]",
    });
    expect(deanonymizeUnknownStringsFromBoundary(boundary, second)).toEqual({
      text: "[PERSON_1] [LITERAL_PLACEHOLDER_2]",
    });
  });

  test("reserves aliases across a structured runtime output", async () => {
    const { deanonymizeUnknownStringsFromBoundary } =
      await import("@/api/handlers/chat/third-party-boundary");
    const boundary = createBoundary();
    await prepareTextForThirdParty({
      boundary,
      text: "Jan Novák prepared the memo.",
    });
    const tools = {
      literal_output: applyChatToolPolicy(
        toolDefinition({
          name: "literal_output",
          description: "Return a structured placeholder collision fixture.",
        }).server(async () => ({
          literal: "[LITERAL_PLACEHOLDER_1]",
          claimed: "[PERSON_1]",
        })),
        CHAT_TOOL_POLICY_KIND.internal,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      tools: asTestToolSet(tools),
    });
    const executable = asTestExecutable<unknown, unknown>(
      prepared["literal_output"],
    );

    const output = await executable?.execute?.(undefined);

    expect(output).toEqual({
      literal: "[LITERAL_PLACEHOLDER_1]",
      claimed: "[LITERAL_PLACEHOLDER_2]",
    });
    expect(deanonymizeUnknownStringsFromBoundary(boundary, output)).toEqual({
      literal: "[LITERAL_PLACEHOLDER_1]",
      claimed: "[PERSON_1]",
    });
  });

  test("allows approved external tools to inherit raw mode", async () => {
    const boundary = createRawBoundary();
    const tools = {
      external_lookup: applyChatToolPolicy(
        toolDefinition({
          name: "external_lookup",
          description: "External lookup fixture.",
          inputSchema: v.strictObject({}),
        }).server(async () => ({ text: "Secret notes for Jan Novák" })),
        CHAT_TOOL_POLICY_KIND.external,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      tools: asTestToolSet(tools),
    });
    const executable = asTestExecutable<unknown, unknown>(
      prepared["external_lookup"],
    );

    if (!executable?.execute) {
      throw new TypeError("Expected external tool execute function");
    }

    const output = await executable.execute(undefined);
    expect(output).toEqual({
      text: "Secret notes for Jan Novák",
    });
  });

  test("allows official public lookup tools without anonymized mode", async () => {
    const boundary = createRawBoundary();
    const tools = {
      official_lookup: applyChatToolPolicy(
        toolDefinition({
          name: "official_lookup",
          description: "Official lookup fixture.",
          inputSchema: v.strictObject({ ico: v.string() }),
        }).server(async ({ ico }) => ({ ico, name: "Alza.cz a.s." })),
        CHAT_TOOL_POLICY_KIND.publicOfficial,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      tools: asTestToolSet(tools),
    });
    const executable = asTestExecutable<{ ico: string }, unknown>(
      prepared["official_lookup"],
    );

    expect(await executable?.execute?.({ ico: "27082440" })).toEqual({
      ico: "27082440",
      name: "Alza.cz a.s.",
    });
  });

  test("allows unofficial public lookup tools to inherit raw mode", async () => {
    const boundary = createRawBoundary();
    const tools = {
      unofficial_lookup: applyChatToolPolicy(
        toolDefinition({
          name: "unofficial_lookup",
          description: "Unofficial lookup fixture.",
          inputSchema: v.strictObject({ query: v.string() }),
        }).server(async ({ query }) => ({ query })),
        CHAT_TOOL_POLICY_KIND.publicUnofficial,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      tools: asTestToolSet(tools),
    });
    const executable = asTestExecutable<{ query: string }, unknown>(
      prepared["unofficial_lookup"],
    );

    if (!executable?.execute) {
      throw new TypeError("Expected unofficial lookup execute function");
    }

    const output = await executable.execute({ query: "Jan Novák" });
    expect(output).toEqual({
      query: "Jan Novák",
    });
  });

  test("round-trips placeholders so outgoing text is restored to originals", async () => {
    const { deanonymizeFromBoundary, deanonymizeUnknownStringsFromBoundary } =
      await import("@/api/handlers/chat/third-party-boundary");
    const boundary = createBoundary();

    // Anonymize on the inbound path so the boundary accumulates a map.
    const inbound = await prepareTextForThirdParty({
      boundary,
      text: "Jan Novák signed the Secret addendum.",
    });
    expect(Result.isOk(inbound)).toBe(true);

    if (boundary.type !== "anonymized") {
      throw new TypeError("Expected anonymized boundary");
    }
    expect(boundary.redactionMap.get("[PERSON_1]")).toBe("Jan Novák");
    expect(boundary.redactionMap.get("[CUSTOM_1]")).toBe("Secret");

    expect(
      deanonymizeFromBoundary({
        boundary,
        text: "[PERSON_1] confirms [CUSTOM_1].",
      }),
    ).toBe("Jan Novák confirms Secret.");

    expect(
      deanonymizeUnknownStringsFromBoundary(boundary, {
        signed: ["[PERSON_1]", "[UNKNOWN_99]"],
        nested: { note: "Audit on [CUSTOM_1] still pending." },
      }),
    ).toEqual({
      signed: ["Jan Novák", "[UNKNOWN_99]"],
      nested: { note: "Audit on Secret still pending." },
    });
  });

  test("renumbers sequential anonymization batches before merging", async () => {
    const anonymizePeople = mock(async ({ fields }: { fields: string[] }) => {
      const redactionMap = new Map<string, string>();
      const anonymized = fields.map((field) => {
        let next = field;
        let nextIndex = 1;
        for (const original of ["Alice", "Bob"]) {
          if (next.includes(original)) {
            const placeholder = `[PERSON_${nextIndex}]`;
            next = next.replaceAll(original, () => placeholder);
            redactionMap.set(placeholder, original);
            nextIndex += 1;
          }
        }
        return next;
      });
      return {
        entityCount: redactionMap.size,
        fields: anonymized,
        redactionMap,
      };
    });
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizePeople,
      anonymizationScopeId: "workspace-A",
      organizationId: toSafeId<"organization">(
        "11111111-1111-4111-8111-111111111111",
      ),
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
    });

    const first = await prepareTextForThirdParty({
      boundary,
      text: "Alice prepared the memo.",
    });
    const second = await prepareTextForThirdParty({
      boundary,
      text: "Alice briefed Bob.",
    });

    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isError(first) || Result.isError(second)) {
      throw new TypeError("Expected anonymization to succeed");
    }
    expect(first.value).toBe("[PERSON_1] prepared the memo.");
    expect(second.value).toBe("[PERSON_1] briefed [PERSON_2].");
    if (boundary.type !== "anonymized") {
      throw new TypeError("Expected anonymized boundary");
    }
    expect(boundary.redactionMap).toEqual(
      new Map([
        ["[PERSON_1]", "Alice"],
        ["[PERSON_2]", "Bob"],
      ]),
    );
  });

  test("preserves echoed placeholders while renumbering new redactions", async () => {
    const anonymizePeople = mock(async ({ fields }: { fields: string[] }) => {
      const redactionMap = new Map<string, string>();
      const anonymized = fields.map((field) => {
        let next = field;
        let nextIndex = 1;
        for (const original of ["Bob", "Alice"]) {
          if (next.includes(original)) {
            const placeholder = `[PERSON_${nextIndex}]`;
            next = next.replaceAll(original, () => placeholder);
            redactionMap.set(placeholder, original);
            nextIndex += 1;
          }
        }
        return next;
      });
      return {
        entityCount: redactionMap.size,
        fields: anonymized,
        redactionMap,
      };
    });
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizePeople,
      anonymizationScopeId: "workspace-A",
      organizationId: toSafeId<"organization">(
        "11111111-1111-4111-8111-111111111111",
      ),
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
    });

    const first = await prepareTextForThirdParty({
      boundary,
      text: "Bob prepared the memo.",
    });
    const second = await prepareTextForThirdParty({
      boundary,
      text: "Results for [PERSON_1]: Alice",
    });

    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isError(first) || Result.isError(second)) {
      throw new TypeError("Expected anonymization to succeed");
    }
    expect(first.value).toBe("[PERSON_1] prepared the memo.");
    expect(second.value).toBe("Results for [PERSON_1]: [PERSON_2]");
    if (boundary.type !== "anonymized") {
      throw new TypeError("Expected anonymized boundary");
    }
    expect(boundary.redactionMap).toEqual(
      new Map([
        ["[PERSON_1]", "Bob"],
        ["[PERSON_2]", "Alice"],
      ]),
    );
  });

  test("reserves later source placeholders before an earlier allocation", async () => {
    const { deanonymizeFromBoundary } =
      await import("@/api/handlers/chat/third-party-boundary");
    const boundary = createBoundary();
    reserveThirdPartyBoundarySourcePlaceholders({
      boundary,
      value: ["Jan Novák", "Keep [PERSON_1] literal"],
    });

    const first = await prepareTextForThirdParty({
      boundary,
      text: "Jan Novák prepared the memo.",
    });
    const second = await prepareTextForThirdParty({
      boundary,
      text: "Keep [PERSON_1] literal",
    });

    expect(Result.isOk(first)).toBe(true);
    expect(Result.isOk(second)).toBe(true);
    if (Result.isError(first) || Result.isError(second)) {
      throw new TypeError("Expected anonymization to succeed");
    }
    expect(first.value).toBe("[PERSON_2] prepared the memo.");
    expect(second.value).toBe("Keep [PERSON_1] literal");
    if (boundary.type !== "anonymized") {
      throw new TypeError("Expected anonymized boundary");
    }
    expect(boundary.redactionMap).toEqual(
      new Map([["[PERSON_2]", "Jan Novák"]]),
    );
    expect(
      deanonymizeFromBoundary({
        boundary,
        text: `${first.value} Keep [PERSON_1] literal`,
      }),
    ).toBe("Jan Novák prepared the memo. Keep [PERSON_1] literal");
  });

  test("keeps literal source placeholders distinct from new redactions", async () => {
    const anonymizeSecret = mock(async ({ fields }: { fields: string[] }) => ({
      entityCount: 1,
      fields: fields.map((field) =>
        field.replaceAll("Secret", () => "[MISC_2]"),
      ),
      redactionMap: new Map([["[MISC_2]", "Secret"]]),
    }));
    const { deanonymizeFromBoundary } =
      await import("@/api/handlers/chat/third-party-boundary");
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeSecret,
      anonymizationScopeId: "workspace-A",
      organizationId: toSafeId<"organization">(
        "11111111-1111-4111-8111-111111111111",
      ),
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
    });

    const prepared = await prepareTextForThirdParty({
      boundary,
      text: "Keep [MISC_1] literal; redact Secret.",
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    expect(prepared.value).toBe("Keep [MISC_1] literal; redact [MISC_2].");
    expect(deanonymizeFromBoundary({ boundary, text: prepared.value })).toBe(
      "Keep [MISC_1] literal; redact Secret.",
    );
  });

  test("does not let extreme literal indices collapse new placeholders", async () => {
    const anonymizeSecrets = mock(async ({ fields }: { fields: string[] }) => ({
      entityCount: 2,
      fields: fields.map((field) =>
        field
          .replaceAll("First", () => "[MISC_1]")
          .replaceAll("Second", () => "[MISC_2]"),
      ),
      redactionMap: new Map([
        ["[MISC_1]", "First"],
        ["[MISC_2]", "Second"],
      ]),
    }));
    const { deanonymizeFromBoundary } =
      await import("@/api/handlers/chat/third-party-boundary");
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeSecrets,
      anonymizationScopeId: "workspace-A",
      organizationId: toSafeId<"organization">(
        "11111111-1111-4111-8111-111111111111",
      ),
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
    });
    const literal = "[MISC_9007199254740991]";

    const prepared = await prepareTextForThirdParty({
      boundary,
      text: `${literal} First Second`,
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    expect(prepared.value).toBe(`${literal} [MISC_1] [MISC_2]`);
    expect(deanonymizeFromBoundary({ boundary, text: prepared.value })).toBe(
      `${literal} First Second`,
    );
  });

  test("round-trip helpers are no-ops on raw boundaries", async () => {
    const { deanonymizeFromBoundary } =
      await import("@/api/handlers/chat/third-party-boundary");
    const boundary = createRawBoundary();
    expect(
      deanonymizeFromBoundary({ boundary, text: "[PERSON_1] is here" }),
    ).toBe("[PERSON_1] is here");
  });

  test("deanonymizes input for internal tools so DB lookups hit real values", async () => {
    const boundary = createBoundary();
    // Seed the boundary's redaction map by anonymizing a message
    // first — the model would have seen `[PERSON_1]` and now passes
    // it back as a tool argument.
    await prepareTextForThirdParty({
      boundary,
      text: "Find Jan Novák in contacts.",
    });

    const seenInputs: unknown[] = [];
    const tools = {
      list_contacts: applyChatToolPolicy(
        toolDefinition({
          name: "list_contacts",
          description: "List contacts fixture.",
          inputSchema: v.strictObject({ query: v.string() }),
        }).server(async (input) => {
          seenInputs.push(input);
          return { items: [{ name: input.query, id: "c1" }] };
        }),
        CHAT_TOOL_POLICY_KIND.internal,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      tools: asTestToolSet(tools),
    });
    const executable = asTestExecutable<{ query: string }, unknown>(
      prepared["list_contacts"],
    );

    const output = await executable?.execute?.({ query: "[PERSON_1]" });

    // The internal tool ran with the deanonymized real value…
    expect(seenInputs).toEqual([{ query: "Jan Novák" }]);
    // …and its output came back to the model anonymized again.
    expect(output).toEqual({ items: [{ name: "[PERSON_1]", id: "c1" }] });
  });

  test("deanonymizes bare placeholder inner forms in tool input", async () => {
    // Reproduces the bug where the model emits
    // `listContacts({query: "PERSON_1"})` (no brackets) inside a
    // JSON tool call — strict bracket matching would let it through
    // unchanged and the DB lookup would search for the literal
    // string "PERSON_1".
    const boundary = createBoundary();
    await prepareTextForThirdParty({
      boundary,
      text: "Find Jan Novák in contacts.",
    });

    const seenInputs: unknown[] = [];
    const tools = {
      run_query: applyChatToolPolicy(
        toolDefinition({
          name: "run_query",
          description: "Run query fixture.",
          inputSchema: v.strictObject({ code: v.string() }),
        }).server(async (input) => {
          seenInputs.push(input);
          return { value: { items: [] } };
        }),
        CHAT_TOOL_POLICY_KIND.internal,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      tools: asTestToolSet(tools),
    });
    const executable = asTestExecutable<{ code: string }, unknown>(
      prepared["run_query"],
    );

    await executable?.execute?.({
      code: 'return await read.listContacts({query: "PERSON_1"});',
    });

    expect(seenInputs).toEqual([
      {
        code: 'return await read.listContacts({query: "Jan Novák"});',
      },
    ]);
  });

  test("does not deanonymize input for external tools", async () => {
    const boundary = createBoundary();
    await prepareTextForThirdParty({
      boundary,
      text: "Search for Jan Novák.",
    });

    const seenInputs: unknown[] = [];
    const externalTool = applyChatToolPolicy(
      toolDefinition({
        name: "external_search",
        description: "External search fixture.",
        inputSchema: v.strictObject({ query: v.string() }),
      }).server(async (input) => {
        seenInputs.push(input);
        return { hits: [] };
      }),
      CHAT_TOOL_POLICY_KIND.external,
    );
    const prepared = prepareToolsForThirdParty({
      boundary,
      tools: asTestToolSet({ external_search: externalTool }),
    });
    const executable = asTestExecutable<{ query: string }, unknown>(
      prepared["external_search"],
    );

    await executable?.execute?.({ query: "[PERSON_1]" });

    // External tool got the raw placeholder — real names never
    // leave Stella for third parties.
    expect(seenInputs).toEqual([{ query: "[PERSON_1]" }]);
  });
});
