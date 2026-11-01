import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { CHAT_TOOL_EXECUTOR_METADATA_KEY } from "@stll/api-contract/chat";
import { assertProperty } from "@stll/property-testing";

import {
  isChatPart,
  normalizePersistedChatMessageContent,
  toPersistedChatMessageContentV3,
} from "@/api/handlers/chat/chat-message-parts";
import type { ChatPart } from "@/api/handlers/chat/types";

// A stored chat message outlives the release that wrote it. A part written
// before a release added an optional field lacks that field, and the release
// reading it must load it as written: every optional field the store keeps is
// optional on read as well.

type StoredPartType = Exclude<ChatPart["type"], "subagent">;

type PartAcrossReleases<TType extends StoredPartType> = {
  /** The part with only the fields every release writes. */
  earliest: Extract<ChatPart, { type: TType }>;
  /** The same part with every optional field the store keeps. */
  latest: Extract<ChatPart, { type: TType }>;
};

/** One part of every stored type (the engine never stores `subagent`). */
const PARTS_ACROSS_RELEASES = {
  activity: {
    earliest: {
      activityType: "search",
      content: { query: "mutual NDA" },
      type: "activity",
    },
    latest: {
      activityType: "search",
      content: { query: "mutual NDA" },
      subagentRunId: "subagent-1",
      type: "activity",
    },
  },
  audio: {
    earliest: {
      source: { type: "url", value: "https://example.test/a.mp3" },
      type: "audio",
    },
    latest: {
      source: {
        mimeType: "audio/mpeg",
        type: "url",
        value: "https://example.test/a.mp3",
      },
      type: "audio",
    },
  },
  document: {
    earliest: {
      source: { type: "url", value: "https://example.test/nda.pdf" },
      type: "document",
    },
    latest: {
      id: "document-1",
      metadata: { filename: "nda.pdf" },
      source: { type: "url", value: "https://example.test/nda.pdf" },
      type: "document",
    },
  },
  image: {
    earliest: {
      source: { type: "url", value: "https://example.test/seal.png" },
      type: "image",
    },
    latest: {
      id: "image-1",
      metadata: { filename: "seal.png" },
      source: { type: "url", value: "https://example.test/seal.png" },
      type: "image",
    },
  },
  "structured-output": {
    earliest: {
      data: { mutual: true },
      raw: '{"mutual":true}',
      status: "complete",
      type: "structured-output",
    },
    latest: {
      data: { mutual: true },
      raw: '{"mutual":true}',
      reasoning: "Both parties disclose.",
      status: "complete",
      type: "structured-output",
    },
  },
  text: {
    earliest: { content: "The NDA is mutual.", type: "text" },
    latest: {
      content: "The NDA is mutual.",
      providerMetadata: { cacheHit: true },
      type: "text",
    },
  },
  thinking: {
    earliest: { content: "Weigh the clause.", type: "thinking" },
    latest: {
      content: "Weigh the clause.",
      provenance: {
        format: "anthropic-thinking-signature",
        model: "reasoning-model",
        provider: "anthropic",
      },
      providerMetadata: { budget: 1024 },
      signature: "signature-1",
      stepId: "step-1",
      type: "thinking",
    },
  },
  "tool-call": {
    earliest: {
      arguments: "{}",
      id: "call-1",
      input: {},
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
      name: "list_templates",
      state: "input-complete",
      type: "tool-call",
    },
    latest: {
      approval: { approved: true, id: "approval-1", needsApproval: true },
      arguments: "{}",
      id: "call-1",
      input: {},
      metadata: { [CHAT_TOOL_EXECUTOR_METADATA_KEY]: "server" },
      name: "list_templates",
      output: { templates: [] },
      providerMetadata: { call: { cached: false } },
      state: "input-complete",
      type: "tool-call",
    },
  },
  "ui-resource": {
    earliest: {
      resource: {
        mimeType: "text/html;profile=mcp-app",
        text: "<p>Widget</p>",
        uri: "ui://widget",
      },
      toolCallId: "call-1",
      toolName: "widget",
      type: "ui-resource",
    },
    latest: {
      meta: { height: 240 },
      resource: {
        mimeType: "text/html;profile=mcp-app",
        text: "<p>Widget</p>",
        uri: "ui://widget",
      },
      serverId: "server-1",
      toolCallId: "call-1",
      toolName: "widget",
      type: "ui-resource",
    },
  },
  video: {
    earliest: {
      source: { type: "url", value: "https://example.test/v.mp4" },
      type: "video",
    },
    latest: {
      source: {
        mimeType: "video/mp4",
        type: "url",
        value: "https://example.test/v.mp4",
      },
      type: "video",
    },
  },
  "tool-result": {
    earliest: {
      content: "No templates.",
      state: "complete",
      toolCallId: "call-0",
      type: "tool-result",
    },
    latest: {
      content: "No templates.",
      error: "Listing was partial.",
      outcome: "cancelled",
      state: "complete",
      toolCallId: "call-0",
      type: "tool-result",
    },
  },
} as const satisfies {
  [TType in StoredPartType]: PartAcrossReleases<TType>;
};

const partsAcrossReleases: readonly PartAcrossReleases<StoredPartType>[] =
  Object.values(PARTS_ACROSS_RELEASES);

const fieldOf = (part: object, key: string): unknown =>
  Object.entries(part).find(([name]) => name === key)?.[1];

/** The fields a part gained, or that gained an optional member, after its
 *  earliest release. */
const laterFields = ({
  earliest,
  latest,
}: PartAcrossReleases<StoredPartType>) =>
  Object.keys(latest).filter(
    (key) =>
      !Object.hasOwn(earliest, key) ||
      JSON.stringify(fieldOf(earliest, key)) !==
        JSON.stringify(fieldOf(latest, key)),
  );

/** The part as written by a release between its earliest and the latest:
 *  the later fields in `kept` as the latest writes them, every other field as
 *  the earliest does. */
const writtenBetween = (
  across: PartAcrossReleases<StoredPartType>,
  kept: ReadonlySet<string>,
): ChatPart => {
  const part: unknown = Object.fromEntries(
    Object.entries(across.latest).flatMap(([key, latest]) => {
      if (kept.has(key)) {
        return [[key, latest]];
      }
      return Object.hasOwn(across.earliest, key)
        ? [[key, fieldOf(across.earliest, key)]]
        : [];
    }),
  );
  if (!isChatPart(part)) {
    throw new TypeError(
      `A ${across.latest.type} part without later fields is not a chat part`,
    );
  }
  return part;
};

const roundTrip = (parts: ChatPart[]) =>
  normalizePersistedChatMessageContent(
    toPersistedChatMessageContentV3({ data: parts }),
  ).parts;

describe("chat message parts stored by earlier releases", () => {
  test("every fixture part gains at least one field after its earliest release", () => {
    for (const across of partsAcrossReleases) {
      expect(laterFields(across).length).toBeGreaterThan(0);
    }
  });

  test("a part with any subset of its later fields loads exactly as it was written", () => {
    const generations = fc.tuple(
      ...partsAcrossReleases.map((across) =>
        fc.subarray(laterFields(across)).map((kept) => new Set(kept)),
      ),
    );
    assertProperty(
      "a part with any subset of its later fields loads exactly as it was written",
      fc.property(generations, (keptByPart) => {
        const written = partsAcrossReleases.map((across, index) =>
          writtenBetween(across, keptByPart[index] ?? new Set()),
        );
        expect(roundTrip(written)).toEqual(written);
      }),
    );
  });
});
