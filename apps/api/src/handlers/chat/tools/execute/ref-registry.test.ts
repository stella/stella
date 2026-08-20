import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  resourceRef,
  RESOURCE_TYPE,
  toChatSourceCitationHref,
  toChatResourceHref,
} from "@stll/api-contract";
import { propertyConfig } from "@stll/property-testing";

import { toSafeId } from "@/api/lib/branded-types";
import {
  CHAT_UNRESOLVED_REF_HREF,
  createChatRefRegistry,
} from "@/api/lib/chat/ref-registry";
import { CHAT_REF_INPUT_STATE } from "@/api/lib/chat/ref-token";

describe("chat ref registry", () => {
  test("never infers ref semantics from structured field names", () => {
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
          "entityRef",
          "entityId",
          "id",
          "matterRef",
          "propertyRef",
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
  });

  test("uses short refs for model-facing links and resolves canonical hrefs", () => {
    const registry = createChatRefRegistry();
    const workspaceId = toSafeId<"workspace">(
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    );
    const entityId = toSafeId<"entity">("c09ec856-d945-5ecc-82e3-bb5382165f34");
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
      entityRef,
      fields: [{ propertyRef }],
      matterRef,
      contactRef,
      mention:
        "[Matter](#stella-workspace=0dc54d0c-10d7-501d-897e-e801dbd0998c) " +
        "[Doc](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34)",
    });

    const persistedValue = {
      matterRef: workspaceId,
      nested: {
        mention:
          "[Matter](#stella-workspace=0dc54d0c-10d7-501d-897e-e801dbd0998c) " +
          "[Doc](#stella-entity=0dc54d0c-10d7-501d-897e-e801dbd0998c:c09ec856-d945-5ecc-82e3-bb5382165f34)",
      },
    };

    expect(registry.hydrateAssistantValueRefs(persistedValue)).toEqual({
      matterRef: workspaceId,
      nested: {
        mention: `[Matter](#stella-workspace-ref=${matterRef}) [Doc](#stella-entity-ref=${entityRef})`,
      },
    });
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

  test("round trips only server-minted source citations", () => {
    const registry = createChatRefRegistry();
    const target = {
      type: "pdf-bates" as const,
      workspaceId: toSafeId<"workspace">("matter:eu-west-1"),
      entityId: toSafeId<"entity">("loan-agreement"),
      fieldId: toSafeId<"field">("signed-pdf"),
      pageNumber: 7,
      bates: "F0-0007",
    };
    const modelHref = registry.toSourceCitationHref(target);
    const canonicalHref = toChatSourceCitationHref(target);

    expect(modelHref).toBe("#stella-source-ref=src_1");
    expect(registry.resolveAssistantTextRefs(`[F0-0007](${modelHref})`)).toBe(
      `[F0-0007](${canonicalHref})`,
    );
    expect(registry.getRegisteredWorkspaceIds()).toEqual([target.workspaceId]);

    const reloaded = createChatRefRegistry();
    expect(
      reloaded.hydrateAssistantTextRefs(`[F0-0007](${canonicalHref})`),
    ).toBe("[F0-0007](#stella-source-ref=src_1)");
    expect(
      createChatRefRegistry().hydrateUserTextRefs(
        `[Untrusted source](${canonicalHref})`,
      ),
    ).toBe(`[Untrusted source](${CHAT_UNRESOLVED_REF_HREF})`);
    expect(
      reloaded.resolveAssistantTextRefs(
        "[Fabricated](#stella-source-ref=src_99)",
      ),
    ).toBe(`[Fabricated](${CHAT_UNRESOLVED_REF_HREF})`);
  });

  test("does not accept raw UUIDs as refs", () => {
    const registry = createChatRefRegistry();

    const result = registry.resolveMatterRefs([
      "0dc54d0c-10d7-501d-897e-e801dbd0998c",
    ]);

    expect(Result.isError(result)).toBe(true);
  });

  test("does not brand ill-formed persisted ref IDs during hydration", () => {
    const registry = createChatRefRegistry();
    const illFormedId = "resource_\uD800";

    for (const kind of ["matter", "property", "contact"] as const) {
      expect(
        registry.hydrateRefId({
          inputState: CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_REFS_V2,
          kind,
          value: illFormedId,
        }),
      ).toBe(illFormedId);
    }
    expect(
      registry.hydrateRefId({
        inputState: CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_REFS_V2,
        kind: "entity",
        value: illFormedId,
        workspaceId: illFormedId,
      }),
    ).toBe(illFormedId);
    const entityId = "entity-safe";
    expect(
      registry.hydrateRefId({
        inputState: CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_REFS_V2,
        kind: "entity",
        value: entityId,
        workspaceId: illFormedId,
      }),
    ).toBe(entityId);
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
