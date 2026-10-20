import { panic, Result } from "better-result";
import { deepEquals } from "bun";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";
import { assertProperty } from "@stll/property-testing";

import {
  isChatPart,
  normalizePersistedChatMessageContent,
} from "@/api/handlers/chat/chat-message-parts";
import { errorToolResult } from "@/api/handlers/chat/chat-turn-settlement";
import { normalizeStoredChatToolExecutor } from "@/api/handlers/chat/legacy-tool-compat";
import type { ChatPart } from "@/api/handlers/chat/types";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

import goldenFixtures from "./__fixtures__/chat-content-v3-legacy-goldens.json" with { type: "json" };
import refusalFixtures from "./__fixtures__/chat-content-v3-legacy-refusals.json" with { type: "json" };
import stagingFixtures from "./__fixtures__/chat-content-v3-step-start-rows.json" with { type: "json" };
import { accountLegacyChatContent } from "./chat-content-v3-accounting";
import {
  convertLegacyChatContent,
  inspectLegacyChatContent,
  LegacyChatContentError,
  LOSSY_JSON_NUMBER,
} from "./chat-content-v3-legacy";

describe("frozen legacy conversion preserves pre-cutover persisted output", () => {
  test("captured fixtures exercise both retired versions", () => {
    expect(new Set(goldenFixtures.map(({ input }) => input.version))).toEqual(
      new Set([1, 2]),
    );
  });
  for (const { name, input, expected } of goldenFixtures) {
    test(name, () => {
      const converted = convertLegacyChatContent(input);
      expect(deepEquals(converted, expected)).toBe(true);
      expect(
        accountLegacyChatContent(input, converted).unaccountedFields,
      ).toEqual([]);
    });
  }
});

// A filename the attachment sanitizer would change has no lossless v3 home.
test("a legacy filename the sanitizer would change refuses the whole message", () => {
  expect(refusalFixtures.length).toBeGreaterThan(0);
  for (const { input } of refusalFixtures) {
    const result = Result.try({
      try: () => convertLegacyChatContent(input),
      catch: (error) => error,
    });
    if (result.isOk() || !(result.error instanceof LegacyChatContentError)) {
      panic("Unsafe legacy filename did not refuse with a typed error");
    }
    expect(result.error.reason).toBe("unaccounted-legacy-field");
    expect(result.error.accounting?.unaccountedFields).toContainEqual(
      expect.stringContaining("filename"),
    );
  }
});

test("rejected SDK input, text provider metadata and non-reproducible arguments survive conversion and reload", () => {
  const sdk = {
    version: 1,
    data: [
      {
        type: "text",
        text: "Answer",
        state: "done",
        providerMetadata: { openai: { itemId: "item_1", phase: "final" } },
      },
      {
        type: "tool-search",
        toolCallId: "call_1",
        state: "output-error",
        rawInput: { query: ["not", "a", "string"] },
        errorText: "Invalid input",
      },
    ],
  };
  const converted = convertLegacyChatContent(sdk);
  expect(accountLegacyChatContent(sdk, converted).unaccountedFields).toEqual(
    [],
  );
  const reloaded = normalizePersistedChatMessageContent(converted).parts;
  expect(reloaded.at(0)).toMatchObject({
    type: "text",
    providerMetadata: { openai: { itemId: "item_1", phase: "final" } },
  });
  const call = reloaded.find((part) => part.type === "tool-call");
  if (call?.type !== "tool-call") {
    panic("Rejected SDK input lost its tool call");
  }
  expect(call.input).toBeUndefined();
  expect(JSON.parse(call.arguments)).toEqual({
    query: ["not", "a", "string"],
  });

  const v2 = {
    version: 2,
    data: [
      {
        type: "tool-call",
        id: "call_2",
        name: "search",
        state: "input-complete",
        arguments: '{"query":"draft"}',
        input: { query: "final" },
      },
      {
        type: "text",
        content: "Answer",
        providerMetadata: { openai: { itemId: "item_2" } },
      },
    ],
  };
  const convertedV2 = convertLegacyChatContent(v2);
  expect(accountLegacyChatContent(v2, convertedV2).unaccountedFields).toEqual(
    [],
  );
  const reloadedV2 = normalizePersistedChatMessageContent(convertedV2).parts;
  expect(reloadedV2.at(0)).toMatchObject({
    arguments: '{"query":"draft"}',
    input: { query: "final" },
  });
  expect(reloadedV2.at(1)).toMatchObject({
    type: "text",
    providerMetadata: { openai: { itemId: "item_2" } },
  });
});

test("all nine content-free staging messages convert with complete field accounting", () => {
  expect(stagingFixtures).toHaveLength(9);
  for (const input of stagingFixtures) {
    const converted = convertLegacyChatContent(input);
    expect(
      accountLegacyChatContent(input, converted).unaccountedFields,
    ).toEqual([]);
  }
});

const objectPaths = (value: unknown, path: string[] = []): string[][] => {
  if (isUnknownArray(value)) {
    return value.flatMap((item, index) =>
      objectPaths(item, [...path, String(index)]),
    );
  }
  if (!isRecord(value)) {
    return [];
  }
  return [
    path,
    ...Object.entries(value).flatMap(([key, item]) =>
      objectPaths(item, [...path, key]),
    ),
  ];
};

const injectUnknownField = (source: unknown, path: string[]): unknown => {
  const result: unknown = structuredClone(source);
  let target = result;
  for (const key of path) {
    if (isUnknownArray(target)) {
      target = target.at(Number(key));
    } else if (isRecord(target)) {
      target = target[key];
    } else {
      panic("Mutation path does not address a source object");
    }
  }
  if (!isRecord(target)) {
    panic("Mutation target is not a source object");
  }
  target["unrecognizedLegacyField"] = "accounting-marker";
  return result;
};

test("every source object boundary preserves an added field or refuses the complete message", () => {
  const inputs: unknown[] = [
    ...goldenFixtures.map(({ input }) => input),
    ...stagingFixtures,
  ];
  let mutations = 0;
  for (const source of inputs) {
    const baseline = convertLegacyChatContent(source);
    for (const path of objectPaths(source)) {
      const input = injectUnknownField(source, path);
      expect(
        accountLegacyChatContent(input, baseline).unaccountedFields.length,
      ).toBeGreaterThan(0);
      const result = Result.try({
        try: () => convertLegacyChatContent(input),
        catch: (error) => error,
      });
      mutations += 1;
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(LegacyChatContentError);
        if (!(result.error instanceof LegacyChatContentError)) {
          panic("Unknown field refusal did not carry a typed legacy error");
        }
        expect(["invalid-legacy-part", "unaccounted-legacy-field"]).toContain(
          result.error.reason,
        );
        continue;
      }
      expect(JSON.stringify(result.value)).toContain(
        '"unrecognizedLegacyField":"accounting-marker"',
      );
      expect(
        accountLegacyChatContent(input, result.value).unaccountedFields,
      ).toEqual([]);
    }
  }
  expect(mutations).toBeGreaterThan(inputs.length);
});

test("SDK approval fields without a v3 representation refuse with a typed accounting reason", () => {
  for (const field of ["reason", "unrecognizedLegacyField"]) {
    const result = Result.try({
      try: () =>
        convertLegacyChatContent({
          version: 1,
          data: [
            {
              type: "dynamic-tool",
              toolName: "mcp__example__search",
              toolCallId: "call_x",
              state: "approval-responded",
              input: {},
              approval: { id: "approval_x", approved: false, [field]: "x" },
            },
          ],
        }),
      catch: (error) => error,
    });
    if (result.isOk()) {
      panic("Unrepresentable approval field was silently accepted");
    }
    expect(result.error).toBeInstanceOf(LegacyChatContentError);
    expect(result.error).toMatchObject({ reason: "unaccounted-legacy-field" });
  }
});

test("the migration rejects corrupt envelopes and unsupported versions", () => {
  for (const invalid of [
    null,
    [],
    { version: 1 },
    { version: 2, data: null },
  ]) {
    expect(() => convertLegacyChatContent(invalid)).toThrow(
      "Stored legacy chat content has invalid data",
    );
  }
  for (const version of [0, 3, 4, "1", null]) {
    expect(() => convertLegacyChatContent({ version, data: [] })).toThrow(
      "Legacy chat conversion requires version 1 or 2",
    );
  }
  expect(() =>
    convertLegacyChatContent({ version: 2, data: [], metadata: "invalid" }),
  ).toThrow("Stored v2 chat content has invalid metadata");
});

const canonicalToolStates = {
  "approval-requested": true,
  "approval-responded": true,
  "awaiting-input": true,
  complete: true,
  error: true,
  "input-complete": true,
  "input-streaming": true,
} as const satisfies Record<
  Extract<ChatPart, { type: "tool-call" }>["state"],
  true
>;
const canonicalToolStateValues = Object.keys(canonicalToolStates).filter(
  (state): state is Extract<ChatPart, { type: "tool-call" }>["state"] =>
    Object.hasOwn(canonicalToolStates, state),
);
const canonicalArguments = fc.oneof(
  fc.string(),
  fc.string().map((query) => ` \n {"query": ${JSON.stringify(query)} }\t`),
  fc.string().map((query) => `{"query":${JSON.stringify(query)}`),
  fc.constant(String.raw`{ "query": "žaloba\n\"citace\" \u00e9" }`),
);
const canonicalToolPart = fc.record({
  type: fc.constant("tool-call"),
  id: fc.string({ minLength: 1 }),
  name: fc.string({ minLength: 1 }),
  state: fc.constantFrom(...canonicalToolStateValues),
  arguments: canonicalArguments,
});

test("v1 canonical tool-call golden retains its name and exact raw arguments", () => {
  const argumentsText = '{"query":"contract"}';
  const converted = convertLegacyChatContent({
    version: 1,
    data: [
      {
        type: "tool-call",
        id: "call_1",
        name: "search",
        state: "input-complete",
        arguments: argumentsText,
      },
    ],
  });
  expect(
    deepEquals(converted, {
      version: 3,
      data: [
        {
          type: "tool-call",
          id: "call_1",
          name: "search",
          state: "input-complete",
          metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
          input: { status: "raw", rawArguments: argumentsText },
        },
      ],
    }),
  ).toBe(true);
  expect(
    deepEquals(normalizePersistedChatMessageContent(converted).parts, [
      {
        type: "tool-call",
        id: "call_1",
        name: "search",
        state: "input-complete",
        arguments: argumentsText,
        metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
      },
    ]),
  ).toBe(true);
});

test("v2 tool arguments convert only when every number survives parsing exactly", () => {
  const convert = (argumentsText: string) =>
    Result.try({
      try: () =>
        convertLegacyChatContent({
          version: 2,
          data: [
            {
              type: "tool-call",
              id: "call_count",
              name: "list_templates",
              state: "input-complete",
              arguments: argumentsText,
            },
          ],
        }),
      catch: (error) => error,
    });
  for (const exact of [
    '{"count":2e3,"ratio":1.50,"offset":-0}',
    '{"count":9007199254740991}',
  ]) {
    expect(convert(exact).isOk()).toBe(true);
  }
  for (const lossy of [
    '{"count":12345678901234567890}',
    '{"ratio":0.12345678901234567890123}',
    '{"count":1e400}',
  ]) {
    const result = convert(lossy);
    if (result.isOk()) {
      panic(`Lossy arguments converted: ${lossy}`);
    }
    expect(result.error).toBeInstanceOf(LegacyChatContentError);
    expect(result.error).toMatchObject({ reason: LOSSY_JSON_NUMBER });
  }
});

test("v1 canonical tool calls preserve name state and raw argument bytes across reload", () => {
  assertProperty(
    "v1 canonical tool calls preserve name state and raw argument bytes across reload",
    fc.property(canonicalToolPart, (part) => {
      if (!isChatPart(part)) {
        panic("Generated canonical tool call is not a chat part");
      }
      const converted = convertLegacyChatContent({ version: 1, data: [part] });
      const expectedPart = normalizeStoredChatToolExecutor(part);
      if (expectedPart.type !== "tool-call") {
        panic("Normalized expected value is not a tool call");
      }
      expect(
        deepEquals(converted.data, [
          {
            type: "tool-call",
            id: part.id,
            name: part.name,
            state: part.state,
            metadata: expectedPart.metadata,
            input: { status: "raw", rawArguments: part.arguments },
          },
        ]),
      ).toBe(true);
      expect(
        deepEquals(normalizePersistedChatMessageContent(converted).parts, [
          expectedPart,
        ]),
      ).toBe(true);
    }),
  );
});

const malformedCanonicalParts = {
  activity: { type: "activity" },
  audio: { type: "audio" },
  document: { type: "document" },
  image: { type: "image" },
  "structured-output": { type: "structured-output" },
  subagent: { type: "subagent" },
  text: { type: "text", text: 42, content: 42 },
  thinking: { type: "thinking" },
  "tool-call": {
    type: "tool-call",
    id: "call",
    name: "search",
    arguments: "{}",
    state: "input-complete",
    metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "unknown" },
  },
  "tool-result": { type: "tool-result" },
  "ui-resource": { type: "ui-resource" },
  video: { type: "video" },
} as const satisfies Record<ChatPart["type"], unknown>;
const malformedLegacyParts = [
  { type: "unknown-part", data: "preserve-or-fail" },
  { type: "file", mediaType: 42, url: "https://example.invalid/file" },
  {
    type: "file",
    mediaType: "application/pdf",
    url: "https://example.invalid/file",
    filename: 42,
  },
  {
    type: "file",
    mediaType: "application/pdf",
    url: "https://example.invalid/file",
    placeholder: 42,
  },
  { type: "data-stella-anon-restorations", data: null },
  { type: "data-stella-mentions", data: null },
  { type: "data-stella-source-document", data: null },
  { type: "data-stella-anon-restorations", data: { pairs: [{}] } },
  { type: "data-stella-mentions", data: { mentions: [{}] } },
  { type: "data-stella-source-document", data: {} },
  { type: "dynamic-tool", toolName: "search" },
  { type: "tool-search", state: "output-available" },
  {
    type: "tool-search",
    toolCallId: "call",
    state: "unknown-state",
    input: {},
  },
  {
    type: "tool-search",
    toolCallId: "call",
    state: "input-available",
    input: {},
    approval: { id: 42 },
  },
  {
    type: "tool-call",
  },
  {
    type: "tool-call",
    id: "call",
    name: "search",
    arguments: "{}",
    state: "unknown-state",
  },
  {
    type: "tool-call",
    id: "call",
    name: "search",
    arguments: "{}",
    state: "input-complete",
    approval: { id: 42, needsApproval: true },
  },
  ...Object.values(malformedCanonicalParts),
];

type ExpectPartFailureOptions = { version: number; parts: unknown[] };
const expectPartFailure = ({ version, parts }: ExpectPartFailureOptions) => {
  const result = Result.try({
    try: () => convertLegacyChatContent({ version, data: parts }),
    catch: (error) => error,
  });
  if (result.isOk()) {
    panic("Malformed legacy part was silently accepted or dropped");
  }
  expect(result.error).toBeInstanceOf(LegacyChatContentError);
  expect(result.error).toMatchObject({ reason: "invalid-legacy-part" });
};

test("malformed parts of every supported type and unknown types reject the whole message", () => {
  for (const version of [1, 2]) {
    const valid =
      version === 1
        ? { type: "text", text: "retained" }
        : { type: "text", content: "retained" };
    for (const invalid of malformedLegacyParts) {
      expectPartFailure({ version, parts: [valid, invalid, valid] });
    }
  }
});

// The one part that is dropped rather than preserved: a step boundary carries
// no content. A marker carrying anything else is not that shape.
test("v1 step-start markers are dropped and a marker with any other field rejects the message", () => {
  const text = { type: "text", text: "retained" };
  expect(
    deepEquals(
      convertLegacyChatContent({
        version: 1,
        data: [{ type: "step-start" }, text, { type: "step-start" }, text],
      }),
      {
        version: 3,
        data: [
          { type: "text", content: "retained" },
          { type: "text", content: "retained" },
        ],
      },
    ),
  ).toBe(true);
  expectPartFailure({
    version: 1,
    parts: [{ type: "step-start", stepId: "s1" }, text],
  });
});

test("every legacy input part is preserved in order or causes a typed whole-message failure", () => {
  assertProperty(
    "every legacy input part is preserved in order or causes a typed whole-message failure",
    fc.property(
      fc.constantFrom(1, 2),
      fc.array(fc.string(), { maxLength: 12 }),
      fc.array(fc.string(), { maxLength: 12 }),
      fc.option(fc.constantFrom(...malformedLegacyParts), { nil: null }),
      (version, prefix, suffix, invalid) => {
        const textPart = (text: string) =>
          version === 1
            ? { type: "text", text }
            : { type: "text", content: text };
        const parts: unknown[] = prefix.map(textPart);
        if (invalid !== null) {
          parts.push(invalid);
        }
        parts.push(...suffix.map(textPart));
        if (invalid !== null) {
          expectPartFailure({ version, parts });
          return;
        }
        expect(
          deepEquals(convertLegacyChatContent({ version, data: parts }), {
            version: 3,
            data: [...prefix, ...suffix].map((content) => ({
              type: "text",
              content,
            })),
          }),
        ).toBe(true);
      },
    ),
  );
});

test("supported content and promoted metadata are accounted for or reject the whole legacy message", () => {
  const capturedParts: unknown[] = [];
  for (const { input } of goldenFixtures) {
    capturedParts.push(...input.data);
  }
  const restoration = fc.string().map((original) => ({
    type: "data-stella-anon-restorations",
    data: { pairs: [{ placeholder: "[PERSON_1]", original }] },
  }));
  const mentions = fc.string().map((label) => ({
    type: "data-stella-mentions",
    data: { mentions: [{ id: "entity_1", category: "entity", label }] },
  }));
  const sourceDocument = fc.string().map((title) => ({
    type: "data-stella-source-document",
    data: {
      entityId: "entity_1",
      kind: "document",
      mimeType: "application/pdf",
      title,
      workspaceId: "workspace_1",
    },
  }));
  assertProperty(
    "supported content and promoted metadata are accounted for or reject the whole legacy message",
    fc.property(
      fc.array(
        fc.oneof(
          fc.constantFrom(...capturedParts),
          canonicalToolPart,
          restoration,
          mentions,
          sourceDocument,
        ),
        { minLength: 1, maxLength: 16 },
      ),
      (parts) => {
        const converted = Result.try({
          try: () => convertLegacyChatContent({ version: 1, data: parts }),
          catch: (error) => error,
        });
        if (converted.isErr()) {
          expect(converted.error).toBeInstanceOf(LegacyChatContentError);
          expect(converted.error).toMatchObject({
            reason: "invalid-legacy-part",
          });
          return;
        }
        expect(
          accountLegacyChatContent({ version: 1, data: parts }, converted.value)
            .unaccountedFields,
        ).toEqual([]);
        let contentParts = 0;
        const reloaded = normalizePersistedChatMessageContent(
          converted.value,
        ).parts;
        const sourceDocuments: unknown[] = [];
        for (const part of parts) {
          if (!isRecord(part)) {
            panic("Captured supported part is not an object");
          }
          switch (part["type"]) {
            case "data-stella-anon-restorations": {
              const data = part["data"];
              if (!isRecord(data) || !isUnknownArray(data["pairs"])) {
                panic("Captured restoration part lacks pairs");
              }
              expect(converted.value.metadata?.anonRestorations?.pairs).toEqual(
                expect.arrayContaining(data["pairs"]),
              );
              break;
            }
            case "data-stella-mentions": {
              const data = part["data"];
              if (!isRecord(data) || !isUnknownArray(data["mentions"])) {
                panic("Captured mention part lacks mentions");
              }
              expect(converted.value.metadata?.mentions?.mentions).toEqual(
                expect.arrayContaining(data["mentions"]),
              );
              break;
            }
            case "data-stella-source-document":
              sourceDocuments.push(part["data"]);
              break;
            default:
              if (part["type"] === "text") {
                expect(reloaded.at(contentParts)).toMatchObject({
                  type: "text",
                  content: part["text"] ?? part["content"],
                });
              } else if (part["type"] === "reasoning") {
                expect(reloaded.at(contentParts)).toMatchObject({
                  type: "thinking",
                  content: part["text"],
                  providerMetadata: part["providerMetadata"],
                });
              } else if (part["type"] === "tool-call") {
                expect(reloaded.at(contentParts)).toMatchObject({
                  type: "tool-call",
                  id: part["id"],
                  name: part["name"],
                  state: part["state"],
                });
                if (part["input"] === undefined) {
                  expect(reloaded.at(contentParts)).toMatchObject({
                    arguments: part["arguments"],
                  });
                }
              } else if (part["type"] === "tool-result") {
                expect(reloaded.at(contentParts)).toMatchObject({
                  type: "tool-result",
                  toolCallId: part["toolCallId"],
                  state: part["state"],
                });
              } else if (isChatPart(part)) {
                expect(reloaded.at(contentParts)).toMatchObject(part);
              } else if (
                typeof part["type"] === "string" &&
                (part["type"] === "dynamic-tool" ||
                  part["type"].startsWith("tool-"))
              ) {
                const name =
                  part["type"] === "dynamic-tool"
                    ? part["toolName"]
                    : part["type"].slice("tool-".length);
                expect(reloaded.at(contentParts)).toMatchObject({
                  type: "tool-call",
                  id: part["toolCallId"] ?? part["id"],
                  name,
                });
                if (part["state"] === "output-error") {
                  expect(reloaded.at(contentParts)).toMatchObject({
                    state: "error",
                  });
                  const toolCallId = part["toolCallId"];
                  const errorText = part["errorText"];
                  if (
                    typeof toolCallId !== "string" ||
                    typeof errorText !== "string"
                  ) {
                    panic(
                      "Captured error tool part lacks its identity or error",
                    );
                  }
                  expect(reloaded.at(contentParts + 1)).toEqual(
                    errorToolResult(toolCallId, errorText),
                  );
                  contentParts += 2;
                  continue;
                }
                if (name !== "create-document") {
                  if (
                    part["input"] !== undefined &&
                    part["state"] !== "input-streaming"
                  ) {
                    expect(reloaded.at(contentParts)).toMatchObject({
                      input: part["input"],
                    });
                  }
                  if (part["output"] !== undefined) {
                    expect(reloaded.at(contentParts)).toMatchObject({
                      output: part["output"],
                    });
                  }
                }
              }
              contentParts += 1;
          }
        }
        expect(converted.value.data).toHaveLength(contentParts);
        if (sourceDocuments.length > 0) {
          expect(
            deepEquals(
              converted.value.metadata?.sourceDocuments,
              sourceDocuments,
            ),
          ).toBe(true);
        }
      },
    ),
  );
});

test("v1 envelope metadata and conflicting promoted metadata cannot be silently overwritten", () => {
  const invalidEnvelope = Result.try({
    try: () =>
      convertLegacyChatContent({
        version: 1,
        data: [],
        metadata: { retained: "must not disappear" },
      }),
    catch: (error) => error,
  });
  expect(invalidEnvelope.isErr()).toBe(true);
  if (invalidEnvelope.isErr()) {
    expect(invalidEnvelope.error).toBeInstanceOf(LegacyChatContentError);
  }
  const restorations = (original: string) => ({
    type: "data-stella-anon-restorations",
    data: { pairs: [{ placeholder: "[PERSON_1]", original }] },
  });
  const mentions = (label: string) => ({
    type: "data-stella-mentions",
    data: { mentions: [{ id: "entity_1", category: "entity", label }] },
  });
  for (const parts of [
    [restorations("Ada"), restorations("Grace")],
    [mentions("Ada"), mentions("Grace")],
  ]) {
    expectPartFailure({ version: 1, parts });
  }
  expect(
    convertLegacyChatContent({
      version: 1,
      data: [restorations("Ada"), restorations("Ada")],
    }).metadata?.anonRestorations?.pairs,
  ).toEqual([{ placeholder: "[PERSON_1]", original: "Ada" }]);
});

test("v2 metadata envelopes validate nested fields before persistence", () => {
  for (const metadata of [
    [],
    { anonRestorations: { pairs: [{}] } },
    { mentions: { mentions: [{}] } },
    { sourceDocuments: [{}] },
  ]) {
    expect(() =>
      convertLegacyChatContent({ version: 2, data: [], metadata }),
    ).toThrow("Stored v2 chat content has invalid metadata");
  }
});

test("create-document conversion rejects supplied malformed source and route identities", () => {
  const input = { name: "Document", source: "@title Document" };
  const output = {
    success: true,
    fileName: "Document.docx",
    entityRef: "MAT-001/0001.v1",
    matterRef: "MAT-001",
    href: "/workspaces/matter",
    mention: "@Document",
  };
  expectPartFailure({
    version: 1,
    parts: [
      {
        type: "tool-create-document",
        toolCallId: "call",
        state: "input-available",
        input: { name: "Document", source: 12, markdown: "@title Document" },
      },
    ],
  });
  for (const malformedOutput of [
    { ...output, entityId: 12 },
    { ...output, fieldId: 12 },
    { ...output, workspaceId: 12 },
  ]) {
    expectPartFailure({
      version: 1,
      parts: [
        {
          type: "tool-create-document",
          toolCallId: "call",
          state: "output-available",
          input,
          output: malformedOutput,
        },
      ],
    });
  }
});

test("read-only inspection exports conversion outcomes and checked rule counts", () => {
  const converted = inspectLegacyChatContent({
    version: 1,
    data: [
      { type: "step-start" },
      { type: "reasoning", text: "synthetic", state: "done" },
    ],
  });
  expect(converted.outcome).toBe("converted");
  expect(converted.unaccountedFields).toEqual([]);
  expect(converted.counts.dropped["bare-step-start"]).toBe(1);
  expect(converted.counts.mapped["thinking-content"]).toBe(1);
  expect(converted.counts.implied["completed-reasoning-state"]).toBe(1);
  const refused = inspectLegacyChatContent({
    version: 1,
    data: [{ type: "reasoning", text: "synthetic", unknownField: "synthetic" }],
  });
  expect(refused.outcome).toBe("refused");
  if (refused.outcome !== "refused") {
    panic("Inspection accepted an unaccounted field");
  }
  expect(refused.reason).toBe("unaccounted-legacy-field");
  expect(refused.unaccountedFields).toEqual(['$["data"]["0"]["unknownField"]']);
  expect(refused.counts.mapped["thinking-content"]).toBe(1);
});
