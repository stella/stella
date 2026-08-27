import {
  resourceRef,
  RESOURCE_TYPE,
  type ResourceRef,
  type ResourceType,
} from "./resource-ref";
import { encodeRfc3986Component } from "./rfc3986";
import { isSafeIdValue, toSafeId } from "./safe-id";

export const CHAT_RESOURCE_HREF_PREFIX = {
  [RESOURCE_TYPE.CASE_LAW_DECISION]: "#stella-decision=",
  [RESOURCE_TYPE.ENTITY]: "#stella-entity=",
  [RESOURCE_TYPE.WORKSPACE]: "#stella-workspace=",
} as const;

type ChatResourceLinkDisposition =
  | {
      type: "supported";
      location: "none" | "workspace";
      mention: "generated_reference" | "selectable";
    }
  | { type: "unsupported" };

/**
 * Total policy for durable resource links and mention rendering in chat.
 * Identity does not imply navigability or mention eligibility; each new
 * resource kind must explicitly choose both behaviors.
 */
export const CHAT_RESOURCE_LINK_DISPOSITION = {
  [RESOURCE_TYPE.AGENT_SKILL]: { type: "unsupported" },
  [RESOURCE_TYPE.AGENT_SKILL_COMMENT]: { type: "unsupported" },
  [RESOURCE_TYPE.AGENT_SKILL_PROPOSAL]: { type: "unsupported" },
  [RESOURCE_TYPE.AGENT_SKILL_RESOURCE]: { type: "unsupported" },
  [RESOURCE_TYPE.AGENT_SKILL_REVISION]: { type: "unsupported" },
  [RESOURCE_TYPE.AI_MEMORY]: { type: "unsupported" },
  [RESOURCE_TYPE.BILLING_CODE]: { type: "unsupported" },
  [RESOURCE_TYPE.CASE_LAW_DECISION]: {
    type: "supported",
    location: "none",
    mention: "generated_reference",
  },
  [RESOURCE_TYPE.CASE_LAW_SOURCE]: { type: "unsupported" },
  [RESOURCE_TYPE.CHAT_MESSAGE]: { type: "unsupported" },
  [RESOURCE_TYPE.CHAT_THREAD]: { type: "unsupported" },
  [RESOURCE_TYPE.CLAUSE]: { type: "unsupported" },
  [RESOURCE_TYPE.CLAUSE_CATEGORY]: { type: "unsupported" },
  [RESOURCE_TYPE.CLAUSE_VARIANT]: { type: "unsupported" },
  [RESOURCE_TYPE.CLAUSE_VERSION]: { type: "unsupported" },
  [RESOURCE_TYPE.CONTACT]: { type: "unsupported" },
  [RESOURCE_TYPE.DOCUMENT_TYPE]: { type: "unsupported" },
  [RESOURCE_TYPE.ENTITY]: {
    type: "supported",
    location: "workspace",
    mention: "selectable",
  },
  [RESOURCE_TYPE.ENTITY_VERSION]: { type: "unsupported" },
  [RESOURCE_TYPE.EXPENSE]: { type: "unsupported" },
  [RESOURCE_TYPE.FIELD]: { type: "unsupported" },
  [RESOURCE_TYPE.FLOW_DEFINITION]: { type: "unsupported" },
  [RESOURCE_TYPE.FLOW_RUN]: { type: "unsupported" },
  [RESOURCE_TYPE.INVOICE]: { type: "unsupported" },
  [RESOURCE_TYPE.LEGAL_LIST]: { type: "unsupported" },
  [RESOURCE_TYPE.LEGISLATION_DOCUMENT]: { type: "unsupported" },
  [RESOURCE_TYPE.LEGISLATION_SOURCE]: { type: "unsupported" },
  [RESOURCE_TYPE.MCP_CONNECTOR]: { type: "unsupported" },
  [RESOURCE_TYPE.ORGANIZATION]: { type: "unsupported" },
  [RESOURCE_TYPE.PLAYBOOK]: { type: "unsupported" },
  [RESOURCE_TYPE.PLAYBOOK_VERSION]: { type: "unsupported" },
  [RESOURCE_TYPE.PROPERTY]: { type: "unsupported" },
  [RESOURCE_TYPE.RATE_ENTRY]: { type: "unsupported" },
  [RESOURCE_TYPE.RATE_TABLE]: { type: "unsupported" },
  [RESOURCE_TYPE.REPORT_EXPORT]: { type: "unsupported" },
  [RESOURCE_TYPE.SAVED_SEARCH]: { type: "unsupported" },
  [RESOURCE_TYPE.STYLE_SET]: { type: "unsupported" },
  [RESOURCE_TYPE.TEMPLATE]: { type: "unsupported" },
  [RESOURCE_TYPE.TEMPLATE_CATEGORY]: { type: "unsupported" },
  [RESOURCE_TYPE.TEMPLATE_VERSION]: { type: "unsupported" },
  [RESOURCE_TYPE.TIME_ENTRY]: { type: "unsupported" },
  [RESOURCE_TYPE.USER]: { type: "unsupported" },
  [RESOURCE_TYPE.USER_FILE]: { type: "unsupported" },
  [RESOURCE_TYPE.WORKSPACE]: {
    type: "supported",
    location: "none",
    mention: "selectable",
  },
  [RESOURCE_TYPE.WORKSPACE_VIEW]: { type: "unsupported" },
  [RESOURCE_TYPE.WORKSPACE_VIEW_TEMPLATE]: { type: "unsupported" },
} as const satisfies Record<ResourceType, ChatResourceLinkDisposition>;

type ChatResourceLinkTargetFor<TType extends ResourceType> =
  (typeof CHAT_RESOURCE_LINK_DISPOSITION)[TType] extends {
    type: "supported";
    location: "workspace";
  }
    ? {
        type: TType;
        resource: ResourceRef<TType>;
        location:
          | {
              type: "workspace";
              workspace: ResourceRef<"workspace">;
            }
          | { type: "render_context" };
      }
    : (typeof CHAT_RESOURCE_LINK_DISPOSITION)[TType] extends {
          type: "supported";
        }
      ? { type: TType; resource: ResourceRef<TType> }
      : never;

export type ChatResourceLinkTarget = {
  [TType in ResourceType]: ChatResourceLinkTargetFor<TType>;
}[ResourceType];

export type ChatResourceHref =
  `${(typeof CHAT_RESOURCE_HREF_PREFIX)[keyof typeof CHAT_RESOURCE_HREF_PREFIX]}${string}`;

type ChatMentionableResourceType = {
  [TType in ResourceType]: (typeof CHAT_RESOURCE_LINK_DISPOSITION)[TType] extends {
    mention: "selectable";
  }
    ? TType
    : never;
}[ResourceType];

export type ChatMentionResourceLinkTarget = Extract<
  ChatResourceLinkTarget,
  { type: ChatMentionableResourceType }
>;

export type ChatMentionResourceHref =
  | `${typeof CHAT_RESOURCE_HREF_PREFIX.entity}${string}`
  | `${typeof CHAT_RESOURCE_HREF_PREFIX.workspace}${string}`;

// Canonical IDs are RFC 3986 components with `.`, `!`, `'`, `(`, `)`, and `*`
// encoded by `encodeChatResourceId`. Keep the scanner ASCII-only so Unicode
// punctuation terminates a bare link instead of becoming part of its ID.
const CANONICAL_COMPONENT = "(?:[A-Za-z0-9_~-]|%[0-9A-Fa-f]{2})+";
const CANONICAL_HREF_BOUNDARY =
  "(?=$|[\\s()!\"',.;?`*>\\[\\]{}]|(?=(?![\\x00-\\x7F])\\p{P}))";
const CHAT_RESOURCE_HREF_CANDIDATE_REGEX = new RegExp(
  `(?:${CHAT_RESOURCE_HREF_PREFIX.entity}${CANONICAL_COMPONENT}(?::${CANONICAL_COMPONENT})?|${CHAT_RESOURCE_HREF_PREFIX.workspace}${CANONICAL_COMPONENT}|${CHAT_RESOURCE_HREF_PREFIX.case_law_decision}${CANONICAL_COMPONENT})${CANONICAL_HREF_BOUNDARY}`,
  "gu",
);

/**
 * A literal dot is legal in an RFC 3986 component, but it is ambiguous at
 * the end of a bare link in prose. Encoding it keeps opaque IDs distinct from
 * sentence punctuation while retaining the existing UUID wire format.
 */
const encodeChatResourceId = (value: string): string =>
  encodeRfc3986Component(value).replaceAll(".", "%2E");

const decodeChatResourceId = (value: string): string | null => {
  try {
    const id = decodeURIComponent(value);
    return isSafeIdValue(id) ? id : null;
  } catch {
    return null;
  }
};

export const toChatMentionResourceHref = (
  target: ChatMentionResourceLinkTarget,
): ChatMentionResourceHref => {
  switch (target.type) {
    case RESOURCE_TYPE.ENTITY: {
      const entityId = encodeChatResourceId(target.resource.id);
      if (target.location.type === "render_context") {
        return `${CHAT_RESOURCE_HREF_PREFIX.entity}${entityId}`;
      }
      const workspaceId = encodeChatResourceId(target.location.workspace.id);
      return `${CHAT_RESOURCE_HREF_PREFIX.entity}${workspaceId}:${entityId}`;
    }
    case RESOURCE_TYPE.WORKSPACE:
      return `${CHAT_RESOURCE_HREF_PREFIX.workspace}${encodeChatResourceId(target.resource.id)}`;
    default:
      return target satisfies never;
  }
};

export const toChatResourceHref = (
  target: ChatResourceLinkTarget,
): ChatResourceHref => {
  switch (target.type) {
    case RESOURCE_TYPE.CASE_LAW_DECISION:
      return `${CHAT_RESOURCE_HREF_PREFIX.case_law_decision}${encodeChatResourceId(target.resource.id)}`;
    case RESOURCE_TYPE.ENTITY:
    case RESOURCE_TYPE.WORKSPACE:
      return toChatMentionResourceHref(target);
    default:
      return target satisfies never;
  }
};

const parseEntityTarget = (value: string): ChatResourceLinkTarget | null => {
  const separatorIndex = value.indexOf(":");
  if (value.length === 0) {
    return null;
  }

  if (separatorIndex === -1) {
    const entityId = decodeChatResourceId(value);
    if (entityId === null) {
      return null;
    }
    return {
      type: RESOURCE_TYPE.ENTITY,
      resource: resourceRef({
        type: RESOURCE_TYPE.ENTITY,
        id: toSafeId<"entity">(entityId),
      }),
      location: { type: "render_context" },
    };
  }

  const workspaceId = decodeChatResourceId(value.slice(0, separatorIndex));
  const entityId = decodeChatResourceId(value.slice(separatorIndex + 1));
  if (workspaceId === null || entityId === null) {
    return null;
  }
  return {
    type: RESOURCE_TYPE.ENTITY,
    resource: resourceRef({
      type: RESOURCE_TYPE.ENTITY,
      id: toSafeId<"entity">(entityId),
    }),
    location: {
      type: "workspace",
      workspace: resourceRef({
        type: RESOURCE_TYPE.WORKSPACE,
        id: toSafeId<"workspace">(workspaceId),
      }),
    },
  };
};

/** Parse persisted chat links into identity plus separate route context. */
export const parseChatResourceHref = (
  href: string,
): ChatResourceLinkTarget | null => {
  if (href.startsWith(CHAT_RESOURCE_HREF_PREFIX.entity)) {
    return parseEntityTarget(
      href.slice(CHAT_RESOURCE_HREF_PREFIX.entity.length),
    );
  }

  if (href.startsWith(CHAT_RESOURCE_HREF_PREFIX.workspace)) {
    const id = decodeChatResourceId(
      href.slice(CHAT_RESOURCE_HREF_PREFIX.workspace.length),
    );
    return id !== null
      ? {
          type: RESOURCE_TYPE.WORKSPACE,
          resource: resourceRef({
            type: RESOURCE_TYPE.WORKSPACE,
            id: toSafeId<"workspace">(id),
          }),
        }
      : null;
  }

  if (href.startsWith(CHAT_RESOURCE_HREF_PREFIX.case_law_decision)) {
    const id = decodeChatResourceId(
      href.slice(CHAT_RESOURCE_HREF_PREFIX.case_law_decision.length),
    );
    return id !== null
      ? {
          type: RESOURCE_TYPE.CASE_LAW_DECISION,
          resource: resourceRef({
            type: RESOURCE_TYPE.CASE_LAW_DECISION,
            id: toSafeId<"caseLawDecision">(id),
          }),
        }
      : null;
  }

  return null;
};

/** Parse only hrefs emitted exactly by the canonical chat-link serializer. */
export const parseCanonicalChatResourceHref = (
  href: string,
): ChatResourceLinkTarget | null => {
  const target = parseChatResourceHref(href);
  if (target === null || toChatResourceHref(target) !== href) {
    return null;
  }

  return target;
};

export type CanonicalChatResourceHrefMatch = {
  readonly href: ChatResourceHref;
  readonly index: number;
  readonly target: ChatResourceLinkTarget;
};

const parseCanonicalChatResourceHrefCandidate = (
  candidate: string,
): Omit<CanonicalChatResourceHrefMatch, "index"> | null => {
  const target = parseCanonicalChatResourceHref(candidate);
  if (target !== null) {
    return { href: toChatResourceHref(target), target };
  }

  return null;
};

/** Find complete canonical hrefs without absorbing adjacent prose punctuation. */
export const findCanonicalChatResourceHrefs = (
  text: string,
): CanonicalChatResourceHrefMatch[] => {
  const matches: CanonicalChatResourceHrefMatch[] = [];

  for (const candidate of text.matchAll(CHAT_RESOURCE_HREF_CANDIDATE_REGEX)) {
    const parsed = parseCanonicalChatResourceHrefCandidate(candidate[0]);
    if (parsed === null) {
      continue;
    }
    matches.push({ ...parsed, index: candidate.index });
  }

  return matches;
};

export const replaceCanonicalChatResourceHrefs = (
  text: string,
  replace: (match: CanonicalChatResourceHrefMatch) => string,
): string => {
  const matches = findCanonicalChatResourceHrefs(text);
  if (matches.length === 0) {
    return text;
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    parts.push(text.slice(cursor, match.index), replace(match));
    cursor = match.index + match.href.length;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
};
