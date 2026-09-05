import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import {
  CHAT_REF_INPUT_STATE,
  type ChatEntityRefContext,
  type ChatUnresolvedInputRefContext,
} from "@/api/lib/chat/ref-token";

import { UPDATE_ENTITY_FIELDS_TOOL_NAME } from "../native-chat-tool-names";
import {
  hydrateRegistryToolInputRefs,
  resolveRegistryToolInputRefs,
} from "./input-ref-hydration";
import { WRITE_TOOL_REF_FIELD_MAP } from "./ref-field-map";
import { dehydrateRefs } from "./ref-mediation";

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const TASK_UUID = "6d0f4b21-5c7e-4a0e-9f31-1b3a7c2d8e55";
const LEGACY_REF_INPUT_STATE = CHAT_REF_INPUT_STATE.LEGACY_UUID_IDS;
const PERSISTED_REF_INPUT_STATE =
  CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_IDS_V1;

/** The same declaration the hydrator reads, so the round trip below is tied
 *  to `save_task`'s real input-ref contract rather than a restated one. */
const SAVE_TASK_INPUT_REFS = WRITE_TOOL_REF_FIELD_MAP.save_task.inputRefs;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArgs = (value: unknown): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error("hydration must return a tool input record");
  }
  return { ...value };
};

describe("registry tool input ref hydration", () => {
  test("resolves only input parameters declared as refs", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(WS_UUID);
    const matterRef = registry.toMatterRef(workspaceId);
    const input = {
      decisionId: matterRef,
      matter_id: matterRef,
      nested: { title: matterRef },
    };

    expect(
      resolveRegistryToolInputRefs({
        input,
        refRegistry: registry,
        toolName: "save_task",
      }),
    ).toEqual({
      decisionId: matterRef,
      matter_id: workspaceId,
      nested: { title: matterRef },
    });
  });

  test("round-trips the native entity update's declared refs", () => {
    const resolvingRegistry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(WS_UUID);
    const entityId = toSafeId<"entity">(TASK_UUID);
    const propertyId = toSafeId<"property">("property-status");
    const matterRef = resolvingRegistry.toMatterRef(workspaceId);
    const entityRef = resolvingRegistry.toEntityRef({ entityId, workspaceId });
    const propertyRef = resolvingRegistry.toPropertyRef(propertyId);
    const modelInput = {
      matterRef,
      entityRef,
      propertyRef,
      value: { matterRef },
    };

    const persistedInput = resolveRegistryToolInputRefs({
      input: modelInput,
      refRegistry: resolvingRegistry,
      toolName: UPDATE_ENTITY_FIELDS_TOOL_NAME,
    });

    expect(persistedInput).toEqual({
      matterRef: workspaceId,
      entityRef: entityId,
      propertyRef: propertyId,
      value: { matterRef },
    });
    expect(
      hydrateRegistryToolInputRefs({
        input: persistedInput,
        inputState: PERSISTED_REF_INPUT_STATE,
        refRegistry: createChatRefRegistry(),
        toolName: UPDATE_ENTITY_FIELDS_TOOL_NAME,
      }),
    ).toEqual(modelInput);
  });

  /**
   * The invariant the persisted approval flow depends on: a tool call stored
   * with resolved ids, replayed on a later turn, must dehydrate back to exactly
   * those ids. Before hydration ran on ingress, `dehydrateRefs` saw the raw
   * UUID and failed the call with "Unknown matter ref".
   */
  test("round-trips a persisted tool input back to its resolved ids", () => {
    const registry = createChatRefRegistry();
    const persistedInput = {
      matter_id: WS_UUID,
      task_id: TASK_UUID,
      name: "respond to outside counsel",
    };

    const hydrated = hydrateRegistryToolInputRefs({
      input: persistedInput,
      inputState: PERSISTED_REF_INPUT_STATE,
      refRegistry: registry,
      toolName: "save_task",
    });

    // The model-facing call carries refs again, never the tenant ids.
    expect(hydrated).toEqual({
      matter_id: "mat_1",
      task_id: "ent_1",
      name: "respond to outside counsel",
    });

    const dehydrated = dehydrateRefs({
      args: asArgs(hydrated),
      inputRefs: SAVE_TASK_INPUT_REFS,
      refRegistry: registry,
    }).unwrap();

    expect(dehydrated.args).toEqual(persistedInput);
    // The entity ref recovered its workspace from the sibling matter param,
    // so output hydration can mint refs for entities in the same matter.
    expect(dehydrated.resolvedEntityParams["task_id"]).toBe(
      toSafeId<"workspace">(WS_UUID),
    );
  });

  test("reuses the ref a matter already has this turn", () => {
    const registry = createChatRefRegistry();
    const existingRef = registry.toMatterRef(toSafeId<"workspace">(WS_UUID));

    expect(
      hydrateRegistryToolInputRefs({
        input: { matter_id: WS_UUID },
        inputState: PERSISTED_REF_INPUT_STATE,
        refRegistry: registry,
        toolName: "save_task",
      }),
    ).toEqual({ matter_id: existingRef });
  });

  test("leaves a call with no declared input refs untouched", () => {
    const registry = createChatRefRegistry();
    const input = { matter_id: WS_UUID };

    expect(
      hydrateRegistryToolInputRefs({
        input,
        inputState: PERSISTED_REF_INPUT_STATE,
        refRegistry: registry,
        toolName: "spawn-subagents",
      }),
    ).toBe(input);
  });

  test("passes a value that is already a ref through unchanged", () => {
    const registry = createChatRefRegistry();
    const ref = registry.toMatterRef(toSafeId<"workspace">(WS_UUID));

    expect(
      hydrateRegistryToolInputRefs({
        input: { matter_id: ref, name: "draft" },
        inputState: LEGACY_REF_INPUT_STATE,
        refRegistry: registry,
        toolName: "save_task",
      }),
    ).toEqual({ matter_id: ref, name: "draft" });
  });

  test("hydrates a versioned persisted ID that looks like a ref", () => {
    const registry = createChatRefRegistry();
    registry.toMatterRef(toSafeId<"workspace">(WS_UUID));
    const tokenShapedId = toSafeId<"workspace">("mat_1");

    const hydrated = hydrateRegistryToolInputRefs({
      input: { matter_id: tokenShapedId },
      inputState: PERSISTED_REF_INPUT_STATE,
      refRegistry: registry,
      toolName: "save_task",
    });

    expect(hydrated).toEqual({ matter_id: "mat_2" });
    expect(
      dehydrateRefs({
        args: asArgs(hydrated),
        inputRefs: SAVE_TASK_INPUT_REFS,
        refRegistry: registry,
      }).unwrap().args,
    ).toEqual({ matter_id: tokenShapedId });
  });

  test("preserves an unresolved ref as unresolved across v2 replay", () => {
    const unresolvedInputRefs: ChatUnresolvedInputRefContext[] = [];
    const input = { matter_id: "mat_999", name: "draft" };
    const persistedInput = resolveRegistryToolInputRefs({
      input,
      onRefUnresolved: (unresolved) => {
        unresolvedInputRefs.push({
          ...unresolved,
          toolCallId: "tool-1",
        });
      },
      refRegistry: createChatRefRegistry(),
      toolName: "save_task",
    });

    expect(persistedInput).toEqual(input);
    expect(unresolvedInputRefs).toEqual([
      {
        kind: "matter",
        param: "matter_id",
        ref: "mat_999",
        toolCallId: "tool-1",
      },
    ]);

    const hydrated = hydrateRegistryToolInputRefs({
      input: persistedInput,
      inputState: CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_REFS_V2,
      refRegistry: createChatRefRegistry(),
      toolName: "save_task",
      unresolvedInputRefs,
    });

    expect(hydrated).toEqual(input);
    expect(
      Result.isError(
        dehydrateRefs({
          args: asArgs(hydrated),
          inputRefs: SAVE_TASK_INPUT_REFS,
          refRegistry: createChatRefRegistry(),
        }),
      ),
    ).toBe(true);
  });

  test("round-trips an entity-only input with its workspace context", () => {
    const resolvingRegistry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(WS_UUID);
    const entityId = toSafeId<"entity">(TASK_UUID);
    const entityRef = resolvingRegistry.toEntityRef({ entityId, workspaceId });
    const entityContexts: ChatEntityRefContext[] = [];

    expect(
      resolveRegistryToolInputRefs({
        input: { entity_id: entityRef },
        onEntityRefResolved: (target) => {
          entityContexts.push({
            entity: resourceRef({
              type: RESOURCE_TYPE.ENTITY,
              id: target.entityId,
            }),
            toolCallId: "tool-1",
            workspace: resourceRef({
              type: RESOURCE_TYPE.WORKSPACE,
              id: target.workspaceId,
            }),
          });
        },
        refRegistry: resolvingRegistry,
        toolName: "read_document",
      }),
    ).toEqual({ entity_id: entityId });

    expect(
      hydrateRegistryToolInputRefs({
        entityContexts,
        input: { entity_id: entityId },
        inputState: CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_REFS_V2,
        refRegistry: createChatRefRegistry(),
        toolName: "read_document",
      }),
    ).toEqual({ entity_id: "ent_1" });
  });
});
