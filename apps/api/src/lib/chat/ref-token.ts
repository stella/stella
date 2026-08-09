import { panic } from "better-result";

import {
  isResourceRef,
  RESOURCE_TYPE,
  type ResourceRef,
} from "@stll/api-contract";

/**
 * Model-facing spellings only. Persisted IDs may have the same text; the
 * protocol stage, not a reserved string namespace, distinguishes them.
 */
export const CHAT_REF_TOKEN_PREFIX = {
  contact: "contact",
  entity: "ent",
  matter: "mat",
  property: "prop",
} as const;

export type ChatRefTokenKind = keyof typeof CHAT_REF_TOKEN_PREFIX;

export const CHAT_REF_ENCODING = {
  PERSISTED_RESOURCE_IDS_V1: "persisted-resource-ids-v1",
  PERSISTED_RESOURCE_REFS_V2: "persisted-resource-refs-v2",
} as const;

export type ChatRefEncoding =
  (typeof CHAT_REF_ENCODING)[keyof typeof CHAT_REF_ENCODING];

/** Runtime guard for persisted metadata crossing back into chat hydration. */
export const isChatRefEncoding = (value: unknown): value is ChatRefEncoding =>
  typeof value === "string" &&
  Object.values(CHAT_REF_ENCODING).some((encoding) => encoding === value);

export const CHAT_REF_INPUT_STATE = {
  LEGACY_UUID_IDS: "legacy-uuid-ids",
  PERSISTED_RESOURCE_IDS_V1: CHAT_REF_ENCODING.PERSISTED_RESOURCE_IDS_V1,
  PERSISTED_RESOURCE_REFS_V2: CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2,
} as const;

export type ChatRefInputState =
  (typeof CHAT_REF_INPUT_STATE)[keyof typeof CHAT_REF_INPUT_STATE];

const CHAT_REF_INPUT_STATE_BY_ENCODING = {
  [CHAT_REF_ENCODING.PERSISTED_RESOURCE_IDS_V1]:
    CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_IDS_V1,
  [CHAT_REF_ENCODING.PERSISTED_RESOURCE_REFS_V2]:
    CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_REFS_V2,
} as const satisfies Record<ChatRefEncoding, ChatRefInputState>;

export type ChatEntityRefContext = {
  entity: ResourceRef<"entity">;
  toolCallId: string;
  workspace: ResourceRef<"workspace">;
};

export type ChatUnresolvedInputRefContext = {
  kind: ChatRefTokenKind;
  param: string;
  ref: string;
  toolCallId: string;
};

export type ChatRefContext = {
  version: 1;
  entities: ChatEntityRefContext[];
  unresolvedInputs: ChatUnresolvedInputRefContext[];
  workspaceScope: ResourceRef<"workspace">[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isChatEntityRefContext = (
  value: unknown,
): value is ChatEntityRefContext =>
  isRecord(value) &&
  typeof value["toolCallId"] === "string" &&
  isResourceRef(value["entity"]) &&
  value["entity"].type === RESOURCE_TYPE.ENTITY &&
  isResourceRef(value["workspace"]) &&
  value["workspace"].type === RESOURCE_TYPE.WORKSPACE;

const isChatUnresolvedInputRefContext = (
  value: unknown,
): value is ChatUnresolvedInputRefContext =>
  isRecord(value) &&
  typeof value["toolCallId"] === "string" &&
  typeof value["param"] === "string" &&
  typeof value["ref"] === "string" &&
  Object.keys(CHAT_REF_TOKEN_PREFIX).some((kind) => kind === value["kind"]);

export const isChatRefContext = (value: unknown): value is ChatRefContext =>
  isRecord(value) &&
  value["version"] === 1 &&
  Array.isArray(value["entities"]) &&
  value["entities"].every(isChatEntityRefContext) &&
  Array.isArray(value["unresolvedInputs"]) &&
  value["unresolvedInputs"].every(isChatUnresolvedInputRefContext) &&
  Array.isArray(value["workspaceScope"]) &&
  value["workspaceScope"].every(
    (resource) =>
      isResourceRef(resource) && resource.type === RESOURCE_TYPE.WORKSPACE,
  );

/** Classify persisted message metadata before it controls ref hydration. */
export const resolveChatRefInputState = (
  encoding: unknown,
): ChatRefInputState => {
  if (encoding === undefined) {
    return CHAT_REF_INPUT_STATE.LEGACY_UUID_IDS;
  }
  if (!isChatRefEncoding(encoding)) {
    return panic("Unknown persisted chat ref encoding");
  }
  return CHAT_REF_INPUT_STATE_BY_ENCODING[encoding];
};
