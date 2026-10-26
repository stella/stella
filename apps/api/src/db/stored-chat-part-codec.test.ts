import { convertMessagesToModelMessages, EventType } from "@tanstack/ai";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  CHAT_TOOL_EXECUTOR_METADATA_KEY,
  isUnsupportedChatPart,
  UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
} from "@stll/api-contract/chat";
import { assertProperty } from "@stll/property-testing";

import { chatMessageRevisions, chatMessages } from "@/api/db/schema";
import {
  decodeStoredChatContent,
  encodeStoredChatContent,
  STORED_CHAT_PART_TYPES,
} from "@/api/db/stored-chat-part-codec";
import {
  cancelPendingChatToolCalls,
  chatMessageContentFromMessage,
  chatMessageFromPersisted,
  classifyChatPartForPersistence,
  isProviderVisibleChatPart,
  toPersistableChatMessage,
} from "@/api/handlers/chat/chat-message-parts";
import { settleOpenToolCallsForOutcome } from "@/api/handlers/chat/chat-turn-settlement";
import { clientVisibleStreamChunk } from "@/api/handlers/chat/client-visible-chat-part";
import { assembleMessageMarkdown } from "@/api/handlers/chat/export/export-shared";
import { clientMessageFromPageRow } from "@/api/handlers/chat/message-page";
import { serializeRevisionSnapshot } from "@/api/handlers/chat/messages/revisions/serialize-revision-snapshot";
import type {
  ChatPart,
  PersistedChatMessageContentV3,
} from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { buildWireSnapshot } from "@/api/tests/helpers/chat-fixtures";
import { asTestRaw } from "@/api/tests/helpers/test-tool-set";

// Releases overlap during a deploy and a stored message outlives the release
// that wrote it. A row a newer release wrote can hold part types, enum values
// and fields at any depth this release has never seen: it must load, give the
// model only what this release knows, survive every save this release makes
// byte for byte, and reload unchanged. A part this release edits keeps every
// field the newer release stored in it.

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
    // A model this release does not catalog: kept, unverified for replay.
    provenance: {
      format: "openai-item-id",
      model: "retired-model",
      provider: "openai",
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

type Path = readonly string[];

/** Fields whose value this release keeps whole (free JSON, or a provider's
 *  own record): a newer release's field inside one is content, not an
 *  addition. */
const FREE_FIELDS: Record<StoredPartType, readonly Path[]> = {
  activity: [["content"]],
  audio: [["metadata"]],
  document: [["metadata"]],
  image: [["metadata"]],
  "structured-output": [["data"], ["partial"]],
  text: [["metadata"], ["providerMetadata"]],
  thinking: [["providerMetadata"]],
  "tool-call": [
    ["metadata"],
    ["input", "value"],
    ["output", "value"],
    ["providerMetadata", "call"],
    ["providerMetadata", "result"],
  ],
  "tool-result": [["content", "value"]],
  "ui-resource": [["meta"]],
  video: [["metadata"]],
};

/** Enum values a newer release may introduce, by where they sit. */
const ENUM_FIELDS: Record<StoredPartType, readonly Path[]> = {
  activity: [],
  audio: [["source", "type"]],
  document: [["source", "type"]],
  image: [["source", "type"]],
  "structured-output": [["status"]],
  text: [],
  thinking: [],
  "tool-call": [
    ["state"],
    ["input", "status"],
    ["metadata", CHAT_TOOL_EXECUTOR_METADATA_KEY],
  ],
  "tool-result": [["state"], ["content", "type"]],
  "ui-resource": [["resource", "mimeType"]],
  video: [["source", "type"]],
};

const samePath = (left: Path, right: Path): boolean =>
  left.length === right.length &&
  left.every((segment, index) => segment === right[index]);

/** Names this release gives meaning to on some part, at some depth. */
const KNOWN_FIELD_NAMES = new Set([
  "__proto__",
  "activityType",
  "approval",
  "approved",
  "blob",
  "call",
  "content",
  "createdAt",
  "data",
  "error",
  "errorMessage",
  "format",
  "id",
  "input",
  "meta",
  "metadata",
  "mimeType",
  "model",
  "name",
  "needsApproval",
  "outcome",
  "output",
  "partial",
  "provenance",
  "provider",
  "providerMetadata",
  "raw",
  "rawArguments",
  "reasoning",
  "redacted",
  "resource",
  "result",
  "serverId",
  "signature",
  "source",
  "state",
  "status",
  "stepId",
  "subagentRunId",
  "text",
  "toolCallId",
  "toolName",
  "type",
  "uri",
  "value",
]);

const laterFieldName = fc
  .string({ minLength: 1, maxLength: 10 })
  .filter((name) => !KNOWN_FIELD_NAMES.has(name));

/** Fields a newer release added to one object. */
const laterFields = fc.dictionary(
  laterFieldName,
  fc.oneof(fc.constant(SENTINEL), fc.jsonValue()),
  { maxKeys: 2 },
);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `value` with `additions` added to every object a part type defines, at
 *  every depth, and none inside a field kept whole. */
const withAdditionsAtEveryDepth = (
  value: unknown,
  type: StoredPartType,
  additions: readonly Record<string, unknown>[],
  path: Path = [],
): unknown => {
  if (
    !isPlainObject(value) ||
    FREE_FIELDS[type].some((free) => samePath(free, path))
  ) {
    return value;
  }
  const added = additions.at(path.length % Math.max(additions.length, 1)) ?? {};
  return Object.fromEntries([
    ...Object.entries(added).filter(([field]) => !Object.hasOwn(value, field)),
    ...Object.entries(value).map(([field, inner]) => [
      field,
      withAdditionsAtEveryDepth(inner, type, additions, [...path, field]),
    ]),
  ]);
};

/** `value` with the field at `path` set to a value this release never saw. */
const withLaterEnumValue = (value: unknown, path: Path): unknown => {
  const [field, ...rest] = path;
  if (field === undefined || !isPlainObject(value)) {
    return value;
  }
  if (!Object.hasOwn(value, field)) {
    return value;
  }
  return {
    ...value,
    [field]:
      rest.length === 0
        ? `newer-${field}`
        : withLaterEnumValue(value[field], rest),
  };
};

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

type NewerPart = {
  /** Additions to the part's objects, one set per depth. */
  additions: Record<string, unknown>[];
  /** Which of the part's enum fields holds a newer value, if any. */
  laterEnum: number | null;
};

type NewerRow = {
  /** What a newer release changed, per stored part of this release's. */
  byPart: NewerPart[];
  /** Parts of types this release does not know, each before `before`. */
  inserted: { before: number; part: { fields: object; type: string } }[];
  textContent: string;
};

const newerRow: fc.Arbitrary<NewerRow> = fc.record({
  byPart: fc.array(
    fc.record({
      additions: fc.array(laterFields, { minLength: 1, maxLength: 3 }),
      laterEnum: fc.option(fc.nat({ max: 2 }), { freq: 4 }),
    }),
    {
      minLength: currentStored().data.length,
      maxLength: currentStored().data.length,
    },
  ),
  inserted: fc.array(
    fc.record({
      before: fc.integer({ min: 0, max: currentStored().data.length }),
      part: laterPart,
    }),
    { maxLength: 4 },
  ),
  textContent: fc.constantFrom(
    "",
    " ",
    "\n\t",
    "\u00a0\u2003",
    "The NDA is mutual.",
  ),
});

/** `value` as the database hands it back: JSON text, parsed. */
const throughJson = (value: unknown): unknown => {
  const text = JSON.stringify(value);
  return JSON.parse(text);
};

const isStoredPartType = (type: unknown): type is StoredPartType =>
  typeof type === "string" && Object.hasOwn(STORED_CHAT_PART_TYPES, type);

const typeOf = (part: unknown): StoredPartType => {
  const type: unknown = isPlainObject(part) ? part["type"] : undefined;
  if (!isStoredPartType(type)) {
    throw new TypeError("A fixture part has no stored type");
  }
  return type;
};

/** The row a newer release stored, and how many of its parts this release
 *  cannot decode. */
const storedByNewerRelease = ({
  byPart,
  inserted,
  textContent,
}: NewerRow): { stored: unknown; undecodable: number } => {
  const current = currentStored().data;
  let undecodable = inserted.length;
  const changed = current.map((part, index) => {
    const type = typeOf(part);
    const change = byPart[index];
    const added = withAdditionsAtEveryDepth(
      type === "text" ? { ...part, content: textContent } : part,
      type,
      change?.additions ?? [],
    );
    const enumPath =
      change?.laterEnum === null || change?.laterEnum === undefined
        ? undefined
        : ENUM_FIELDS[type].at(change.laterEnum % ENUM_FIELDS[type].length);
    if (enumPath === undefined || ENUM_FIELDS[type].length === 0) {
      return added;
    }
    undecodable += 1;
    return withLaterEnumValue(added, enumPath);
  });
  const data = Array.from({ length: changed.length + 1 }).flatMap(
    (_, index) => [
      ...inserted
        .filter(({ before }) => before === index)
        .map(({ part }) => ({
          ...part.fields,
          note: SENTINEL,
          type: part.type,
        })),
      ...(index < changed.length ? [changed[index]] : []),
    ],
  );
  return {
    stored: throughJson({ ...currentStored(), data }),
    undecodable,
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

const encode = (message: ReturnType<typeof load>): unknown =>
  throughJson(encodeStoredChatContent(chatMessageContentFromMessage(message)));

/** What the model is given of a message. */
const modelInput = (message: ReturnType<typeof load>): string =>
  JSON.stringify(
    convertMessagesToModelMessages([
      { ...message, parts: message.parts.filter(isProviderVisibleChatPart) },
    ]),
  );

/** Every way this release saves a message it loaded without editing it. */
const SAVES = {
  "save as loaded": encode,
  "save after the persistence policy": (message) =>
    encode(toPersistableChatMessage(message)),
  // Fork copies history through the same settlement a superseded turn gets.
  fork: (message) =>
    encode(
      toPersistableChatMessage({
        ...message,
        parts: settleOpenToolCallsForOutcome({
          outcome: "cancelled",
          parts: message.parts,
        }),
      }),
    ),
} as const satisfies Record<
  string,
  (message: ReturnType<typeof load>) => unknown
>;

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

  test("a row from a newer release loads, keeps the model to what this release knows, and every save writes it back unchanged", () => {
    assertProperty(
      "a row from a newer release loads, keeps the model to what this release knows, and every save writes it back unchanged",
      fc.property(newerRow, (row) => {
        const { stored, undecodable } = storedByNewerRelease(row);
        const message = load(stored);

        // Every part this release cannot decode is carried, in place.
        expect(message.parts).toHaveLength(
          asTestRaw<{ data: unknown[] }>(stored).data.length,
        );
        expect(message.parts.filter(isUnsupportedChatPart)).toHaveLength(
          undecodable,
        );

        // The model is given only what this release knows.
        expect(modelInput(message)).not.toContain(SENTINEL);

        const content = asTestRaw<PersistedChatMessageContentV3>(
          decodeStoredChatContent(stored),
        );
        expect(
          JSON.stringify(serializeRevisionSnapshot(content)),
        ).not.toContain(SENTINEL);
        const page = clientMessageFromPageRow(
          {
            content,
            createdAt: new Date("2026-01-01T00:00:00Z"),
            id: MESSAGE_ID,
            role: "assistant",
            revision: 0,
          },
          new Map(),
        );
        expect(JSON.stringify(page)).not.toContain(SENTINEL);

        // Every save writes the newer row back exactly.
        for (const save of Object.values(SAVES)) {
          expect(save(message)).toEqual(stored);
        }

        // Reloading what was saved reads the same message.
        expect(load(encode(message))).toEqual(message);
      }),
    );
  });

  test("blank stored text and unknown parts survive row read and fork without reaching client JSON", () => {
    for (const blank of ["", " ", "\n\t", "\u00a0\u2003"]) {
      const stored = throughJson({
        version: 3,
        data: [
          { type: "text", content: blank, later: SENTINEL },
          { type: "citation", note: SENTINEL },
        ],
      });
      const message = load(stored);
      expect(message.parts).toHaveLength(2);
      expect(encode(message)).toEqual(stored);
      expect(SAVES.fork(message)).toEqual(stored);

      const content = asTestRaw<PersistedChatMessageContentV3>(
        decodeStoredChatContent(stored),
      );
      const page = clientMessageFromPageRow(
        {
          content,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          id: MESSAGE_ID,
          role: "assistant",
          revision: 0,
        },
        new Map(),
      );
      const revision = serializeRevisionSnapshot(content);
      expect(page.parts).toHaveLength(2);
      expect(JSON.stringify(page)).not.toContain(SENTINEL);
      expect(JSON.stringify(revision)).not.toContain(SENTINEL);
      expect(page.parts.at(1)).toEqual({
        type: "activity",
        activityType: UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
        content: {},
      });

      const unsupported = message.parts.at(1);
      if (!isUnsupportedChatPart(unsupported)) {
        throw new Error("Expected the stored unknown part to be carried");
      }
      const sourceSnapshot = buildWireSnapshot(
        [
          {
            id: MESSAGE_ID,
            role: "activity",
            parts: [unsupported],
          },
        ],
        { includeActivity: true },
      );
      expect(JSON.stringify(sourceSnapshot)).toContain(SENTINEL);
      const snapshot = clientVisibleStreamChunk(sourceSnapshot);
      expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
      expect(
        JSON.stringify(
          clientVisibleStreamChunk({
            type: EventType.ACTIVITY_SNAPSHOT,
            messageId: MESSAGE_ID,
            activityType: UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
            content: { part: { note: SENTINEL } },
          }),
        ),
      ).not.toContain(SENTINEL);
      expect(
        JSON.stringify(
          clientVisibleStreamChunk({
            type: EventType.ACTIVITY_DELTA,
            messageId: MESSAGE_ID,
            activityType: UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
            patch: [{ op: "add", path: "/part", value: SENTINEL }],
          }),
        ),
      ).not.toContain(SENTINEL);
      expect(modelInput(message)).not.toContain(SENTINEL);
      expect(assembleMessageMarkdown(message.parts)).toBe("");
    }
  });

  test("new and reordered parts do not take another stored part's future fields", () => {
    const stored = throughJson({
      version: 3,
      data: [
        { type: "text", content: "First", later: "first-future" },
        { type: "text", content: "Second", later: "second-future" },
      ],
    });
    const message = load(stored);
    const [first, second] = message.parts;
    if (!first || !second) {
      throw new TypeError("The fixture has two text parts");
    }
    const changed = encode({
      ...message,
      parts: [second, { type: "text", content: "Fresh" }, first],
    });
    expect(changed).toEqual({
      version: 3,
      data: [
        { type: "text", content: "Second", later: "second-future" },
        { type: "text", content: "Fresh" },
        { type: "text", content: "First", later: "first-future" },
      ],
    });

    const otherId = toSafeId<"chatMessage">(
      "019eb9fa-c91f-7000-9b9c-9365977dda82",
    );
    const other = chatMessageFromPersisted({
      content: asTestRaw<PersistedChatMessageContentV3>(
        decodeStoredChatContent({
          version: 3,
          data: [{ type: "text", content: "Other", later: "other-future" }],
        }),
      ),
      id: otherId,
      role: "assistant",
    });
    const otherPart = other.parts.at(0);
    if (!otherPart) {
      throw new TypeError("The other fixture has one text part");
    }
    expect(
      throughJson(
        encodeStoredChatContent(
          chatMessageContentFromMessage({
            ...message,
            parts: [otherPart, first],
          }),
        ),
      ),
    ).toEqual({
      version: 3,
      data: [
        { type: "text", content: "Other" },
        { type: "text", content: "First", later: "first-future" },
      ],
    });

    const foreignUnknown = chatMessageFromPersisted({
      content: asTestRaw<PersistedChatMessageContentV3>(
        decodeStoredChatContent({
          version: 3,
          data: [{ type: "citation", note: "foreign-future" }],
        }),
      ),
      id: otherId,
      role: "assistant",
    }).parts.at(0);
    if (!foreignUnknown) {
      throw new TypeError("The other fixture has one unknown part");
    }
    expect(() =>
      chatMessageContentFromMessage({ ...message, parts: [foreignUnknown] }),
    ).toThrow("An unknown stored part has no origin in this message");
  });

  test("an edited part keeps every field a newer release stored in it, at every depth", () => {
    const pending = chatMessageContentFromMessage(
      toPersistableChatMessage({
        id: MESSAGE_ID,
        role: "assistant",
        parts: [
          {
            approval: { id: "approval-1", needsApproval: true },
            arguments: "{}",
            id: "call-pending",
            input: {},
            metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
            name: "list_templates",
            state: "approval-requested",
            type: "tool-call",
          },
        ],
      }),
    );
    const call = pending.data.at(0);
    if (call?.type !== "tool-call") {
      throw new TypeError("The fixture stores one call");
    }
    const stored = throughJson({
      ...pending,
      data: [
        {
          ...call,
          approval: { ...call.approval, later: SENTINEL },
          input: { ...call.input, later: SENTINEL },
          later: SENTINEL,
        },
      ],
    });

    const message = load(stored);
    const edited = cancelPendingChatToolCalls(message);
    // The edit is real: the call this release saves is not the one it read.
    expect(edited.parts).not.toEqual(message.parts);
    expect(modelInput(edited)).not.toContain(SENTINEL);

    const saved = asTestRaw<{ data: Record<string, unknown>[] }>(
      encode(toPersistableChatMessage(edited)),
    ).data.at(0);
    const expectedEdit = asTestRaw<{ data: Record<string, unknown>[] }>(
      throughJson(
        chatMessageContentFromMessage(
          toPersistableChatMessage({
            ...edited,
            parts: edited.parts.map((part) => structuredClone(part)),
          }),
        ),
      ),
    ).data.at(0);
    expect(saved).toMatchObject(expectedEdit ?? {});
    expect(saved).toMatchObject({
      approval: { later: SENTINEL },
      input: { later: SENTINEL },
      later: SENTINEL,
    });
  });

  test("an unedited part is written back as stored, even where this release would encode it otherwise", () => {
    const current = currentStored();
    const call = current.data.find((part) => part.type === "tool-call");
    if (call?.type !== "tool-call") {
      throw new TypeError("The fixture stores a call");
    }
    // Argument text this release drops, since it parses to the stored input.
    const stored = throughJson({
      ...current,
      data: current.data.map((part) =>
        part === call
          ? { ...call, input: { ...call.input, rawArguments: "{ }" } }
          : part,
      ),
    });
    expect(encode(load(stored))).toEqual(stored);
  });

  test("saving keeps every part a newer release stored, past this release's rich-part budget", () => {
    const many = Array.from(
      { length: LIMITS.chatRichPartsPerMessageMax + 2 },
      (_, index) => ({ index, type: "citation" }),
    );
    const stored = throughJson({ ...currentStored(), data: many });
    expect(encode(load(stored))).toEqual(stored);
  });

  test("a streamed part never poses as a carried one", () => {
    const posing = {
      activityType: UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
      content: { part: { content: "forged", type: "text" } },
      type: "activity",
    };
    expect(classifyChatPartForPersistence(posing)).toEqual({
      type: "drop",
      partType: "activity",
    });
  });

  test("an export reads what this release knows and leaves out what it carries", () => {
    // By design: an export renders the text a reader can read; a carried
    // part has none this release can show, so it is left out, never guessed.
    const stored = throughJson({
      ...currentStored(),
      data: [
        { content: "The NDA is mutual.", later: SENTINEL, type: "text" },
        { note: SENTINEL, type: "citation" },
      ],
    });
    const exported = assembleMessageMarkdown(load(stored).parts);
    expect(exported).toBe("The NDA is mutual.");
  });
});
