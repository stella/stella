import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  resourceRef,
  RESOURCE_TYPE,
  toChatResourceHref,
} from "@stll/api-contract";
import { propertyConfig } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import {
  CHAT_UNRESOLVED_REF_HREF,
  createChatRefRegistry,
} from "@/api/lib/chat/ref-registry";
import {
  CHAT_REF_INPUT_STATE,
  CHAT_REF_TOKEN_PREFIX,
} from "@/api/lib/chat/ref-token";

const PERSISTED_REF_INPUT_STATE =
  CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_IDS_V1;

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
  test("resolves exact tokens only in declared ref fields", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("workspace-opaque");
    const entityId = toSafeId<"entity">("entity-opaque");
    const propertyId = toSafeId<"property">("property-opaque");
    const contactId = toSafeId<"contact">("contact-opaque");
    const matterRef = registry.toMatterRef(workspaceId);
    const entityRef = registry.toEntityRef({ entityId, workspaceId });
    const propertyRef = registry.toPropertyRef(propertyId);
    const contactRef = registry.toContactRef(contactId);
    const refs = [matterRef, entityRef, propertyRef, contactRef];

    fc.assert(
      fc.property(
        fc.constantFrom(...refs),
        fc.constantFrom(
          "cursor",
          "decisionId",
          "entityId",
          "id",
          "title",
          "workspaceId",
        ),
        (ref, key) => {
          const opaqueValue = { [key]: ref, nested: { [key]: ref } };
          expect(registry.resolveAssistantValueRefs(opaqueValue)).toEqual(
            opaqueValue,
          );
        },
      ),
      propertyConfig(),
    );

    expect(
      registry.resolveAssistantValueRefs({
        contactRef,
        entityRef,
        matterRef,
        propertyRef,
      }),
    ).toEqual({
      contactRef: contactId,
      entityRef: entityId,
      matterRef: workspaceId,
      propertyRef: propertyId,
    });
  });

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

    expect(
      registry.hydrateAssistantValueRefs(
        richHydratedInput,
        PERSISTED_REF_INPUT_STATE,
      ),
    ).toEqual({
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

    expect(
      registry.hydrateAssistantValueRefs(
        multiEntityInput,
        PERSISTED_REF_INPUT_STATE,
      ),
    ).toEqual({
      entityRefs: [entityRef, secondEntityRef],
      matterRefs: [matterRef, secondMatterRef],
    });

    const ambiguousEntityInput: HydratedEntityValue = {
      entityRefs: [secondEntityId],
      matterRefs: [workspaceId, secondWorkspaceId],
    };

    expect(
      registry.hydrateAssistantValueRefs(
        ambiguousEntityInput,
        PERSISTED_REF_INPUT_STATE,
      ),
    ).toEqual({
      entityRefs: [secondEntityRef],
      matterRefs: [matterRef, secondMatterRef],
    });
  });

  test("hydrates opaque persisted IDs in structured values", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("matter:eu");
    const entityId = toSafeId<"entity">("document:42");
    const propertyId = toSafeId<"property">("property:status");
    const contactId = toSafeId<"contact">("contact:client");

    expect(
      registry.hydrateAssistantValueRefs(
        {
          contactRef: contactId,
          entityRef: entityId,
          matterRef: workspaceId,
          propertyRef: propertyId,
        },
        PERSISTED_REF_INPUT_STATE,
      ),
    ).toEqual({
      contactRef: registry.toContactRef(contactId),
      entityRef: registry.toEntityRef({ entityId, workspaceId }),
      matterRef: registry.toMatterRef(workspaceId),
      propertyRef: registry.toPropertyRef(propertyId),
    });
  });

  test("round-trips persisted IDs shaped like this turn's refs", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), (collisionIndex) => {
        const registry = createChatRefRegistry();
        for (let index = 1; index <= collisionIndex; index += 1) {
          const existingWorkspaceId = toSafeId<"workspace">(
            `existing-workspace-${index}`,
          );
          registry.toMatterRef(existingWorkspaceId);
          registry.toEntityRef({
            entityId: toSafeId<"entity">(`existing-entity-${index}`),
            workspaceId: existingWorkspaceId,
          });
          registry.toPropertyRef(
            toSafeId<"property">(`existing-property-${index}`),
          );
          registry.toContactRef(
            toSafeId<"contact">(`existing-contact-${index}`),
          );
        }

        const workspaceId = toSafeId<"workspace">(
          `${CHAT_REF_TOKEN_PREFIX.matter}_${collisionIndex}`,
        );
        const entityId = toSafeId<"entity">(
          `${CHAT_REF_TOKEN_PREFIX.entity}_${collisionIndex}`,
        );
        const propertyId = toSafeId<"property">(
          `${CHAT_REF_TOKEN_PREFIX.property}_${collisionIndex}`,
        );
        const contactId = toSafeId<"contact">(
          `${CHAT_REF_TOKEN_PREFIX.contact}_${collisionIndex}`,
        );

        const hydrated = registry.hydrateAssistantValueRefs(
          {
            contactRef: contactId,
            entityRef: entityId,
            matterRef: workspaceId,
            propertyRef: propertyId,
          },
          PERSISTED_REF_INPUT_STATE,
        );
        const matterRef = registry.toMatterRef(workspaceId);
        const entityRef = registry.toEntityRef({ entityId, workspaceId });
        const propertyRef = registry.toPropertyRef(propertyId);
        const contactRef = registry.toContactRef(contactId);

        expect(hydrated).toEqual({
          contactRef,
          entityRef,
          matterRef,
          propertyRef,
        });
        expect(registry.resolveMatterRefs([matterRef])).toEqual(
          Result.ok([workspaceId]),
        );
        expect(registry.resolveEntityRefTargets([entityRef])).toEqual(
          Result.ok([{ entityId, workspaceId }]),
        );
        expect(registry.resolvePropertyRefs([propertyRef])).toEqual(
          Result.ok([propertyId]),
        );
        expect(registry.resolveContactRefs([contactRef])).toEqual(
          Result.ok([contactId]),
        );
      }),
      propertyConfig({ numRuns: 40 }),
    );
  });

  test("keeps legacy model refs in already-hydrated values", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("legacy-workspace");
    const matterRef = registry.toMatterRef(workspaceId);
    const entityRef = registry.toEntityRef({
      entityId: toSafeId<"entity">("legacy-entity"),
      workspaceId,
    });
    const propertyRef = registry.toPropertyRef(
      toSafeId<"property">("legacy-property"),
    );
    const contactRef = registry.toContactRef(
      toSafeId<"contact">("legacy-contact"),
    );

    expect(
      registry.hydrateAssistantValueRefs(
        { contactRef, entityRef, matterRef, propertyRef },
        CHAT_REF_INPUT_STATE.LEGACY_UUID_IDS,
      ),
    ).toEqual({ contactRef, entityRef, matterRef, propertyRef });
  });

  test("rewrites citations with unknown refs to the unresolved sentinel", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const matterRef = registry.toMatterRef(workspaceId);

    // A fabricated entity has no minted ref: the href degrades to the
    // sentinel (the web renderer shows the label as plain text), while the
    // known matter ref in the same sentence still resolves. The label
    // survives because only the href substring is rewritten, which is what
    // keeps this safe across streaming chunk boundaries.
    expect(
      registry.resolveAssistantTextRefs(
        `In [Matter](#stella-workspace-ref=${matterRef}): [Fake.docx](#stella-entity-ref=ent_99)`,
      ),
    ).toBe(
      `In [Matter](#stella-workspace=${workspaceId}): ` +
        `[Fake.docx](${CHAT_UNRESOLVED_REF_HREF})`,
    );

    expect(
      registry.resolveAssistantTextRefs(
        "[Ghost matter](#stella-workspace-ref=mat_42)",
      ),
    ).toBe(`[Ghost matter](${CHAT_UNRESOLVED_REF_HREF})`);
  });

  test("does not accept raw UUIDs as refs", () => {
    const registry = createChatRefRegistry();

    const result = registry.resolveMatterRefs([
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    ]);

    expect(Result.isError(result)).toBe(true);
  });

  test("hydrates canonical links with opaque IDs without replacing a UUID prefix", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">("matter:eu-west-1");
    const entityId = toSafeId<"entity">(
      "0198c0de-0000-4000-8000-000000000000-supplement",
    );
    const workspaceRef = registry.toMatterRef(workspaceId);
    const entityRef = registry.toEntityRef({ entityId, workspaceId });
    const workspaceHref = toChatResourceHref({
      type: RESOURCE_TYPE.WORKSPACE,
      resource: resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: workspaceId }),
    });
    const entityHref = toChatResourceHref({
      type: RESOURCE_TYPE.ENTITY,
      resource: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
      location: {
        type: "workspace",
        workspace: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: workspaceId,
        }),
      },
    });

    expect(
      registry.hydrateAssistantTextRefs(
        `[Matter](${workspaceHref}) [Supplement](${entityHref})`,
      ),
    ).toBe(
      `[Matter](#stella-workspace-ref=${workspaceRef}) ` +
        `[Supplement](#stella-entity-ref=${entityRef})`,
    );
    expect(registry.hydrateAssistantTextRefs(`See ${workspaceHref}.`)).toBe(
      `See #stella-workspace-ref=${workspaceRef}.`,
    );
  });

  test("mints distinct refs for arbitrary opaque entity identity tuples", () => {
    const segment = fc.stringMatching(/^[a-z0-9]{1,12}$/u);

    fc.assert(
      fc.property(segment, segment, segment, (a, b, c) => {
        const registry = createChatRefRegistry();
        const firstTarget = {
          entityId: toSafeId<"entity">(`${b}:${c}`),
          workspaceId: toSafeId<"workspace">(a),
        };
        const secondTarget = {
          entityId: toSafeId<"entity">(c),
          workspaceId: toSafeId<"workspace">(`${a}:${b}`),
        };

        const firstRef = registry.toEntityRef(firstTarget);
        const secondRef = registry.toEntityRef(secondTarget);

        expect(firstRef).not.toBe(secondRef);
        expect(registry.resolveEntityRefTargets([firstRef, secondRef])).toEqual(
          Result.ok([firstTarget, secondTarget]),
        );
      }),
      propertyConfig({ numRuns: 100 }),
    );
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
