import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";

import { dehydrateInputRefs, dehydrateRefs } from "./ref-mediation";

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const ENTITY_UUID = "c09ec856-d945-5ecc-82e3-bb5382165f34";
const PROPERTY_UUID = "37286c24-6145-572e-ad27-15a1d4454d59";
const CONTACT_UUID = "6111c8e9-1404-5b6f-8a9a-0e3a93e8179a";

describe("registry input ref dehydration", () => {
  test("a matter ref arg dehydrates to its workspace uuid and records it", () => {
    const registry = createChatRefRegistry();
    const matterRef = registry.toMatterRef(toSafeId<"workspace">(WS_UUID));

    const dehydrated = dehydrateInputRefs({
      args: { matter_id: matterRef },
      refRegistry: registry,
      toolName: "list_matters",
    }).unwrap();

    expect(dehydrated.args["matter_id"]).toBe(WS_UUID);
    expect(dehydrated.resolvedMatterParams["matter_id"]).toBe(
      toSafeId<"workspace">(WS_UUID),
    );
  });

  test("an entity ref arg dehydrates, recording its workspace and reuse ref", () => {
    const registry = createChatRefRegistry();
    const entityRef = registry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });

    const dehydrated = dehydrateInputRefs({
      args: { task_id: entityRef },
      refRegistry: registry,
      toolName: "list_tasks",
    }).unwrap();

    expect(dehydrated.args["task_id"]).toBe(ENTITY_UUID);
    // The resolved workspace backs `inputEntityWorkspace` output sources
    // (e.g. a task's linked entities)...
    expect(dehydrated.resolvedEntityParams["task_id"]).toBe(
      toSafeId<"workspace">(WS_UUID),
    );
    // ...and the reuse map lets an output echo of the same entity reuse the
    // ref that was just dehydrated instead of a fresh workspace lookup.
    expect(dehydrated.dehydratedEntityRefs.get(ENTITY_UUID)).toBe(entityRef);
  });

  test("a contact ref arg dehydrates to its contact uuid", () => {
    const registry = createChatRefRegistry();
    const contactRef = registry.toContactRef(toSafeId<"contact">(CONTACT_UUID));

    const dehydrated = dehydrateInputRefs({
      args: { contact_id: contactRef },
      refRegistry: registry,
      toolName: "read_contact",
    }).unwrap();

    expect(dehydrated.args["contact_id"]).toBe(CONTACT_UUID);
  });

  test("a property ref arg dehydrates via the shared write core", () => {
    const registry = createChatRefRegistry();
    const propertyRef = registry.toPropertyRef(
      toSafeId<"property">(PROPERTY_UUID),
    );

    const dehydrated = dehydrateRefs({
      args: { property_id: propertyRef },
      inputRefs: [{ kind: "property", param: "property_id" }],
      refRegistry: registry,
    }).unwrap();

    expect(dehydrated.args["property_id"]).toBe(PROPERTY_UUID);
  });

  test("an absent optional ref param and plain args pass through untouched", () => {
    const dehydrated = dehydrateInputRefs({
      args: { query: "indemnity" },
      refRegistry: createChatRefRegistry(),
      toolName: "list_matters",
    }).unwrap();

    expect(dehydrated.args).toEqual({ query: "indemnity" });
    expect(dehydrated.resolvedMatterParams).toEqual({});
  });

  test("an unknown ref surfaces the registry's ChatToolError", () => {
    const result = dehydrateInputRefs({
      args: { matter_id: "mat_999" },
      refRegistry: createChatRefRegistry(),
      toolName: "list_matters",
    });
    expect(Result.isError(result)).toBe(true);
  });
});
