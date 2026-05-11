import { valibotSchema } from "@ai-sdk/valibot";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";

import { TEXT_PLAIN_MIME_TYPE } from "@/api/handlers/chat/attachment-validation";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { toDataUrl } from "@/api/lib/data-url";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
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
            text: "Does Jan Novák appear in Secret contract?",
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

    expect(prepared.value?.at(0)?.parts.at(0)).toEqual({
      type: "text",
      text: "Does [PERSON_1] appear in [CUSTOM_1] contract?",
    });
  });

  test("refuses attachments that cannot be safely anonymized as text", async () => {
    const boundary = createBoundary();
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "user",
        parts: [
          {
            type: "file",
            filename: "Jan Novák draft.docx",
            mediaType: DOCX_MIME_TYPE,
            url: toDataUrl(new Uint8Array([1, 2, 3]), DOCX_MIME_TYPE),
          },
        ],
      },
    ];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages,
    });

    expect(Result.isError(prepared)).toBe(true);
    if (Result.isOk(prepared)) {
      throw new Error("Expected attachment refusal");
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
          {
            type: "file",
            filename: "Jan Novák notes.txt",
            mediaType: TEXT_PLAIN_MIME_TYPE,
            url: toDataUrl(
              Buffer.from("Secret notes for Jan Novák", "utf-8"),
              TEXT_PLAIN_MIME_TYPE,
            ),
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

    const part = prepared.value?.at(0)?.parts.at(0);

    expect(part).toMatchObject({
      type: "file",
      filename: "[PERSON_1] notes.txt",
      mediaType: TEXT_PLAIN_MIME_TYPE,
    });
    expect(part?.type === "file" ? part.url : "").toContain(
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
        parts: [
          {
            type: "data-stella-anon-restorations",
            data: {
              pairs: [{ placeholder: "[PERSON_1]", original: "Jan Novák" }],
            },
          },
          {
            type: "text",
            text: "Visible answer.",
          },
        ],
      },
      {
        id: "msg_2",
        role: "assistant",
        parts: [
          {
            type: "data-stella-anon-restorations",
            data: {
              pairs: [{ placeholder: "[CUSTOM_1]", original: "Secret" }],
            },
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

    expect(prepared.value).toEqual([
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ type: "text", text: "Visible answer." }],
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

  test("returns anonymized live tool output values", async () => {
    const boundary = createBoundary();
    const tools = {
      read_secret: {
        execute: async () => ({
          documentId: "doc_123",
          ids: ["person_456"],
          nationalId: "Secret-123",
          participants: ["Jan Novák", "Secret"],
          text: "Secret notes for Jan Novák",
        }),
      },
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      // SAFETY: the helper only reads and wraps execute() in this unit test.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      tools: tools as unknown as ToolSet,
    });
    // SAFETY: the test fixture above defines this execute signature.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const executable = prepared["read_secret"] as
      | { execute?: (() => Promise<unknown>) | undefined }
      | undefined;

    expect(await executable?.execute?.()).toEqual({
      documentId: "doc_123",
      ids: ["person_456"],
      nationalId: "[CUSTOM_1]-123",
      participants: ["[PERSON_1]", "[CUSTOM_1]"],
      text: "[CUSTOM_1] notes for [PERSON_1]",
    });
  });

  test("allows approved external tools to inherit raw mode", async () => {
    const boundary = createRawBoundary();
    const tools = {
      external_lookup: applyChatToolPolicy(
        tool({
          inputSchema: valibotSchema(v.strictObject({})),
          execute: async () => ({ text: "Secret notes for Jan Novák" }),
        }),
        CHAT_TOOL_POLICY_KIND.external,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      // SAFETY: the helper only reads and wraps execute() in this unit test.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      tools: tools as unknown as ToolSet,
    });
    // SAFETY: the test fixture above defines this execute signature.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const executable = prepared["external_lookup"] as
      | { execute?: (() => Promise<unknown>) | undefined }
      | undefined;

    if (!executable?.execute) {
      throw new Error("Expected external tool execute function");
    }

    const output = await executable.execute();
    expect(output).toEqual({
      text: "Secret notes for Jan Novák",
    });
  });

  test("allows official public lookup tools without anonymized mode", async () => {
    const boundary = createRawBoundary();
    const tools = {
      official_lookup: applyChatToolPolicy(
        tool({
          inputSchema: valibotSchema(v.strictObject({ ico: v.string() })),
          execute: async ({ ico }) => ({ ico, name: "Alza.cz a.s." }),
        }),
        CHAT_TOOL_POLICY_KIND.publicOfficial,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      // SAFETY: the helper only reads and wraps execute() in this unit test.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      tools: tools as unknown as ToolSet,
    });
    // SAFETY: the test fixture above defines this execute signature.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const executable = prepared["official_lookup"] as
      | { execute?: ((input: { ico: string }) => Promise<unknown>) | undefined }
      | undefined;

    expect(await executable?.execute?.({ ico: "27082440" })).toEqual({
      ico: "27082440",
      name: "Alza.cz a.s.",
    });
  });

  test("allows unofficial public lookup tools to inherit raw mode", async () => {
    const boundary = createRawBoundary();
    const tools = {
      unofficial_lookup: applyChatToolPolicy(
        tool({
          inputSchema: valibotSchema(v.strictObject({ query: v.string() })),
          execute: async ({ query }) => ({ query }),
        }),
        CHAT_TOOL_POLICY_KIND.publicUnofficial,
      ),
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      // SAFETY: the helper only reads and wraps execute() in this unit test.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      tools: tools as unknown as ToolSet,
    });
    // SAFETY: the test fixture above defines this execute signature.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const executable = prepared["unofficial_lookup"] as
      | {
          execute?:
            | ((input: { query: string }) => Promise<unknown>)
            | undefined;
        }
      | undefined;

    if (!executable?.execute) {
      throw new Error("Expected unofficial lookup execute function");
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
      throw new Error("Expected anonymized boundary");
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
      list_contacts: {
        execute: async (input: { query: string }) => {
          seenInputs.push(input);
          return { items: [{ name: input.query, id: "c1" }] };
        },
      },
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      // SAFETY: the helper only reads and wraps execute() in this unit test.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      tools: tools as unknown as ToolSet,
    });
    // SAFETY: the test fixture above defines this execute signature.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const executable = prepared["list_contacts"] as
      | {
          execute?:
            | ((input: { query: string }) => Promise<unknown>)
            | undefined;
        }
      | undefined;

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
      run_query: {
        execute: async (input: { code: string }) => {
          seenInputs.push(input);
          return { value: { items: [] } };
        },
      },
    };
    const prepared = prepareToolsForThirdParty({
      boundary,
      // SAFETY: the helper only reads and wraps execute() in this unit test.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      tools: tools as unknown as ToolSet,
    });
    // SAFETY: the test fixture above defines this execute signature.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const executable = prepared["run_query"] as
      | {
          execute?: ((input: { code: string }) => Promise<unknown>) | undefined;
        }
      | undefined;

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
      tool({
        inputSchema: valibotSchema(v.strictObject({ query: v.string() })),
        execute: async (input: { query: string }) => {
          seenInputs.push(input);
          return { hits: [] };
        },
      }),
      CHAT_TOOL_POLICY_KIND.external,
    );
    const prepared = prepareToolsForThirdParty({
      boundary,
      // SAFETY: the helper only reads and wraps execute() in this unit test.
      // eslint-disable-next-line typescript/no-unsafe-type-assertion
      tools: { external_search: externalTool } as unknown as ToolSet,
    });
    // SAFETY: the test fixture above defines this execute signature.
    // eslint-disable-next-line typescript/no-unsafe-type-assertion
    const executable = prepared["external_search"] as
      | {
          execute?:
            | ((input: { query: string }) => Promise<unknown>)
            | undefined;
        }
      | undefined;

    await executable?.execute?.({ query: "[PERSON_1]" });

    // External tool got the raw placeholder — real names never
    // leave Stella for third parties.
    expect(seenInputs).toEqual([{ query: "[PERSON_1]" }]);
  });
});
