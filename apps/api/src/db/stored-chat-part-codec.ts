// The one boundary where stored chat message content enters and leaves this
// release. Releases overlap during a deploy, and a stored row outlives the
// release that wrote it, so a row can hold parts this release cannot decode: a
// type, an enum value or a nested shape a newer release introduced. Such a
// part is carried whole as an unsupported-part activity, which every reader
// already handles (server-owned, shown to the page as a neutral row, never to
// the model), and is written back exactly as stored. The column carries an
// unknown type; the stored reader carries every other part it cannot decode.
// Parts are never dropped or reordered, so a path into `data` stays valid.
// A sub-agent part stores each of its child's messages as content of this
// same shape, so every rule here holds inside it too, at every depth.

import type { MessagePart } from "@tanstack/ai-client";

import {
  isUnsupportedChatPart,
  UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
} from "@stll/api-contract/chat";
import type { UnsupportedChatPart } from "@stll/api-contract/chat";
import { isOwnKey } from "@stll/api-contract/own-key";

/** Every part type this release reads back from a stored message. */
export const STORED_CHAT_PART_TYPES = {
  activity: true,
  audio: true,
  document: true,
  image: true,
  "structured-output": true,
  subagent: true,
  text: true,
  thinking: true,
  "tool-call": true,
  "tool-result": true,
  "ui-resource": true,
  video: true,
} as const satisfies Record<MessagePart["type"], true>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReadableStoredPart = (part: unknown): boolean =>
  isRecord(part) &&
  typeof part["type"] === "string" &&
  isOwnKey(STORED_CHAT_PART_TYPES, part["type"]);

/** A stored part carried whole, for this release to write back unread. Only
 *  the stored reader and this codec make one; a streamed one is dropped. */
export const carriedChatPart = (part: unknown): UnsupportedChatPart => ({
  type: "activity",
  activityType: UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
  content: { part },
});

const sameItems = (left: readonly unknown[], right: readonly unknown[]) =>
  left.every((item, index) => item === right.at(index));

/** A stored sub-agent part with `map` applied to the content of each of its
 *  child's messages, or `part` itself when none changes. */
const mapChildContents = (
  part: unknown,
  map: (content: unknown) => unknown,
): unknown => {
  if (
    !isRecord(part) ||
    part["type"] !== "subagent" ||
    !isRecord(part["subagent"])
  ) {
    return part;
  }
  const subagent = part["subagent"];
  const stored: unknown = subagent["messages"];
  if (!Array.isArray(stored)) {
    return part;
  }
  const messages: readonly unknown[] = stored;
  const mapped = messages.map((message) => {
    if (!isRecord(message)) {
      return message;
    }
    const content = map(message["content"]);
    return content === message["content"] ? message : { ...message, content };
  });
  return sameItems(mapped, messages)
    ? part
    : { ...part, subagent: { ...subagent, messages: mapped } };
};

/** `data` with `map` applied to each part, at every depth, or `content`
 *  itself when no part changes, so a row without such parts passes through
 *  untouched. */
const mapParts = (
  content: unknown,
  map: (part: unknown) => unknown,
): unknown => {
  if (!isRecord(content) || !Array.isArray(content["data"])) {
    return content;
  }
  const data: unknown[] = content["data"];
  // `map` first: writing back unwraps a carried sub-agent part, whose child
  // content then still holds carried parts of its own.
  const mapped = data.map((part) =>
    mapChildContents(map(part), (child) => mapParts(child, map)),
  );
  return sameItems(mapped, data) ? content : { ...content, data: mapped };
};

/** Stored content as this release reads it: a part of a type it cannot read
 *  is carried whole. */
export const decodeStoredChatContent = (stored: unknown): unknown =>
  mapParts(stored, (part) =>
    isReadableStoredPart(part) ? part : carriedChatPart(part),
  );

/** Content as it is stored: a carried part is written back as it was read. */
export const encodeStoredChatContent = (content: unknown): unknown =>
  mapParts(content, (part) =>
    isUnsupportedChatPart(part) ? part.content.part : part,
  );
