import { CHAT_CORPUS_HREF_PREFIX } from "./chat-corpus-scope";
import {
  CHAT_CONNECTOR_HREF_PREFIX,
  CHAT_REGISTRY_HREF_PREFIX,
} from "./chat-source-scope";
import { CHAT_RESOURCE_HREF_PREFIX } from "./resource-link";

export const CHAT_MENTION_CATEGORIES = ["entity", "workspace"] as const;

export type ChatMentionCategory = (typeof CHAT_MENTION_CATEGORIES)[number];

export type ChatMentionHrefPrefix = `#stella-${ChatMentionCategory}=`;

export type ChatMentionHref = `${ChatMentionHrefPrefix}${string}`;

export type ChatMentionHrefPrefixMap = {
  [TCategory in ChatMentionCategory]: `#stella-${TCategory}=`;
};

export const CHAT_REFERENCE_CATEGORIES = [
  ...CHAT_MENTION_CATEGORIES,
  "decision",
  "corpus",
  "registry",
  "connector",
] as const;

export type ChatReferenceCategory = (typeof CHAT_REFERENCE_CATEGORIES)[number];

type ChatReferenceHrefPrefixMap = {
  [TCategory in ChatReferenceCategory]: `#stella-${TCategory}=`;
};

export const CHAT_REFERENCE_HREF_PREFIXES = {
  entity: CHAT_RESOURCE_HREF_PREFIX.entity,
  workspace: CHAT_RESOURCE_HREF_PREFIX.workspace,
  decision: CHAT_RESOURCE_HREF_PREFIX.case_law_decision,
  // A public corpus scope chip ("@Case law · Czechia"): no resource row, so
  // its id is the scope itself (`formatChatCorpusId`).
  corpus: CHAT_CORPUS_HREF_PREFIX,
  // A business registry or MCP connector chip: its id is the source's slug.
  registry: CHAT_REGISTRY_HREF_PREFIX,
  connector: CHAT_CONNECTOR_HREF_PREFIX,
} as const satisfies ChatReferenceHrefPrefixMap;

export const CHAT_MENTION_HREF_PREFIXES = {
  entity: CHAT_REFERENCE_HREF_PREFIXES.entity,
  workspace: CHAT_REFERENCE_HREF_PREFIXES.workspace,
} as const satisfies ChatMentionHrefPrefixMap;

export type ChatReferenceHrefPrefix =
  (typeof CHAT_REFERENCE_HREF_PREFIXES)[ChatReferenceCategory];

export const isChatMentionCategory = (
  value: string,
): value is ChatMentionCategory =>
  CHAT_MENTION_CATEGORIES.some((category) => category === value);

export const isChatReferenceCategory = (
  value: string,
): value is ChatReferenceCategory =>
  CHAT_REFERENCE_CATEGORIES.some((category) => category === value);
