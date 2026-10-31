import { panic } from "better-result";

import { isBusinessRegistrySlug } from "./business-registries";
import type { BusinessRegistrySlug } from "./business-registries";
import {
  CHAT_CORPUS_HREF_PREFIX,
  formatChatCorpusId,
  parseChatCorpusId,
} from "./chat-corpus-scope";
import type { ChatCorpusScope } from "./chat-corpus-scope";

/**
 * A source the reader puts in front of a chat turn as a chip: a public corpus
 * ("@Case law · Czechia"), a business registry ("@ARES") or one of their MCP
 * connectors. A turn that carries any source chip reads only the sources its
 * chips name; the server enforces it, the prompt does not. None of them is a
 * resource row, so a chip's id is the source itself.
 */
export const CHAT_SOURCE_SCOPE_KINDS = [
  "corpus",
  "registry",
  "connector",
] as const;

export type ChatSourceScopeKind = (typeof CHAT_SOURCE_SCOPE_KINDS)[number];

export type ChatSourceScope =
  | ({ kind: "corpus" } & ChatCorpusScope)
  | { kind: "registry"; registry: BusinessRegistrySlug }
  | { kind: "connector"; connector: string };

export const isChatSourceScopeKind = (
  value: string,
): value is ChatSourceScopeKind =>
  CHAT_SOURCE_SCOPE_KINDS.some((kind) => kind === value);

/** The link a registry chip persists as: `#stella-registry=ares`. */
export const CHAT_REGISTRY_HREF_PREFIX = "#stella-registry=";

/** The link a connector chip persists as: `#stella-connector=<slug>`. */
export const CHAT_CONNECTOR_HREF_PREFIX = "#stella-connector=";

const CHAT_SOURCE_HREF_PREFIXES = {
  corpus: CHAT_CORPUS_HREF_PREFIX,
  registry: CHAT_REGISTRY_HREF_PREFIX,
  connector: CHAT_CONNECTOR_HREF_PREFIX,
} as const satisfies Record<ChatSourceScopeKind, `#stella-${string}=`>;

/**
 * A connector slug as the server mints it (lower-case letters, digits, `-`
 * and `_`, at most 80 characters). Anything else names no connector.
 */
const CONNECTOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,79}$/u;

export const isChatConnectorSlug = (value: string): boolean =>
  CONNECTOR_SLUG_PATTERN.test(value);

/** The chip's id within its kind: `case_law:CZE`, `ares`, a connector slug. */
export const formatChatSourceScopeId = (scope: ChatSourceScope): string => {
  switch (scope.kind) {
    case "corpus":
      return formatChatCorpusId(scope);
    case "registry":
      return scope.registry;
    case "connector":
      return scope.connector;
    default:
      scope satisfies never;
      return panic(`Unhandled source scope kind: ${String(scope)}`);
  }
};

/** One key per source across kinds, for de-duplicating chips. */
export const chatSourceScopeKey = (scope: ChatSourceScope): string =>
  `${scope.kind}/${formatChatSourceScopeId(scope)}`;

/** A chip's kind and id back into its scope, or null for anything else. */
export const parseChatSourceScopeId = (
  kind: ChatSourceScopeKind,
  id: string,
): ChatSourceScope | null => {
  switch (kind) {
    case "corpus": {
      const scope = parseChatCorpusId(id);
      return scope === null ? null : { kind, ...scope };
    }
    case "registry":
      return isBusinessRegistrySlug(id) ? { kind, registry: id } : null;
    case "connector":
      return isChatConnectorSlug(id) ? { kind, connector: id } : null;
    default:
      kind satisfies never;
      return panic(`Unhandled source scope kind: ${String(kind)}`);
  }
};

export const toChatSourceScopeHref = (scope: ChatSourceScope): string =>
  `${CHAT_SOURCE_HREF_PREFIXES[scope.kind]}${formatChatSourceScopeId(scope)}`;

/** The kind whose link prefix an href carries, if any. */
export const chatSourceScopeKindOfHref = (
  href: string,
): ChatSourceScopeKind | null =>
  CHAT_SOURCE_SCOPE_KINDS.find((kind) =>
    href.startsWith(CHAT_SOURCE_HREF_PREFIXES[kind]),
  ) ?? null;

/** A persisted source link back into its scope; null for any other href. */
export const parseChatSourceScopeHref = (
  href: string,
): ChatSourceScope | null => {
  const kind = chatSourceScopeKindOfHref(href);
  return kind === null
    ? null
    : parseChatSourceScopeId(
        kind,
        href.slice(CHAT_SOURCE_HREF_PREFIXES[kind].length),
      );
};
