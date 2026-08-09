import { describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { ChatMessage } from "@/api/handlers/chat/types";
import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";

import { collectMessageExactRefContexts } from "./chat-exact-ref-context";

describe("assistant exact ref context", () => {
  test("persists output-only refs nested in execute-typescript results", () => {
    const refRegistry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const entityId = toSafeId<"entity">("entity-opaque");
    const matterRef = refRegistry.toMatterRef(workspaceId);
    const entityRef = refRegistry.toEntityRef({ entityId, workspaceId });
    const parts = [
      {
        type: "tool-call",
        id: "tool-execute-typescript",
        name: "execute_typescript",
        arguments: JSON.stringify({
          typescriptCode: "return await external_list_matters({});",
        }),
        input: {
          typescriptCode: "return await external_list_matters({});",
        },
        output: {
          success: true,
          result: {
            documents: [{ id: entityRef, name: "Document B" }],
            matters: [{ id: matterRef, name: "Matter B" }],
            label: `Text containing ${matterRef} is not an identity leaf`,
          },
        },
        state: "complete",
      },
    ] satisfies ChatMessage["parts"];

    expect(collectMessageExactRefContexts({ parts, refRegistry })).toEqual([
      {
        kind: "entity",
        ref: entityRef,
        resource: resourceRef({
          type: RESOURCE_TYPE.ENTITY,
          id: entityId,
        }),
        toolCallId: "tool-execute-typescript",
        workspace: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: workspaceId,
        }),
      },
      {
        kind: "matter",
        ref: matterRef,
        resource: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: workspaceId,
        }),
        toolCallId: "tool-execute-typescript",
      },
    ]);
  });
});
