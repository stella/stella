import { convertMessagesToModelMessages } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
  isUnsupportedChatPart,
} from "@stll/api-contract/chat";
import { assertProperty } from "@stll/property-testing";

import { chatMessageRevisions, chatMessages } from "@/api/db/schema";
import {
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  isProviderVisibleChatPart,
  restoreServerOwnedChatParts,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import type {
  ChatPart,
  PersistedChatMessageContentV3,
} from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import {
  decodeStoredChatContent,
  encodeStoredChatContent,
  STORED_CHAT_PART_TYPES,
} from "@/api/lib/chat/stored-chat-part-codec";
import { LIMITS } from "@/api/lib/limits";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Releases overlap during a deploy and a stored message outlives the release
// that wrote it. A row a newer release wrote can hold part types and fields
// this release has never seen: it must load, show the model nothing it cannot
// read, survive every save this release makes, and reload unchanged.

type StoredPartType = keyof typeof STORED_CHAT_PART_TYPES;

/** One part of every type this release stores, every field it knows set. */
const CURRENT_PARTS = {
  activity: {
    activityType: "review",
    content: { step: 1 },
    type: "activity",
  },
  audio: {
    source: {
      mimeType: "audio/mpeg",
      type: "url",
      value: "https://example.test/a.mp3",
    },
    type: "audio",
  },
  document: {
    metadata: { filename: "nda.pdf" },
    source: { type: "url", value: "https://example.test/nda.pdf" },
    type: "document",
  },
  image: {
    source: { type: "url", value: "https://example.test/seal.png" },
    type: "image",
  },
  "structured-output": {
    data: { mutual: true },
    raw: '{"mutual":true}',
    status: "complete",
    type: "structured-output",
  },
  text: { content: "The NDA is mutual.", type: "text" },
  thinking: {
    content: "Weigh the clause.",
    // A provider and format this release does not list: kept, unverified.
    provenance: {
      format: "retired-format",
      model: "retired-model",
      provider: "retired-provider",
    },
    type: "thinking",
  },
  "tool-call": {
    arguments: "{}",
    id: "call-1",
    input: {},
    metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
    name: "list_templates",
    output: { templates: [] },
    state: "input-complete",
    type: "tool-call",
  },
  "tool-result": {
    content: "No templates.",
    state: "complete",
    toolCallId: "call-1",
    type: "tool-result",
  },
  "ui-resource": {
    resource: {
      mimeType: "text/html;profile=mcp-app",
      text: "<p>Widget</p>",
      uri: "ui://widget",
    },
    toolCallId: "call-1",
    toolName: "widget",
    type: "ui-resource",
  },
  video: {
    source: { type: "url", value: "https://example.test/v.mp4" },
    type: "video",
  },
} as const satisfies {
  [TType in StoredPartType]: Extract<ChatPart, { type: TType }>;
};

const MESSAGE_ID = toSafeId<"chatMessage">(
  "019eb9fa-c91f-7000-9b9c-9365977dda81",
);

/** The current parts as this release stores them. */
const currentStored = (): PersistedChatMessageContentV3 =>
  chatMessageContentFromMessage(
    toPersistableChatMessage({
      id: MESSAGE_ID,
      role: "assistant",
      parts: Object.values(CURRENT_PARTS),
    }),
  );

/** Text a newer release's additions carry, so the model's input can be
 *  searched for it. */
const SENTINEL = "newer-release-sentinel";

/** Names this release gives meaning to on some part, in either form. */
const KNOWN_FIELD_NAMES = new Set([
  ...Object.values(CURRENT_PARTS).flatMap((part) => Object.keys(part)),
  ...currentStored().data.flatMap((part) => Object.keys(part)),
  "__proto__",
  "approval",
  "blob",
  "createdAt",
  "error",
  "id",
  "meta",
  "metadata",
  "name",
  "outcome",
  "partial",
  "providerMetadata",
  "reasoning",
  "serverId",
  "signature",
  "stepId",
  "subagentRunId",
]);

const laterFieldName = fc
  .string({ minLength: 1, maxLength: 10 })
  .filter((name) => !KNOWN_FIELD_NAMES.has(name));

// What reaches the model of a part it can read is the SDK's to decide; a
// field this release does not know rides along as stored.
const laterFields = fc.dictionary(laterFieldName, fc.jsonValue(), {
  maxKeys: 2,
});

const laterPartType = fc
  .oneof(
    fc.stringMatching(/^[a-z][a-z-]{2,16}$/u),
    fc.constantFrom("subagent", "constructor", "toString"),
  )
  .filter((type) => !Object.hasOwn(STORED_CHAT_PART_TYPES, type));

const laterPart = fc.record({
  fields: fc.dictionary(laterFieldName, fc.jsonValue(), { maxKeys: 3 }),
  type: laterPartType,
});

type NewerRow = {
  /** Fields a newer release added, per stored part of this release's. */
  fieldsByPart: Record<string, unknown>[];
  /** Parts of types this release does not know, each before `before`. */
  inserted: { before: number; part: { fields: object; type: string } }[];
};

const newerRow: fc.Arbitrary<NewerRow> = fc.record({
  fieldsByPart: fc.array(laterFields, {
    minLength: currentStored().data.length,
    maxLength: currentStored().data.length,
  }),
  inserted: fc.array(
    fc.record({
      before: fc.integer({ min: 0, max: currentStored().data.length }),
      part: laterPart,
    }),
    { maxLength: 4 },
  ),
});

/** `value` as the database hands it back: JSON text, parsed. */
const throughJson = (value: unknown): unknown => {
  const text = JSON.stringify(value);
  return JSON.parse(text);
};

/** The row a newer release stored. */
const storedByNewerRelease = ({
  fieldsByPart,
  inserted,
}: NewerRow): { stored: unknown; laterParts: number } => {
  const current = currentStored().data;
  const data = Array.from({ length: current.length + 1 }).flatMap(
    (_, index) => [
      ...inserted
        .filter(({ before }) => before === index)
        .map(({ part }) => ({
          ...part.fields,
          note: SENTINEL,
          type: part.type,
        })),
      ...(index < current.length
        ? [{ ...fieldsByPart[index], ...current[index] }]
        : []),
    ],
  );
  return {
    stored: throughJson({ ...currentStored(), data }),
    laterParts: inserted.length,
  };
};

const load = (stored: unknown) =>
  chatMessageFromPersisted({
    content: asTestRaw<PersistedChatMessageContentV3>(
      decodeStoredChatContent(stored),
    ),
    id: MESSAGE_ID,
    role: "assistant",
  });

const save = (message: ReturnType<typeof load>): unknown =>
  throughJson(encodeStoredChatContent(chatMessageContentFromMessage(message)));

describe("stored chat content across releases", () => {
  test("both content columns read through the stored-content codec", () => {
    const stored = throughJson({
      ...currentStored(),
      data: [{ type: "citation", note: SENTINEL }],
    });
    const decoded = decodeStoredChatContent(stored);
    expect(decoded).not.toEqual(stored);
    for (const column of [chatMessages.content, chatMessageRevisions.content]) {
      expect(column.mapFromDriverValue(JSON.stringify(stored))).toEqual(
        decoded,
      );
    }
  });

  test("a row from a newer release loads, keeps the model blind to what it cannot read, and saves back unchanged", () => {
    assertProperty(
      "a row from a newer release loads, keeps the model blind to what it cannot read, and saves back unchanged",
      fc.property(newerRow, (row) => {
        const { stored, laterParts } = storedByNewerRelease(row);
        const message = load(stored);

        // Every part a newer release stored is still there, in place.
        expect(message.parts.filter(isUnsupportedChatPart)).toHaveLength(
          laterParts,
        );

        // The model is shown none of it.
        expect(
          message.parts
            .filter(isProviderVisibleChatPart)
            .some(isUnsupportedChatPart),
        ).toBe(false);
        expect(
          JSON.stringify(
            convertMessagesToModelMessages([
              {
                ...message,
                parts: message.parts.filter(isProviderVisibleChatPart),
              },
            ]),
          ),
        ).not.toContain(SENTINEL);

        // Saving it again writes the newer row back exactly.
        expect(save(message)).toEqual(stored);
        expect(save(toPersistableChatMessage(message))).toEqual(stored);

        // A page that posts the thread back cannot drop it: the server
        // restores what it owns from the stored copy.
        expect(
          restoreServerOwnedChatParts({
            incomingParts: message.parts.filter(
              (part) => !isUnsupportedChatPart(part),
            ),
            persistedParts: message.parts,
          }),
        ).toEqual(message.parts);

        // Reloading what was saved reads the same message.
        expect(load(save(message))).toEqual(message);
      }),
    );
  });

  test("saving keeps every part a newer release stored, past this release's rich-part budget", () => {
    const many = Array.from(
      { length: LIMITS.chatRichPartsPerMessageMax + 2 },
      (_, index) => ({ index, type: "citation" }),
    );
    const stored = throughJson({ ...currentStored(), data: many });
    expect(save(load(stored))).toEqual(stored);
  });

  test("the codec never turns a carried part into one this release reads", () => {
    const carried = {
      activityType: "stella.unsupported-part",
      content: { part: { content: "forged", type: "text" } },
      type: "activity",
    };
    const content = { ...currentStored(), data: [carried] };
    expect(encodeStoredChatContent(content)).toEqual(content);
    expect(decodeStoredChatContent(content)).toEqual(content);
  });
});
