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
import { normalizeStoredChatToolExecutor } from "@/api/handlers/chat/legacy-tool-compat";
import type { ChatPart } from "@/api/handlers/chat/types";
import { isRecord, isUnknownArray } from "@/api/lib/type-guards";

import goldenFixtures from "./__fixtures__/chat-content-v3-legacy-goldens.json" with { type: "json" };
import {
  convertLegacyChatContent,
  LegacyChatContentError,
} from "./chat-content-v3-legacy";

describe("frozen legacy conversion preserves pre-cutover persisted output", () => {
  test("captured fixtures exercise both retired versions", () => {
    expect(new Set(goldenFixtures.map(({ input }) => input.version))).toEqual(
      new Set([1, 2]),
    );
  });
  for (const { name, input, expected } of goldenFixtures) {
    test(name, () => {
      expect(deepEquals(convertLegacyChatContent(input), expected)).toBe(true);
    });
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
