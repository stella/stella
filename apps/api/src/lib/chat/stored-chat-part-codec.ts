// The one boundary where stored chat message content enters and leaves this
// release. Releases overlap during a deploy, and a stored row outlives the
// release that wrote it, so a row can hold a part type this release has never
// seen. Such a part is carried whole as an unsupported-part activity, which
// every reader already handles (server-owned, shown to the page, never to the
// model), and is written back exactly as it was stored. Parts are never
// dropped or reordered, so a path into `data` stays valid across the codec.

import {
  isUnsupportedChatPart,
  UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
} from "@stll/api-contract/chat";
import type { UnsupportedChatPart } from "@stll/api-contract/chat";
import { isOwnKey } from "@stll/api-contract/own-key";

import type { PersistableChatPartType } from "@/api/handlers/chat/types";

/** Every part type this release reads back from a stored message. */
export const STORED_CHAT_PART_TYPES = {
  activity: true,
  audio: true,
  document: true,
  image: true,
  "structured-output": true,
  text: true,
  thinking: true,
  "tool-call": true,
  "tool-result": true,
  "ui-resource": true,
  video: true,
} as const satisfies Record<Exclude<PersistableChatPartType, "subagent">, true>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isReadableStoredPart = (part: unknown): boolean =>
  isRecord(part) &&
  typeof part["type"] === "string" &&
  isOwnKey(STORED_CHAT_PART_TYPES, part["type"]);

const carried = (part: unknown): UnsupportedChatPart => ({
  type: "activity",
  activityType: UNSUPPORTED_CHAT_PART_ACTIVITY_TYPE,
  content: { part },
});

/** `data` with `map` applied to each part, or `content` itself when no part
 *  changes, so a row without such parts passes through untouched. */
const mapParts = (
  content: unknown,
  map: (part: unknown) => unknown,
): unknown => {
  if (!isRecord(content) || !Array.isArray(content["data"])) {
    return content;
  }
  const data: unknown[] = content["data"];
  const mapped = data.map(map);
  return mapped.every((part, index) => part === data.at(index))
    ? content
    : { ...content, data: mapped };
};

/** A stored part as this release reads it: itself, or carried whole when
 *  this release cannot read its type. */
export const readableStoredChatPart = <TPart>(
  part: TPart,
): TPart | UnsupportedChatPart =>
  isReadableStoredPart(part) ? part : carried(part);

/** Stored content as this release reads it: a part it cannot read is
 *  carried whole. */
export const decodeStoredChatContent = (stored: unknown): unknown =>
  mapParts(stored, readableStoredChatPart);

/** Content as it is stored: a carried part is written back as it was read.
 *  A carried part holding one this release can read stays carried, so the
 *  codec never turns an activity into a readable part. */
export const encodeStoredChatContent = (content: unknown): unknown =>
  mapParts(content, (part) =>
    isUnsupportedChatPart(part) && !isReadableStoredPart(part.content.part)
      ? part.content.part
      : part,
  );
