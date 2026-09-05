import { panic } from "better-result";

import { encodeRfc3986Component } from "./rfc3986";
import { isSafeIdValue, toSafeId } from "./safe-id";
import type { SafeId } from "./safe-id";

export const CHAT_SOURCE_CITATION_HREF_PREFIX = "#stella-source=";

type SourceIdentity = {
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  fieldId: SafeId<"field">;
  workspaceId: SafeId<"workspace">;
};

export type ChatSourceCitationTarget =
  | (SourceIdentity & {
      type: "docx-folio";
      blockId: string;
      text: string;
    })
  | (SourceIdentity & {
      type: "pdf-bates";
      bates: string;
      pageNumber: number;
    });

export type ChatSourceCitationHref =
  `${typeof CHAT_SOURCE_CITATION_HREF_PREFIX}${string}`;

const encode = (value: string) => encodeRfc3986Component(value);

export const toChatSourceCitationHref = (
  target: ChatSourceCitationTarget,
): ChatSourceCitationHref => {
  const identity = [
    target.type,
    encode(target.workspaceId),
    encode(target.entityId),
    encode(target.entityVersionId),
    encode(target.fieldId),
  ];

  switch (target.type) {
    case "docx-folio":
      return `${CHAT_SOURCE_CITATION_HREF_PREFIX}${identity.join(":")}:${encode(target.blockId)}:${encode(target.text)}`;
    case "pdf-bates":
      return `${CHAT_SOURCE_CITATION_HREF_PREFIX}${identity.join(":")}:${String(target.pageNumber)}:${encode(target.bates)}`;
    default:
      target satisfies never;
      return panic(`Unhandled target: ${String(target)}`);
  }
};

const decode = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const parseIdentity = (parts: readonly string[]): SourceIdentity | null => {
  const workspaceId = decode(parts[1] ?? "");
  const entityId = decode(parts[2] ?? "");
  const entityVersionId = decode(parts[3] ?? "");
  const fieldId = decode(parts[4] ?? "");
  if (
    workspaceId === null ||
    entityId === null ||
    entityVersionId === null ||
    fieldId === null ||
    !isSafeIdValue(workspaceId) ||
    !isSafeIdValue(entityId) ||
    !isSafeIdValue(entityVersionId) ||
    !isSafeIdValue(fieldId)
  ) {
    return null;
  }

  return {
    workspaceId: toSafeId<"workspace">(workspaceId),
    entityId: toSafeId<"entity">(entityId),
    entityVersionId: toSafeId<"entityVersion">(entityVersionId),
    fieldId: toSafeId<"field">(fieldId),
  };
};

export const parseChatSourceCitationHref = (
  href: string,
): ChatSourceCitationTarget | null => {
  if (!href.startsWith(CHAT_SOURCE_CITATION_HREF_PREFIX)) {
    return null;
  }

  const parts = href.slice(CHAT_SOURCE_CITATION_HREF_PREFIX.length).split(":");
  const identity = parseIdentity(parts);
  if (identity === null) {
    return null;
  }

  const type = parts[0];
  if (type === "docx-folio" && parts.length === 7) {
    const blockId = decode(parts[5] ?? "");
    const text = decode(parts[6] ?? "");
    return blockId === null ||
      blockId.length === 0 ||
      text === null ||
      text.length === 0
      ? null
      : { ...identity, type, blockId, text };
  }

  if (type === "pdf-bates" && parts.length === 7) {
    const pageNumber = Number(parts[5]);
    const bates = decode(parts[6] ?? "");
    return !Number.isInteger(pageNumber) ||
      pageNumber < 1 ||
      bates === null ||
      bates.length === 0
      ? null
      : { ...identity, type, pageNumber, bates };
  }

  return null;
};

export const parseCanonicalChatSourceCitationHref = (
  href: string,
): ChatSourceCitationTarget | null => {
  const target = parseChatSourceCitationHref(href);
  return target !== null && toChatSourceCitationHref(target) === href
    ? target
    : null;
};

const CANONICAL_COMPONENT = "(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+";
const CANONICAL_HREF_BOUNDARY =
  "(?=$|[\\s()!\"',.;?`*>\\[\\]{}]|(?=(?![\\x00-\\x7F])\\p{P}))";
const CHAT_SOURCE_CITATION_CANDIDATE_REGEX = new RegExp(
  `${CHAT_SOURCE_CITATION_HREF_PREFIX}(?:docx-folio:${CANONICAL_COMPONENT}:${CANONICAL_COMPONENT}:${CANONICAL_COMPONENT}:${CANONICAL_COMPONENT}:${CANONICAL_COMPONENT}:${CANONICAL_COMPONENT}|pdf-bates:${CANONICAL_COMPONENT}:${CANONICAL_COMPONENT}:${CANONICAL_COMPONENT}:${CANONICAL_COMPONENT}:[1-9][0-9]*:${CANONICAL_COMPONENT})${CANONICAL_HREF_BOUNDARY}`,
  "gu",
);

export const replaceCanonicalChatSourceCitationHrefs = (
  text: string,
  replace: (target: ChatSourceCitationTarget) => string,
): string =>
  text.replaceAll(CHAT_SOURCE_CITATION_CANDIDATE_REGEX, (candidate) => {
    const target = parseCanonicalChatSourceCitationHref(candidate);
    return target === null ? candidate : replace(target);
  });
