import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { toSafeId } from "@/api/lib/branded-types";

import {
  containsRawUuid,
  dehydrateInputRefs,
  hydrateOutputRefs,
} from "./ref-mediation";

const WS_UUID = "0dc54d0c-10d7-501d-897e-e801dbd0998c";
const ENTITY_UUID = "c09ec856-d945-5ecc-82e3-bb5382165f34";
const LINKED_ENTITY_UUID = "1e7f7f2a-9b2b-4c40-8ab1-2f5b6c7d8e9f";
const PROPERTY_UUID = "37286c24-6145-572e-ad27-15a1d4454d59";
const CONTACT_UUID = "6111c8e9-1404-5b6f-8a9a-0e3a93e8179a";

const EMPTY_DEHYDRATION = {
  args: {},
  resolvedMatterParams: {},
  resolvedEntityParams: {},
  dehydratedEntityRefs: new Map<string, string>(),
};

describe("registry ref mediation", () => {
  test("matter refs round-trip: dehydrate input, hydrate output, no UUID survives", () => {
    const registry = createChatRefRegistry();
    const matterRef = registry.toMatterRef(toSafeId<"workspace">(WS_UUID));
    expect(matterRef).toBe("mat_1");

    const dehydrated = dehydrateInputRefs({
      args: { matter_id: matterRef },
      refRegistry: registry,
      toolName: "list_matters",
    }).unwrap();
    expect(dehydrated.args["matter_id"]).toBe(WS_UUID);
    expect(dehydrated.resolvedMatterParams["matter_id"]).toBe(
      toSafeId<"workspace">(WS_UUID),
    );

    const hydrated = hydrateOutputRefs({
      dehydration: EMPTY_DEHYDRATION,
      output: { matters: [{ id: WS_UUID, name: "Acme" }], nextCursor: null },
      refRegistry: registry,
      toolName: "list_matters",
    });
    expect(hydrated).toEqual({
      matters: [{ id: matterRef, name: "Acme" }],
      nextCursor: null,
    });
    expect(containsRawUuid(hydrated)).toBe(false);
  });

  test("entity refs round-trip via a sibling workspace id", () => {
    const registry = createChatRefRegistry();

    const hydrated = hydrateOutputRefs({
      dehydration: EMPTY_DEHYDRATION,
      output: {
        hits: [{ entityId: ENTITY_UUID, workspaceId: WS_UUID, name: "Brief" }],
      },
      refRegistry: registry,
      toolName: "search_across_matters",
    });
    // The entity ref is minted from (entityId, sibling workspaceId); the
    // workspace id itself becomes a matter ref. Neither UUID survives.
    expect(hydrated).toEqual({
      hits: [{ entityId: "ent_1", workspaceId: "mat_1", name: "Brief" }],
    });
    expect(containsRawUuid(hydrated)).toBe(false);

    // Inverse: the same entity ref dehydrates back to its UUID on input.
    const dehydrated = dehydrateInputRefs({
      args: { entity_id: "ent_1" },
      refRegistry: registry,
      toolName: "read_content_across_matters",
    }).unwrap();
    expect(dehydrated.args["entity_id"]).toBe(ENTITY_UUID);
  });

  test("contact refs round-trip: dehydrate input, hydrate output", () => {
    const registry = createChatRefRegistry();
    const contactRef = registry.toContactRef(toSafeId<"contact">(CONTACT_UUID));

    const dehydrated = dehydrateInputRefs({
      args: { contact_id: contactRef },
      refRegistry: registry,
      toolName: "read_contact",
    }).unwrap();
    expect(dehydrated.args["contact_id"]).toBe(CONTACT_UUID);

    const hydrated = hydrateOutputRefs({
      dehydration: EMPTY_DEHYDRATION,
      output: { contactId: CONTACT_UUID, displayName: "Jane" },
      refRegistry: registry,
      toolName: "read_contact",
    });
    expect(hydrated).toEqual({ contactId: contactRef, displayName: "Jane" });
    expect(containsRawUuid(hydrated)).toBe(false);
  });

  test("property refs hydrate and resolve back through the registry", () => {
    const registry = createChatRefRegistry();

    const hydrated = hydrateOutputRefs({
      dehydration: EMPTY_DEHYDRATION,
      output: { properties: [{ id: PROPERTY_UUID, name: "Amount" }] },
      refRegistry: registry,
      toolName: "list_properties",
    });
    expect(hydrated).toEqual({
      properties: [{ id: "prop_1", name: "Amount" }],
    });
    expect(registry.resolvePropertyRefs(["prop_1"]).unwrap()).toEqual([
      toSafeId<"property">(PROPERTY_UUID),
    ]);
  });

  test("an output entity that is the request's own input reuses its ref without a workspace lookup", () => {
    const registry = createChatRefRegistry();
    const entityRef = registry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });

    const dehydrated = dehydrateInputRefs({
      args: { entity_id: entityRef },
      refRegistry: registry,
      toolName: "read_document",
    }).unwrap();
    expect(dehydrated.dehydratedEntityRefs.get(ENTITY_UUID)).toBe(entityRef);

    const hydrated = hydrateOutputRefs({
      dehydration: dehydrated,
      output: {
        entityId: ENTITY_UUID,
        name: "Contract",
        fields: [{ propertyId: PROPERTY_UUID }],
      },
      refRegistry: registry,
      toolName: "read_document",
    });
    expect(hydrated).toEqual({
      entityId: entityRef,
      name: "Contract",
      fields: [{ propertyId: "prop_1" }],
    });
    expect(containsRawUuid(hydrated)).toBe(false);
  });

  test("an entity output ref draws its workspace from the resolved matter input", () => {
    const registry = createChatRefRegistry();
    const matterRef = registry.toMatterRef(toSafeId<"workspace">(WS_UUID));

    const dehydrated = dehydrateInputRefs({
      args: { matter_id: matterRef },
      refRegistry: registry,
      toolName: "list_documents",
    }).unwrap();

    const hydrated = hydrateOutputRefs({
      dehydration: dehydrated,
      output: {
        documents: [{ id: ENTITY_UUID, parentId: null, name: "Draft" }],
        nextCursor: null,
      },
      refRegistry: registry,
      toolName: "list_documents",
    });
    expect(hydrated).toEqual({
      documents: [{ id: "ent_1", parentId: null, name: "Draft" }],
      nextCursor: null,
    });
    expect(containsRawUuid(hydrated)).toBe(false);
  });

  test("list_tasks: a linked entity ref draws its workspace from the task_id input, not the reuse map", () => {
    const registry = createChatRefRegistry();
    const taskRef = registry.toEntityRef({
      entityId: toSafeId<"entity">(ENTITY_UUID),
      workspaceId: toSafeId<"workspace">(WS_UUID),
    });

    const dehydrated = dehydrateInputRefs({
      args: { task_id: taskRef },
      refRegistry: registry,
      toolName: "list_tasks",
    }).unwrap();
    expect(dehydrated.args["task_id"]).toBe(ENTITY_UUID);
    expect(dehydrated.resolvedEntityParams["task_id"]).toBe(
      toSafeId<"workspace">(WS_UUID),
    );

    const hydrated = hydrateOutputRefs({
      dehydration: dehydrated,
      output: {
        task: {
          taskId: ENTITY_UUID,
          name: "Draft reply",
          links: [
            {
              linkId: "link-1",
              linkType: "related",
              direction: "outgoing",
              entity: {
                id: LINKED_ENTITY_UUID,
                name: "Exhibit A",
                kind: "document",
              },
            },
          ],
        },
      },
      refRegistry: registry,
      toolName: "list_tasks",
    });

    // The task's own id reuses its input ref; the linked entity (a different
    // uuid) mints a new ref scoped to the same workspace, not the task's own
    // ref and not an un-hydrated raw uuid.
    expect(hydrated).toEqual({
      task: {
        taskId: taskRef,
        name: "Draft reply",
        links: [
          {
            linkId: "link-1",
            linkType: "related",
            direction: "outgoing",
            entity: { id: "ent_2", name: "Exhibit A", kind: "document" },
          },
        ],
      },
    });
    expect(containsRawUuid(hydrated)).toBe(false);
    expect(registry.resolveEntityRefs(["ent_2"]).unwrap()).toEqual([
      toSafeId<"entity">(LINKED_ENTITY_UUID),
    ]);
  });

  test("an unknown ref surfaces the registry's ChatToolError", () => {
    const result = dehydrateInputRefs({
      args: { matter_id: "mat_999" },
      refRegistry: createChatRefRegistry(),
      toolName: "list_matters",
    });
    expect(Result.isError(result)).toBe(true);
  });

  test("containsRawUuid flags an un-hydrated payload", () => {
    expect(containsRawUuid({ id: WS_UUID })).toBe(true);
    expect(containsRawUuid({ id: "mat_1" })).toBe(false);
  });
});
