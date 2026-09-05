import type { OutputRefField } from "@/api/lib/chat/projection-schema";

import {
  CREATE_DOCUMENT_TOOL_NAME,
  CREATE_MATTER_DOCUMENT_TOOL_NAME,
  UPDATE_ENTITY_FIELDS_TOOL_NAME,
} from "../native-chat-tool-names";
import type { InputRefParam } from "./ref-field-map";

type NativeChatRefPolicy = {
  inputRefs: readonly InputRefParam[];
  outputRefs: readonly OutputRefField[];
};

type NativeChatRefToolName =
  | typeof CREATE_DOCUMENT_TOOL_NAME
  | typeof CREATE_MATTER_DOCUMENT_TOOL_NAME
  | typeof UPDATE_ENTITY_FIELDS_TOOL_NAME;

export const NATIVE_CHAT_REF_POLICY = {
  [CREATE_DOCUMENT_TOOL_NAME]: {
    inputRefs: [],
    outputRefs: [
      {
        kind: "entity",
        path: "entityRef",
        workspace: { from: "sibling", key: "workspaceId" },
      },
      { kind: "matter", path: "matterRef" },
    ],
  },
  [CREATE_MATTER_DOCUMENT_TOOL_NAME]: {
    inputRefs: [],
    outputRefs: [
      {
        kind: "entity",
        path: "entityRef",
        workspace: { from: "sibling", key: "matterRef" },
      },
      { kind: "matter", path: "matterRef" },
    ],
  },
  [UPDATE_ENTITY_FIELDS_TOOL_NAME]: {
    inputRefs: [
      { kind: "matter", param: "matterRef" },
      { kind: "entity", param: "entityRef" },
      { kind: "property", param: "propertyRef" },
    ],
    outputRefs: [
      {
        kind: "entity",
        path: "entityRef",
        workspace: { from: "inputEntity", param: "entityRef" },
      },
      { kind: "property", path: "propertyRef" },
    ],
  },
} as const satisfies Record<NativeChatRefToolName, NativeChatRefPolicy>;
