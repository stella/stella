import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";

import { hydrateRegistryToolInputRefs } from "./input-ref-hydration";
import { WRITE_TOOL_REF_FIELD_MAP } from "./ref-field-map";
import { dehydrateRefs } from "./ref-mediation";

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const TASK_UUID = "6d0f4b21-5c7e-4a0e-9f31-1b3a7c2d8e55";

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
        refRegistry: registry,
        toolName: "save_task",
      }),
    ).toEqual({ matter_id: existingRef });
  });

  test("leaves a call with no declared input refs untouched", () => {
    const registry = createChatRefRegistry();
    const input = { workspace_id: WS_UUID };

    expect(
      hydrateRegistryToolInputRefs({
        input,
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
        refRegistry: registry,
        toolName: "save_task",
      }),
    ).toEqual({ matter_id: ref, name: "draft" });
  });
});
