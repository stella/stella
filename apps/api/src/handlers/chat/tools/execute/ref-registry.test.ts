import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { toSafeId } from "@/api/lib/branded-types";

import { createChatRefRegistry } from "./ref-registry";

type HydratedEntityValue = {
  contactRef?: string;
  contactRefs?: string[];
  entityRef?: string;
  entityRefs?: string[];
  fields?: { dependsOnPropertyRef: string }[];
  matterRef?: string;
  matterRefs?: string[];
  mention?: string;
  parentRef?: string;
};

describe("chat ref registry", () => {
  test("uses short refs for model-facing entity links and resolves them for persistence", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const secondWorkspaceId = toSafeId<"workspace">(
      "4e919658-a448-5354-8e3a-e99911214d2c",
    );
    const entityId = toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34");
    const secondEntityId = toSafeId<"entity">(
      "e650e388-8d13-59ca-8adb-e81e1916deea",
    );
    const propertyId = toSafeId<"property">(
      "37286c24-6145-572e-ad27-15a1d4454d59",
    );
    const contactId = toSafeId<"contact">(
      "6111c8e9-1404-5b6f-8a9a-0e3a93e8179a",
    );

    const matterRef = registry.toMatterRef(workspaceId);
    const entityRef = registry.toEntityRef({ entityId, workspaceId });
    const propertyRef = registry.toPropertyRef(propertyId);
    const contactRef = registry.toContactRef(contactId);

    expect(matterRef).toBe("mat_1");
    expect(entityRef).toBe("ent_1");
    expect(propertyRef).toBe("prop_1");
    expect(contactRef).toBe("contact_1");
    expect(
      registry.toEntityMention({
        entityId,
        label: "Doc",
        workspaceId,
      }),
    ).toBe("[Doc](#stella-entity-ref=ent_1)");
    expect(
      registry.toMatterMention({
        label: "Matter",
        workspaceId,
      }),
    ).toBe("[Matter](#stella-workspace-ref=mat_1)");
    expect(
      registry.resolveAssistantTextRefs(
        `[Matter](#stella-workspace-ref=${matterRef}) [Doc](#stella-entity-ref=${entityRef})`,
      ),
    ).toBe(
      "[Matter](#stella-workspace=0dc54d0c-10d7-501d-897e-e801dbd0998c) " +
        "[Doc](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34)",
    );
    expect(
      registry.resolveAssistantValueRefs({
        entityRef,
        fields: [{ propertyRef }],
        matterRef,
        contactRef,
        mention: `[Matter](#stella-workspace-ref=${matterRef}) [Doc](#stella-entity-ref=${entityRef})`,
      }),
    ).toEqual({
      entityRef: entityId,
      fields: [{ propertyRef: propertyId }],
      matterRef: workspaceId,
      contactRef: contactId,
      mention:
        "[Matter](#stella-workspace=0dc54d0c-10d7-501d-897e-e801dbd0998c) " +
        "[Doc](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34)",
    });

    const richHydratedInput: HydratedEntityValue = {
      entityRef: entityId,
      fields: [{ dependsOnPropertyRef: propertyId }],
      matterRef: workspaceId,
      contactRef: contactId,
      mention:
        "[Matter](#stella-workspace=0dc54d0c-10d7-501d-897e-e801dbd0998c) " +
        "[Doc](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34)",
      parentRef: entityId,
    };

    expect(registry.hydrateAssistantValueRefs(richHydratedInput)).toEqual({
      entityRef,
      fields: [{ dependsOnPropertyRef: propertyRef }],
      matterRef,
      contactRef,
      mention: `[Matter](#stella-workspace-ref=${matterRef}) [Doc](#stella-entity-ref=${entityRef})`,
      parentRef: entityRef,
    });

    const secondMatterRef = registry.toMatterRef(secondWorkspaceId);
    const secondEntityRef = registry.toEntityRef({
      entityId: secondEntityId,
      workspaceId: secondWorkspaceId,
    });

    const multiEntityInput: HydratedEntityValue = {
      entityRefs: [entityId, secondEntityId],
      matterRefs: [workspaceId, secondWorkspaceId],
    };

    expect(registry.hydrateAssistantValueRefs(multiEntityInput)).toEqual({
      entityRefs: [entityRef, secondEntityRef],
      matterRefs: [matterRef, secondMatterRef],
    });

    const ambiguousEntityInput: HydratedEntityValue = {
      entityRefs: [secondEntityId],
      matterRefs: [workspaceId, secondWorkspaceId],
    };

    expect(registry.hydrateAssistantValueRefs(ambiguousEntityInput)).toEqual({
      entityRefs: [secondEntityRef],
      matterRefs: [matterRef, secondMatterRef],
    });
  });

  test("does not accept raw UUIDs as refs", () => {
    const registry = createChatRefRegistry();

    const result = registry.resolveMatterRefs([
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    ]);

    expect(Result.isError(result)).toBe(true);
  });
});

describe("getRegisteredWorkspaceIds", () => {
  // Folds every workspace a subagent (or the top-level turn) resolved a
  // matter or entity ref for into thread scope (`chat_threads.data_workspace_ids`).
  // Missing a workspace here means a later access revocation leaves that
  // workspace's content readable via the persisted assistant text.

  test("returns an empty array when nothing has been registered", () => {
    const registry = createChatRefRegistry();

    expect(registry.getRegisteredWorkspaceIds()).toEqual([]);
  });

  test("includes every workspace registered via a matter ref", () => {
    const registry = createChatRefRegistry();
    const workspaceA = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const workspaceB = toSafeId<"workspace">(
      "4e919658-a448-5354-8e3a-e99911214d2c",
    );

    registry.toMatterRef(workspaceA);
    registry.toMatterRef(workspaceB);

    expect(new Set(registry.getRegisteredWorkspaceIds())).toEqual(
      new Set([workspaceA, workspaceB]),
    );
  });

  test("folds in a workspace registered only via an entity ref", () => {
    const registry = createChatRefRegistry();
    const workspaceC = toSafeId<"workspace">(
      "c09ec856-d945-5ecc-82e3-bb5382165f34",
    );
    const entityId = toSafeId<"entity">("e650e388-8d13-59ca-8adb-e81e1916deea");

    registry.toEntityRef({ entityId, workspaceId: workspaceC });

    expect(registry.getRegisteredWorkspaceIds()).toEqual([workspaceC]);
  });

  test("dedupes a workspace registered via both a matter ref and an entity ref", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "37286c24-6145-572e-ad27-15a1d4454d59",
    );
    const entityId = toSafeId<"entity">("6111c8e9-1404-5b6f-8a9a-0e3a93e8179a");

    registry.toMatterRef(workspaceId);
    registry.toEntityRef({ entityId, workspaceId });

    expect(registry.getRegisteredWorkspaceIds()).toEqual([workspaceId]);
  });
});
