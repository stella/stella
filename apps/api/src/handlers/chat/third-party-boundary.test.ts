import { toolDefinition } from "@tanstack/ai";
import { Result } from "better-result";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import fc from "fast-check";
import * as v from "valibot";

import { CHAT_SEND_MODE } from "@stll/anonymize-chat";
import { BROWSER_CONTROL_TOOL_NAME } from "@stll/api-contract/browser-control";
import { propertyConfig, propertySeed } from "@stll/property-testing";
import { rejectionOf } from "@stll/property-testing/rejection";

import { TEXT_PLAIN_MIME_TYPE } from "@/api/handlers/chat/attachment-validation";
import {
  createChatAttachmentPart,
  getChatAttachmentUrl,
  isChatAttachmentPart,
  isProviderVisibleChatPart,
  toChatMessageContent,
} from "@/api/handlers/chat/chat-message-parts";
import {
  applyChatToolPolicy,
  CHAT_TOOL_POLICY_KIND,
} from "@/api/handlers/chat/tools/tool-policy";
import type {
  ChatMessage,
  ChatPart,
  PersistableChatPartType,
} from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { toDataUrl } from "@/api/lib/data-url";
import {
  resetMetricLineSinkForTesting,
  setMetricLineSinkForTesting,
} from "@/api/lib/observability/request-metrics";
import { isRecord } from "@/api/lib/type-guards";
import { anonymizeTextFieldsWithDependencies } from "@/api/mcp/anonymization-core";
import { AnonymizedFieldBoundaryError } from "@/api/mcp/field-markers";
import { DOCX_MIME_TYPE } from "@/api/mime-types";
import {
  createRewritingAnonymizeDependencies,
  replaceFirstFieldDelimiterToken,
} from "@/api/tests/helpers/anonymize-pipeline-fakes";
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
    return Result.ok({
      entityCount: fields.length,
      fields: anonymized,
      redactionMap,
    });
  },
);

const {
  createChatThirdPartyBoundary,
  deanonymizeFromBoundary,
  deanonymizeUnknownStringsFromBoundary,
  prepareMcpToolSourceForThirdParty,
  prepareMessagesForThirdParty,
  prepareTextForThirdParty,
  prepareToolsForThirdParty,
  prepareUnknownForThirdParty,
  reserveThirdPartyBoundarySourcePlaceholders,
  storedRestorationsOf,
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
    threadRestorations: [],
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
    threadRestorations: [],
  });
};

const STORED_PART_VALUE = "Jan Novák";

const textDataUrl = (text: string) =>
  toDataUrl(Buffer.from(text, "utf-8"), TEXT_PLAIN_MIME_TYPE);

/** One stored part per part type, each carrying `STORED_PART_VALUE` in the
 *  content the provider would read. Typed over the part union, so a new part
 *  type fails typecheck until it has an entry here. */
const STORED_PART_CENSUS = {
  audio: {
    type: "audio",
    source: {
      type: "url",
      value: `https://example.test/${STORED_PART_VALUE}.mp3`,
      mimeType: "audio/mpeg",
    },
  },
  document: {
    type: "document",
    source: {
      type: "url",
      value: textDataUrl(`Notes on ${STORED_PART_VALUE}.`),
      mimeType: TEXT_PLAIN_MIME_TYPE,
    },
    metadata: { filename: "notes.txt" },
  },
  image: {
    type: "image",
    source: {
      type: "url",
      value: "data:image/png;base64,iVBORw0KGgo=",
      mimeType: "image/png",
    },
    metadata: { filename: `${STORED_PART_VALUE}.png` },
  },
  "structured-output": {
    type: "structured-output",
    status: "complete",
    raw: JSON.stringify({ party: STORED_PART_VALUE }),
    data: { party: STORED_PART_VALUE },
  },
  subagent: {
    type: "subagent",
    subagent: {
      id: "subagent-run-1",
      name: "research",
      status: "finished",
      messages: [
        {
          id: "subagent-msg-1",
          role: "assistant",
          parts: [{ type: "text", content: STORED_PART_VALUE }],
        },
      ],
    },
  },
  text: { type: "text", content: `Ask ${STORED_PART_VALUE}.` },
  thinking: { type: "thinking", content: `${STORED_PART_VALUE} signed.` },
  "tool-call": {
    type: "tool-call",
    id: "call_census",
    name: "mcp__test__search_documents",
    arguments: JSON.stringify({ query: STORED_PART_VALUE }),
    state: "input-complete",
    input: { query: STORED_PART_VALUE },
  },
  "tool-result": {
    type: "tool-result",
    toolCallId: "call_census",
    content: JSON.stringify({ text: `Signed by ${STORED_PART_VALUE}` }),
    state: "complete",
  },
  "ui-resource": {
    type: "ui-resource",
    resource: {
      uri: "ui://widget",
      mimeType: "text/html;profile=mcp-app",
      text: `<p>${STORED_PART_VALUE}</p>`,
    },
    toolCallId: "call_census",
    toolName: "widget",
  },
  video: {
    type: "video",
    source: {
      type: "url",
      value: `https://example.test/${STORED_PART_VALUE}.mp4`,
      mimeType: "video/mp4",
    },
  },
} satisfies {
  [Type in PersistableChatPartType]: Extract<ChatPart, { type: Type }>;
};

const DATA_URL_TEXT = /data:text\/plain;base64,(?<payload>[A-Za-z0-9+/=]+)/gu;

/** What a provider would read from prepared messages: the serialized parts
 *  plus the decoded text of inline text attachments. A refusal sends nothing. */
const providerViewOf = (
  prepared: Awaited<ReturnType<typeof prepareMessagesForThirdParty>>,
): string => {
  if (Result.isError(prepared)) {
    return "";
  }
  const serialized = JSON.stringify(prepared.value);
  const decoded = [...serialized.matchAll(DATA_URL_TEXT)].map((match) =>
    Buffer.from(match.groups?.["payload"] ?? "", "base64").toString("utf-8"),
  );
  return [serialized, ...decoded].join("\n");
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
      threadRestorations: [],
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
      "0198f3e8-75f2-7c11-8af0-111111111111",
    );
    const scopeId = "22222222-2222-4222-8222-222222222222";
    const anonymizeIds = mock(
      async ({
        fields,
      }: {
        fields: string[];
        forcedSensitiveValues?: readonly string[] | undefined;
      }) => {
        const redactionMap = new Map<string, string>();
        const anonymized = fields.map((field, index) => {
          const placeholder = `[MISC_${String(index + 1)}]`;
          redactionMap.set(placeholder, field);
          return placeholder;
        });
        return Result.ok({
          entityCount: fields.length,
          fields: anonymized,
          redactionMap,
        });
      },
    );
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeIds,
      anonymizationScopeId: scopeId,
      organizationId,
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [],
    });

    const prepared = await prepareUnknownForThirdParty({
      boundary,
      value: {
        organizationId,
        legacyId: organizationId.toUpperCase(),
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
      legacyId: "[MISC_2]",
      id: "[MISC_3]",
      scopeId: "[MISC_4]",
      documentId: "doc_123",
    });
    expect(anonymizeIds.mock.calls.at(0)?.[0].fields).toEqual([
      organizationId,
      organizationId.toUpperCase(),
      `ref_${organizationId}`,
      `scope:${scopeId}`,
    ]);
    expect(anonymizeIds.mock.calls.at(0)?.[0].forcedSensitiveValues).toContain(
      organizationId.toUpperCase(),
    );
  });

  test("forces boundary IDs through structured object keys", async () => {
    const organizationId = "11111111-1111-4111-8111-111111111111";
    const anonymizeIds = mock(async ({ fields }: { fields: string[] }) =>
      Result.ok({
        entityCount: fields.length,
        fields: fields.map(() => "[MISC_1]"),
        redactionMap: new Map([["[MISC_1]", fields.at(0) ?? ""]]),
      }),
    );
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeIds,
      anonymizationScopeId: "workspace-A",
      organizationId: toSafeId<"organization">(organizationId),
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [],
    });

    const prepared = await prepareUnknownForThirdParty({
      boundary,
      value: {
        [`tenant:${organizationId}`]: 7,
        "[MISC_1]": 8,
      },
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    expect(prepared.value).toEqual({ "[MISC_2]": 7, "[MISC_1]": 8 });
    expect(
      deanonymizeUnknownStringsFromBoundary(boundary, prepared.value),
    ).toEqual({ [`tenant:${organizationId}`]: 7, "[MISC_1]": 8 });
    expect(
      deanonymizeUnknownStringsFromBoundary(
        boundary,
        { MISC_2: 7, "[MISC_1]": 8 },
        "lenient",
      ),
    ).toEqual({ [`tenant:${organizationId}`]: 7, "[MISC_1]": 8 });
    expect(anonymizeIds.mock.calls.at(0)?.[0].fields).toEqual([
      `tenant:${organizationId}`,
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

  test("prepares a stored structured output for the send mode", async () => {
    const boundary = createBoundary();
    const stored = {
      type: "structured-output",
      status: "complete",
      raw: JSON.stringify({ party: "Jan Novák", note: "Secret" }),
      data: { party: "Jan Novák", note: "Secret" },
      partial: { party: "Jan Novák" },
      reasoning: "Jan Novák signed.",
    } satisfies ChatMessage["parts"][number];

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages: [{ id: "msg_1", role: "assistant", parts: [stored] }],
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    const part = prepared.value.at(0)?.parts.at(0);
    if (part?.type !== "structured-output") {
      throw new TypeError("Expected a prepared structured output");
    }
    expect(JSON.parse(part.raw)).toEqual({
      party: "[PERSON_1]",
      note: "[CUSTOM_1]",
    });
    expect(part.data).toEqual({ party: "[PERSON_1]", note: "[CUSTOM_1]" });
    expect(part.partial).toEqual({ party: "[PERSON_1]" });
    expect(part.reasoning).toBe("[PERSON_1] signed.");
    expect(JSON.stringify(prepared.value)).not.toContain("Jan Novák");
  });

  test("prepares a streaming or failed structured output as text", async () => {
    const boundary = createBoundary();
    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          parts: [
            {
              type: "structured-output",
              status: "error",
              raw: '{"party":"Jan Novák',
              errorMessage: "Invalid output for Secret",
            },
          ],
        },
      ],
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    expect(prepared.value.at(0)?.parts.at(0)).toEqual({
      type: "structured-output",
      status: "error",
      raw: '{"party":"[PERSON_1]',
      errorMessage: "Invalid output for [CUSTOM_1]",
    });
  });

  test("every stored part type is prepared for the send mode", async () => {
    for (const [partType, part] of Object.entries(STORED_PART_CENSUS)) {
      const messages: ChatMessage[] = [
        { id: `msg_${partType}`, role: "assistant", parts: [part] },
      ];
      const raw = await prepareMessagesForThirdParty({
        boundary: createRawBoundary(),
        messages,
      });
      const anonymized = await prepareMessagesForThirdParty({
        boundary: createBoundary(),
        messages,
      });

      // The fixture reaches the boundary: raw mode sends every
      // model-visible part as stored.
      expect(Result.isOk(raw)).toBe(true);
      expect(providerViewOf(raw).includes(STORED_PART_VALUE)).toBe(
        isProviderVisibleChatPart(part),
      );
      // Anonymized mode sends it prepared, or not at all.
      expect(providerViewOf(anonymized)).not.toContain(STORED_PART_VALUE);
    }
  });

  test("replays a raw-mode-only tool's stored calls only in raw mode", async () => {
    const messages: ChatMessage[] = [
      {
        id: "msg_1",
        role: "assistant",
        parts: [
          { type: "text", content: "Checked the counterparty." },
          {
            type: "tool-call",
            id: "call_check",
            name: "counterparty_check",
            arguments: JSON.stringify({ name: "Acme s.r.o." }),
            state: "complete",
          },
          {
            type: "tool-result",
            toolCallId: "call_check",
            content: JSON.stringify({ findings: ["born 1970-01-01"] }),
            state: "complete",
          },
        ],
      },
      {
        id: "msg_2",
        role: "assistant",
        parts: [
          {
            type: "tool-result",
            toolCallId: "call_review",
            name: "review_folder_consistency",
            content: "Two documents disagree.",
            state: "complete",
          },
        ],
      },
    ];

    const raw = await prepareMessagesForThirdParty({
      boundary: createRawBoundary(),
      messages,
    });
    const anonymized = await prepareMessagesForThirdParty({
      boundary: createBoundary(),
      messages,
    });

    if (Result.isError(raw) || Result.isError(anonymized)) {
      throw new TypeError("Expected both boundaries to prepare the history");
    }
    expect(raw.value.flatMap((message) => message.parts)).toHaveLength(4);
    expect(anonymized.value).toEqual([
      {
        id: "msg_1",
        role: "assistant",
        parts: [{ type: "text", content: "Checked the counterparty." }],
      },
    ]);
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

  test("refuses rich-media URLs that require redaction", async () => {
    const organizationId = toSafeId<"organization">(
      "11111111-1111-4111-8111-111111111111",
    );
    const anonymizeIds = mock(async ({ fields }: { fields: string[] }) =>
      Result.ok({
        entityCount: 1,
        fields: fields.map((field) =>
          field.replaceAll(organizationId, () => "[MISC_1]"),
        ),
        redactionMap: new Map([["[MISC_1]", organizationId]]),
      }),
    );
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeIds,
      anonymizationScopeId: "workspace-A",
      organizationId,
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [],
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

    expect(Result.isError(prepared)).toBe(true);
    if (Result.isOk(prepared)) {
      throw new TypeError("Expected sensitive rich-media URL refusal");
    }
    expect(prepared.error.status).toBe(422);
    expect(anonymizeIds.mock.calls.at(0)?.[0].fields).toEqual([
      `https://example.test/${organizationId}/image.png`,
      `https://example.test/${organizationId}/audio.mp3`,
      `https://example.test/${organizationId}/video.mp4`,
      `https://example.test/${organizationId}/document.pdf`,
      `ref_${organizationId}`,
    ]);
  });

  test("preserves safe rich-media URLs while anonymizing metadata", async () => {
    const boundary = createBoundary();
    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          parts: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              content: [
                {
                  type: "image",
                  source: {
                    type: "url",
                    value: "https://example.test/image.png",
                    mimeType: "image/png",
                  },
                  metadata: { caption: "Jan Novák" },
                },
              ],
              state: "complete",
            },
          ],
        },
      ],
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    expect(prepared.value.at(0)?.parts.at(0)).toMatchObject({
      content: [
        {
          source: { value: "https://example.test/image.png" },
          metadata: { caption: "[PERSON_1]" },
        },
      ],
    });
  });

  test("refuses opaque inline rich-media tool results", async () => {
    const boundary = createBoundary();
    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          parts: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              content: [
                {
                  type: "image",
                  source: {
                    type: "data",
                    value: "AliceAAA",
                    mimeType: "image/png",
                  },
                },
              ],
              state: "complete",
            },
          ],
        },
      ],
    });

    expect(Result.isError(prepared)).toBe(true);
    if (Result.isOk(prepared)) {
      throw new TypeError("Expected inline rich-media refusal");
    }
    expect(prepared.error.status).toBe(422);
    expect(anonymizeTextFieldsMock).not.toHaveBeenCalled();
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

  test("reserves static tool metadata in the initial source prepass", async () => {
    const boundary = createBoundary();
    const tools = asTestToolSet({
      literal_metadata: applyChatToolPolicy(
        toolDefinition({
          name: "literal_metadata",
          description: "Preserve literal [PERSON_1].",
        }).server(async () => undefined),
        CHAT_TOOL_POLICY_KIND.internal,
      ),
    });
    reserveThirdPartyBoundarySourcePlaceholders({
      boundary,
      value: ["System prompt", tools],
    });

    const prepared = await prepareTextForThirdParty({
      boundary,
      text: "Jan Novák prepared the memo.",
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    expect(prepared.value).toBe("[PERSON_2] prepared the memo.");
  });

  test("aliases claimed placeholders in late MCP tool metadata", async () => {
    const boundary = createBoundary();
    await prepareTextForThirdParty({
      boundary,
      text: "Jan Novák prepared the memo.",
    });
    const sourceTool = toolDefinition({
      name: "mcp__test__literal_metadata",
      description:
        "Read Jan Novák; preserve literal [PERSON_1] in the description.",
    }).server(async () => undefined);
    Reflect.set(sourceTool, "inputSchema", {
      type: "object",
      properties: {
        "[PERSON_1]": {
          description:
            "Enter Jan Novák or preserve literal [PERSON_1] in the example.",
          type: "string",
        },
        "Jan Novák": {
          description: "A sensitive schema property name.",
          type: "string",
        },
      },
    });
    const source = prepareMcpToolSourceForThirdParty({
      boundary,
      source: {
        close: async () => {},
        tools: async () => [sourceTool],
      },
    });

    const [preparedTool] = await source.tools();
    if (!preparedTool) {
      throw new TypeError("Expected an MCP tool");
    }
    const description: unknown = Reflect.get(preparedTool, "description");
    const inputSchema: unknown = Reflect.get(preparedTool, "inputSchema");

    expect(description).toBe(
      "Read [PERSON_1]; preserve literal [LITERAL_PLACEHOLDER_1] in the description.",
    );
    expect(inputSchema).toEqual({
      type: "object",
      properties: {
        "[LITERAL_PLACEHOLDER_2]": {
          description:
            "Enter [PERSON_1] or preserve literal [LITERAL_PLACEHOLDER_3] in the example.",
          type: "string",
        },
        "[PERSON_1]": {
          description: "A sensitive schema property name.",
          type: "string",
        },
      },
    });
    expect(
      deanonymizeUnknownStringsFromBoundary(boundary, inputSchema),
    ).toEqual({
      type: "object",
      properties: {
        "[PERSON_1]": {
          description:
            "Enter Jan Novák or preserve literal [PERSON_1] in the example.",
          type: "string",
        },
        "Jan Novák": {
          description: "A sensitive schema property name.",
          type: "string",
        },
      },
    });
  });

  test("keeps MCP metadata envelope keys stable and restores only schema argument keys", async () => {
    const anonymizeMetadata = mock(async ({ fields }: { fields: string[] }) =>
      Result.ok({
        entityCount: fields.length,
        fields: fields.map((field) =>
          field
            .replaceAll("description", "[FIELD_1]")
            .replaceAll("Jan Novák", "[PERSON_1]")
            .replaceAll("Secret", "[CUSTOM_1]"),
        ),
        redactionMap: new Map([
          ["[CUSTOM_1]", "Secret"],
          ["[FIELD_1]", "description"],
          ["[PERSON_1]", "Jan Novák"],
        ]),
      }),
    );
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeMetadata,
      anonymizationScopeId: "workspace-A",
      organizationId: toSafeId<"organization">(
        "11111111-1111-4111-8111-111111111111",
      ),
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [],
    });
    let executedInput: unknown;
    const sourceTool = toolDefinition({
      name: "mcp__test__sensitive_schema_key",
      description: "Secret",
    }).server(async (input) => {
      executedInput = input;
      return { status: "ok" };
    });
    Reflect.set(sourceTool, "inputSchema", {
      properties: {
        "Jan Novák": { type: "string" },
      },
      type: "object",
    });
    const source = prepareMcpToolSourceForThirdParty({
      boundary,
      source: {
        close: async () => {},
        tools: async () => [sourceTool],
      },
    });

    const [preparedTool] = await source.tools();
    if (!preparedTool) {
      throw new TypeError("Expected an MCP tool");
    }
    const executable = asTestExecutable<unknown, unknown>(preparedTool);

    expect(Reflect.get(preparedTool, "description")).toBe("[CUSTOM_1]");
    expect(Reflect.get(preparedTool, "inputSchema")).toEqual({
      properties: {
        "[PERSON_1]": { type: "string" },
      },
      type: "object",
    });
    await executable?.execute?.({
      "[PERSON_1]": "Keep [PERSON_1] anonymized",
    });
    expect(executedInput).toEqual({
      "Jan Novák": "Keep [PERSON_1] anonymized",
    });
  });

  test("rejects sensitive MCP tool names instead of corrupting identifiers", async () => {
    const organizationId = toSafeId<"organization">(
      "11111111-1111-4111-8111-111111111111",
    );
    const anonymizeIds = mock(async ({ fields }: { fields: string[] }) =>
      Result.ok({
        entityCount: 1,
        fields: fields.map((field) =>
          field.replaceAll(organizationId, () => "[MISC_1]"),
        ),
        redactionMap: new Map([["[MISC_1]", organizationId]]),
      }),
    );
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeIds,
      anonymizationScopeId: "workspace-A",
      organizationId,
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [],
    });
    const sourceTool = toolDefinition({
      name: `mcp__crm__${organizationId}`,
      description: "Read a record.",
    }).server(async () => undefined);
    const source = prepareMcpToolSourceForThirdParty({
      boundary,
      source: {
        close: async () => {},
        tools: async () => [sourceTool],
      },
    });

    expect(await rejectionOf(source.tools())).toHaveProperty(
      "message",
      expect.stringContaining(
        "MCP tool names that contain sensitive data cannot cross an anonymized third-party boundary.",
      ),
    );
  });

  test("aliases late literal placeholders in runtime tool output", async () => {
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
      return Result.ok({
        entityCount: redactionMap.size,
        fields: anonymized,
        redactionMap,
      });
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
      threadRestorations: [],
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
      return Result.ok({
        entityCount: redactionMap.size,
        fields: anonymized,
        redactionMap,
      });
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
      threadRestorations: [],
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
    expect(second.value).toBe(
      "Results for [LITERAL_PLACEHOLDER_1]: [PERSON_2]",
    );
    if (boundary.type !== "anonymized") {
      throw new TypeError("Expected anonymized boundary");
    }
    expect(boundary.redactionMap).toEqual(
      new Map([
        ["[PERSON_1]", "Bob"],
        ["[PERSON_2]", "Alice"],
      ]),
    );
    expect(deanonymizeFromBoundary({ boundary, text: second.value })).toBe(
      "Results for [PERSON_1]: Alice",
    );
  });

  test("reserves later source placeholders before an earlier allocation", async () => {
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
    const anonymizeSecret = mock(async ({ fields }: { fields: string[] }) =>
      Result.ok({
        entityCount: 1,
        fields: fields.map((field) =>
          field.replaceAll("Secret", () => "[MISC_2]"),
        ),
        redactionMap: new Map([["[MISC_2]", "Secret"]]),
      }),
    );
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeSecret,
      anonymizationScopeId: "workspace-A",
      organizationId: toSafeId<"organization">(
        "11111111-1111-4111-8111-111111111111",
      ),
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [],
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
    const anonymizeSecrets = mock(async ({ fields }: { fields: string[] }) =>
      Result.ok({
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
      }),
    );
    const { scopedDb } = createScopedDbMock({});
    const boundary = createChatThirdPartyBoundary({
      anonymizeFields: anonymizeSecrets,
      anonymizationScopeId: "workspace-A",
      organizationId: toSafeId<"organization">(
        "11111111-1111-4111-8111-111111111111",
      ),
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [],
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

  test("round-trip helpers are no-ops on raw boundaries", () => {
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

// Anonymization numbers each call from `[LABEL_1]` in order of appearance,
// as the native pipeline does, so two requests that meet the same people in
// a different order number them differently unless the boundary starts from
// the thread's names.
const PEOPLE = ["Alice", "Bob", "Carol"] as const;

const anonymizeInOrderOfAppearance = async ({
  fields,
}: {
  fields: string[];
}) => {
  const redactionMap = new Map<string, string>();
  const anonymized = fields.map((field) => {
    const byAppearance = PEOPLE.filter((person) => field.includes(person))
      .map((person) => ({ at: field.indexOf(person), person }))
      .toSorted((a, b) => a.at - b.at);
    let next = field;
    for (const [index, { person }] of byAppearance.entries()) {
      const placeholder = `[PERSON_${String(index + 1)}]`;
      next = next.replaceAll(person, () => placeholder);
      redactionMap.set(placeholder, person);
    }
    return next;
  });
  return Result.ok({
    entityCount: redactionMap.size,
    fields: anonymized,
    redactionMap,
  });
};

const createThreadBoundary = (
  threadRestorations: readonly { original: string; placeholder: string }[],
) => {
  const { scopedDb } = createScopedDbMock({});
  return createChatThirdPartyBoundary({
    anonymizeFields: anonymizeInOrderOfAppearance,
    anonymizationScopeId: "workspace-A",
    organizationId: toSafeId<"organization">(
      "11111111-1111-4111-8111-111111111111",
    ),
    scopedDb,
    sendMode: CHAT_SEND_MODE.anonymized,
    threadRestorations,
  });
};

describe("anonymization placeholders across a thread's requests", () => {
  // The test anonymizer does not recognise this name; only the thread's
  // earlier mapping does.
  const EARLIER = { placeholder: "[PERSON_1]", original: "Dana Novotná" };

  test("replaces a value mapped earlier even where it is not recognised again", async () => {
    const boundary = createThreadBoundary([EARLIER]);

    const prepared = await prepareTextForThirdParty({
      boundary,
      text: "Send it to Dana Novotná and Alice, not to Dana Novotnáová.",
    });

    if (Result.isError(prepared) || boundary.type !== "anonymized") {
      throw new TypeError("Expected anonymization to succeed");
    }
    expect(prepared.value).toBe(
      "Send it to [PERSON_1] and [PERSON_2], not to Dana Novotnáová.",
    );
    expect(deanonymizeFromBoundary({ boundary, text: prepared.value })).toBe(
      "Send it to Dana Novotná and Alice, not to Dana Novotnáová.",
    );
  });

  test("an approved call's resumed payload keeps earlier mappings", async () => {
    const boundary = createThreadBoundary([EARLIER]);

    const prepared = await prepareUnknownForThirdParty({
      boundary,
      value: { output: { signedBy: "Dana Novotná", status: "sent" } },
    });

    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    expect(prepared.value).toEqual({
      output: { signedBy: "[PERSON_1]", status: "sent" },
    });
  });

  test("a browser call's real values stay placeholders in the model's history", async () => {
    // The browser receives real values: its stored call and the page it
    // returns carry them back into the thread.
    const boundary = createThreadBoundary([EARLIER]);
    const fill = {
      action: "fill",
      page: { revision: "revision-1", url: "https://example.test/form" },
      target: { name: "Signatory", ref: "e1", role: "textbox" },
      value: "Dana Novotná",
    };

    const prepared = await prepareMessagesForThirdParty({
      boundary,
      messages: [
        {
          id: "msg_1",
          role: "assistant",
          parts: [
            {
              type: "tool-call",
              id: "call_browser",
              name: BROWSER_CONTROL_TOOL_NAME,
              arguments: JSON.stringify(fill),
              input: fill,
              state: "complete",
            },
            {
              type: "tool-result",
              toolCallId: "call_browser",
              content: JSON.stringify({
                status: "success",
                snapshot: { text: "Signatory: Dana Novotná", title: "Form" },
              }),
              state: "complete",
            },
          ],
        },
      ],
    });

    if (Result.isError(prepared)) {
      throw prepared.error;
    }
    const modelView = JSON.stringify(prepared.value);
    expect(modelView).not.toContain("Dana Novotná");
    expect(modelView).toContain("[PERSON_1]");
  });

  test("a later request keeps earlier names and numbers new ones after them", async () => {
    const boundary = createThreadBoundary([
      { placeholder: "[PERSON_1]", original: "Alice" },
    ]);

    const prepared = await prepareTextForThirdParty({
      boundary,
      text: "Bob briefed Alice.",
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared) || boundary.type !== "anonymized") {
      throw new TypeError("Expected anonymization to succeed");
    }
    expect(prepared.value).toBe("[PERSON_2] briefed [PERSON_1].");
    expect(boundary.redactionMap).toEqual(
      new Map([
        ["[PERSON_1]", "Alice"],
        ["[PERSON_2]", "Bob"],
      ]),
    );
  });

  test("does not restore an omitted historical placeholder", () => {
    const boundary = createThreadBoundary([
      { placeholder: "[PERSON_1]", original: "Alice" },
    ]);

    expect(deanonymizeFromBoundary({ boundary, text: "[PERSON_1]" })).toBe(
      "[PERSON_1]",
    );
    expect(
      deanonymizeUnknownStringsFromBoundary(boundary, {
        value: "[PERSON_1]",
      }),
    ).toEqual({ value: "[PERSON_1]" });
  });

  test("aliases a literal historical placeholder in the current request", async () => {
    const boundary = createThreadBoundary([
      { placeholder: "[PERSON_1]", original: "Alice" },
    ]);
    const prepared = await prepareTextForThirdParty({
      boundary,
      text: "Echo [PERSON_1]; Alice answered.",
    });

    expect(Result.isOk(prepared)).toBe(true);
    if (Result.isError(prepared) || boundary.type !== "anonymized") {
      throw new TypeError("Expected anonymization to succeed");
    }
    expect(prepared.value).toBe(
      "Echo [LITERAL_PLACEHOLDER_1]; [PERSON_1] answered.",
    );
    expect(boundary.redactionMap).toEqual(new Map([["[PERSON_1]", "Alice"]]));
    expect(deanonymizeFromBoundary({ boundary, text: prepared.value })).toBe(
      "Echo [PERSON_1]; Alice answered.",
    );
  });

  test("one placeholder never names two originals in a thread", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Each request mentions some of the people in some order.
        fc.array(fc.shuffledSubarray([...PEOPLE], { minLength: 1 }), {
          minLength: 1,
          maxLength: 4,
        }),
        async (requests) => {
          const threadRestorations: {
            original: string;
            placeholder: string;
          }[] = [];
          for (const people of requests) {
            const boundary = createThreadBoundary(threadRestorations);
            const prepared = await prepareTextForThirdParty({
              boundary,
              text: people.join(" met "),
            });
            if (Result.isError(prepared) || boundary.type !== "anonymized") {
              throw new TypeError("Expected anonymization to succeed");
            }
            // What the turn stores: every placeholder the request sent.
            for (const [placeholder, original] of boundary.redactionMap) {
              threadRestorations.push({ placeholder, original });
            }
          }
          const named = new Map<string, Set<string>>();
          for (const { original, placeholder } of threadRestorations) {
            named.set(
              placeholder,
              new Set([...(named.get(placeholder) ?? []), original]),
            );
          }
          for (const originals of named.values()) {
            expect(originals.size).toBe(1);
          }
        },
      ),
      propertyConfig({ numRuns: 200, seed: propertySeed() }),
    );
  });
});

describe("the restorations a request's history holds", () => {
  test("are read from current and legacy stored turns, oldest first", () => {
    const pairs = storedRestorationsOf([
      {
        id: toSafeId<"chatMessage">("00000000-0000-4000-8000-000000000001"),
        role: "assistant",
        content: {
          version: 1,
          data: [
            {
              type: "data-stella-anon-restorations",
              data: {
                pairs: [{ placeholder: "[PERSON_1]", original: "Alice" }],
              },
            },
          ],
        },
      },
      {
        id: toSafeId<"chatMessage">("00000000-0000-4000-8000-000000000002"),
        role: "assistant",
        content: toChatMessageContent({
          data: [{ type: "text", content: "Noted." }],
          metadata: {
            anonRestorations: {
              pairs: [{ placeholder: "[PERSON_2]", original: "Bob" }],
            },
          },
          version: 2,
        }),
      },
    ]);

    expect(pairs).toEqual([
      { placeholder: "[PERSON_1]", original: "Alice" },
      { placeholder: "[PERSON_2]", original: "Bob" },
    ]);
  });
});

describe("anonymized boundary refusals", () => {
  const organizationId = toSafeId<"organization">(
    "11111111-1111-4111-8111-111111111111",
  );

  const boundaryWith = (
    anonymizeFields: Parameters<
      typeof createChatThirdPartyBoundary
    >[0]["anonymizeFields"],
  ) =>
    createChatThirdPartyBoundary({
      anonymizeFields,
      anonymizationScopeId: "workspace-A",
      organizationId,
      scopedDb: createScopedDbMock({}).scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [],
    });

  /** What `run` returned, and the refusal counts written while it ran. */
  const refusalsDuring = async <T>(run: () => Promise<T>) => {
    const lines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      lines.push(line);
    });
    try {
      const value = await run();
      const refusals = lines
        .map((line): unknown => JSON.parse(line))
        .filter(isRecord)
        .filter((record) => "AnonymizationRefusals" in record)
        .map(({ reason, site }) => ({ reason, site }));
      return { refusals, value };
    } finally {
      resetMetricLineSinkForTesting();
    }
  };

  test("a failing anonymizer refuses the text and counts one pipeline error", async () => {
    const boundary = boundaryWith(
      async () => await Promise.reject(new Error("anonymizer unavailable")),
    );
    const { refusals, value: prepared } = await refusalsDuring(
      async () =>
        await prepareTextForThirdParty({
          boundary,
          text: "Jan Novák signed the contract.",
        }),
    );

    expect(Result.isError(prepared) ? prepared.error.status : null).toBe(500);
    expect(refusals).toEqual([
      { reason: "pipeline_error", site: "text_batch" },
    ]);
  });

  test("an attachment it cannot read counts as unsupported content", async () => {
    const { refusals } = await refusalsDuring(
      async () =>
        await prepareMessagesForThirdParty({
          boundary: boundaryWith(anonymizeTextFieldsMock),
          messages: [
            {
              id: "msg_1",
              role: "user",
              parts: [
                createChatAttachmentPart({
                  filename: "draft.docx",
                  mimeType: DOCX_MIME_TYPE,
                  url: toDataUrl(new Uint8Array([1, 2, 3]), DOCX_MIME_TYPE),
                }),
              ],
            },
          ],
        }),
    );

    expect(refusals).toEqual([
      { reason: "unsupported_content", site: "attachment" },
    ]);
  });

  test("a value that must cross unchanged counts as a field boundary", async () => {
    const boundary = boundaryWith(async ({ fields }) =>
      Result.ok({
        entityCount: 1,
        fields: fields.map((field) =>
          field.replaceAll(organizationId, () => "[MISC_1]"),
        ),
        redactionMap: new Map([["[MISC_1]", organizationId]]),
      }),
    );
    const { refusals } = await refusalsDuring(
      async () =>
        await prepareMessagesForThirdParty({
          boundary,
          messages: [
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
                    },
                  ],
                  state: "complete",
                },
              ],
            },
          ],
        }),
    );

    expect(refusals).toEqual([
      { reason: "field_boundary", site: "text_batch" },
    ]);
  });

  test("a prepared crossing counts nothing", async () => {
    const { refusals } = await refusalsDuring(
      async () =>
        await prepareTextForThirdParty({
          boundary: boundaryWith(anonymizeTextFieldsMock),
          text: "Jan Novák signed the contract.",
        }),
    );

    expect(refusals).toEqual([]);
  });
});

describe("anonymization output that lost its field structure", () => {
  const createBoundaryOverPipeline = (rewrite: (text: string) => string) => {
    const { scopedDb } = createScopedDbMock({});
    const dependencies = createRewritingAnonymizeDependencies(rewrite);
    return createChatThirdPartyBoundary({
      anonymizeFields: async (input) =>
        await anonymizeTextFieldsWithDependencies({ ...input, dependencies }),
      anonymizationScopeId: "workspace-A",
      organizationId: toSafeId<"organization">(
        "11111111-1111-4111-8111-111111111111",
      ),
      scopedDb,
      sendMode: CHAT_SEND_MODE.anonymized,
      threadRestorations: [{ placeholder: "[PERSON_1]", original: "Alice" }],
    });
  };

  test("refuses the text and keeps the thread's placeholders unchanged", async () => {
    const boundary = createBoundaryOverPipeline((text) =>
      replaceFirstFieldDelimiterToken(text, "[ORGANIZATION_1]"),
    );
    if (boundary.type !== "anonymized") {
      throw new TypeError("Expected anonymized boundary");
    }
    const placeholdersBefore = new Map(boundary.redactionMap);
    const metricLines: string[] = [];
    setMetricLineSinkForTesting((line) => {
      metricLines.push(line);
    });

    const prepared = await prepareTextForThirdParty({
      boundary,
      text: "Bob briefed Alice.",
    }).finally(() => {
      resetMetricLineSinkForTesting();
    });

    expect(Result.isError(prepared)).toBe(true);
    if (Result.isOk(prepared)) {
      return;
    }
    expect(prepared.error.status).toBe(500);
    expect(prepared.error.cause).toBeInstanceOf(AnonymizedFieldBoundaryError);
    expect(boundary.redactionMap).toEqual(placeholdersBefore);
    // The refusal is counted once, as a damaged field structure.
    expect(metricLines.map((line): unknown => JSON.parse(line))).toEqual([
      expect.objectContaining({
        AnonymizationRefusals: 1,
        reason: "field_boundary",
        site: "text_batch",
      }),
    ]);
  });

  test("passes the text through when the structure survives", async () => {
    const boundary = createBoundaryOverPipeline((text) => text);

    const prepared = await prepareTextForThirdParty({
      boundary,
      text: "Bob briefed Alice.",
    });

    // The thread already sent Alice under a placeholder, so she keeps it.
    expect(Result.isOk(prepared) ? prepared.value : prepared.error).toBe(
      "Bob briefed [PERSON_1].",
    );
  });
});
