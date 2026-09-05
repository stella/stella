import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { CHAT_REF_INPUT_STATE } from "@/api/lib/chat/ref-token";

import {
  CREATE_DOCUMENT_TOOL_NAME,
  CREATE_MATTER_DOCUMENT_TOOL_NAME,
  UPDATE_ENTITY_FIELDS_TOOL_NAME,
} from "../native-chat-tool-names";
import {
  hydrateRegistryToolOutputRefs,
  resolveRegistryToolOutputRefs,
} from "./output-ref-resolution";

const PERSISTED_REF_INPUT_STATE =
  CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_REFS_V2;

describe("registry tool output ref resolution", () => {
  test("resolves declared paths without rewriting opaque sibling fields", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const matterRef = registry.toMatterRef(workspaceId);
    const output = {
      decisionId: matterRef,
      matters: [
        {
          decisionId: matterRef,
          id: matterRef,
          nested: { cursor: matterRef },
        },
      ],
    };

    expect(
      resolveRegistryToolOutputRefs({
        output,
        refRegistry: registry,
        toolName: "list_matters",
      }),
    ).toEqual({
      decisionId: matterRef,
      matters: [
        {
          decisionId: matterRef,
          id: workspaceId,
          nested: { cursor: matterRef },
        },
      ],
    });
  });

  test("leaves unknown tool outputs untouched", () => {
    const registry = createChatRefRegistry();
    const output = {
      id: registry.toMatterRef(toSafeId<"workspace">("workspace-opaque")),
    };

    expect(
      resolveRegistryToolOutputRefs({
        output,
        refRegistry: registry,
        toolName: "third-party-tool",
      }),
    ).toBe(output);
  });

  test("round-trips declared output paths without rewriting siblings", () => {
    const resolvingRegistry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const matterRef = resolvingRegistry.toMatterRef(workspaceId);
    const modelOutput = {
      decisionId: matterRef,
      matters: [{ decisionId: matterRef, id: matterRef }],
    };
    const persistedOutput = resolveRegistryToolOutputRefs({
      output: modelOutput,
      refRegistry: resolvingRegistry,
      toolName: "list_matters",
    });

    const replayRegistry = createChatRefRegistry();
    expect(
      hydrateRegistryToolOutputRefs({
        inputState: PERSISTED_REF_INPUT_STATE,
        output: persistedOutput,
        refRegistry: replayRegistry,
        toolName: "list_matters",
      }),
    ).toEqual({
      decisionId: matterRef,
      matters: [{ decisionId: matterRef, id: "mat_1" }],
    });
  });

  test("hydrates entity outputs from their declared workspace source", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const entityId = toSafeId<"entity">("entity-opaque");

    expect(
      hydrateRegistryToolOutputRefs({
        inputState: PERSISTED_REF_INPUT_STATE,
        output: { entityId, workspaceId },
        refRegistry: registry,
        toolName: "read_content_across_matters",
      }),
    ).toEqual({ entityId: "ent_1", workspaceId: "mat_1" });
  });

  test("hydrates an input-entity output from persisted call context", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const entityId = toSafeId<"entity">("entity-opaque");

    expect(
      hydrateRegistryToolOutputRefs({
        entityContexts: [
          {
            entity: { type: "entity", id: entityId },
            toolCallId: "tool-1",
            workspace: { type: "workspace", id: workspaceId },
          },
        ],
        input: { entity_id: entityId },
        inputState: PERSISTED_REF_INPUT_STATE,
        output: { entityId },
        refRegistry: registry,
        toolName: "read_document",
      }),
    ).toEqual({ entityId: "ent_1" });
  });

  test("round-trips create-document refs without rewriting opaque fields", () => {
    const resolvingRegistry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const entityId = toSafeId<"entity">("entity-opaque");
    const matterRef = resolvingRegistry.toMatterRef(workspaceId);
    const entityRef = resolvingRegistry.toEntityRef({ entityId, workspaceId });
    const modelOutput = {
      decisionId: entityRef,
      entityRef,
      matterRef,
      workspaceId,
    };

    const persistedOutput = resolveRegistryToolOutputRefs({
      output: modelOutput,
      refRegistry: resolvingRegistry,
      toolName: CREATE_DOCUMENT_TOOL_NAME,
    });

    expect(persistedOutput).toEqual({
      decisionId: entityRef,
      entityRef: entityId,
      matterRef: workspaceId,
      workspaceId,
    });
    expect(
      hydrateRegistryToolOutputRefs({
        inputState: PERSISTED_REF_INPUT_STATE,
        output: persistedOutput,
        refRegistry: createChatRefRegistry(),
        toolName: CREATE_DOCUMENT_TOOL_NAME,
      }),
    ).toEqual(modelOutput);
  });

  test("round-trips create-workspace-document refs", () => {
    const resolvingRegistry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const entityId = toSafeId<"entity">("entity-opaque");
    const matterRef = resolvingRegistry.toMatterRef(workspaceId);
    const entityRef = resolvingRegistry.toEntityRef({ entityId, workspaceId });
    const modelOutput = { entityRef, matterRef };

    const persistedOutput = resolveRegistryToolOutputRefs({
      output: modelOutput,
      refRegistry: resolvingRegistry,
      toolName: CREATE_MATTER_DOCUMENT_TOOL_NAME,
    });

    expect(persistedOutput).toEqual({
      entityRef: entityId,
      matterRef: workspaceId,
    });
    expect(
      hydrateRegistryToolOutputRefs({
        inputState: PERSISTED_REF_INPUT_STATE,
        output: persistedOutput,
        refRegistry: createChatRefRegistry(),
        toolName: CREATE_MATTER_DOCUMENT_TOOL_NAME,
      }),
    ).toEqual(modelOutput);
  });

  test("round-trips entity update output refs from persisted input context", () => {
    const resolvingRegistry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const entityId = toSafeId<"entity">("entity-opaque");
    const propertyId = toSafeId<"property">("property-opaque");
    const entityRef = resolvingRegistry.toEntityRef({ entityId, workspaceId });
    const propertyRef = resolvingRegistry.toPropertyRef(propertyId);
    const persistedOutput = resolveRegistryToolOutputRefs({
      output: { entityRef, propertyRef },
      refRegistry: resolvingRegistry,
      toolName: UPDATE_ENTITY_FIELDS_TOOL_NAME,
    });

    expect(persistedOutput).toEqual({
      entityRef: entityId,
      propertyRef: propertyId,
    });

    expect(
      hydrateRegistryToolOutputRefs({
        entityContexts: [
          {
            entity: { type: "entity", id: entityId },
            toolCallId: "tool-1",
            workspace: { type: "workspace", id: workspaceId },
          },
        ],
        input: { entityRef: entityId },
        inputState: PERSISTED_REF_INPUT_STATE,
        output: persistedOutput,
        refRegistry: createChatRefRegistry(),
        toolName: UPDATE_ENTITY_FIELDS_TOOL_NAME,
      }),
    ).toEqual({ entityRef, propertyRef });
  });
});
