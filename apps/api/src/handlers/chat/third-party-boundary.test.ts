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

const anonymizeTextFieldsMock = mock(
  async ({ fields }: { fields: string[] }) => {
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
          next = next.replaceAll(original, placeholder);
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

  test("returns anonymized live tool output values", async () => {
    const boundary = createBoundary();
    const tools = {
      read_secret: toolDefinition({
        name: "read_secret",
        description: "Read a secret fixture.",
      }).server(async () => ({
        documentId: "doc_123",
        ids: ["person_456"],
        nationalId: "Secret-123",
        participants: ["Jan Novák", "Secret"],
        text: "Secret notes for Jan Novák",
      })),
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
            next = next.replaceAll(original, placeholder);
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
            next = next.replaceAll(original, placeholder);
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
      list_contacts: toolDefinition({
        name: "list_contacts",
        description: "List contacts fixture.",
        inputSchema: v.strictObject({ query: v.string() }),
      }).server(async (input) => {
        seenInputs.push(input);
        return { items: [{ name: input.query, id: "c1" }] };
      }),
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
      run_query: toolDefinition({
        name: "run_query",
        description: "Run query fixture.",
        inputSchema: v.strictObject({ code: v.string() }),
      }).server(async (input) => {
        seenInputs.push(input);
        return { value: { items: [] } };
      }),
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
