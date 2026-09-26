import { Result } from "better-result";
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { propertyConfig } from "@stll/property-testing";

import {
  type ChatRefRegistry,
  createChatRefRegistry,
  type EntityTarget,
} from "@/api/lib/chat/ref-registry";
import type { ChatRefBinding } from "@/api/lib/chat/ref-token";
import {
  brandPersistedEntityId,
  brandPersistedEntityVersionId,
  brandPersistedFieldId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

const WORKSPACE_IDS = [
  brandPersistedWorkspaceId("01a0df7d-c93a-7105-99f9-c66cf1b14d01"),
  brandPersistedWorkspaceId("01a0df7d-c93a-7105-99f9-c66cf1b14d02"),
] as const;

const entityTarget = (index: number): EntityTarget => ({
  entityId: brandPersistedEntityId(
    `01a0df7d-c93a-7105-99f9-${index.toString(16).padStart(12, "0")}`,
  ),
  workspaceId: WORKSPACE_IDS[index % WORKSPACE_IDS.length] ?? WORKSPACE_IDS[0],
});

const resolveEntity = (registry: ChatRefRegistry, ref: string) => {
  const resolved = registry.resolveEntityRefTargets([ref]);
  return Result.isError(resolved) ? null : (resolved.value.at(0) ?? null);
};

/**
 * One request of a thread: the registry is rebuilt from what earlier
 * requests persisted, the model is shown refs for some targets, and the
 * message persists the bindings of every ref it contains.
 */
const runRequest = ({
  bindings,
  shownTargets,
}: {
  bindings: readonly ChatRefBinding[];
  shownTargets: readonly number[];
}) => {
  const registry = createChatRefRegistry(bindings);
  const shown = shownTargets.map((index) => ({
    index,
    ref: registry.toEntityRef(entityTarget(index)),
  }));
  // A code-mode result: refs sit in arbitrary script output.
  const message = {
    result: { documents: shown.map(({ ref }) => ({ id: ref })) },
  };
  return { registry, shown, persisted: registry.collectRefBindings(message) };
};

describe("chat refs across the requests of a thread", () => {
  test("a ref keeps its target in every later request, and no spelling names two targets", () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(fc.nat({ max: 12 }), { maxLength: 6 }), {
          minLength: 1,
          maxLength: 8,
        }),
        (requests) => {
          const bindings: ChatRefBinding[] = [];
          const targetByRef = new Map<string, number>();
          for (const shownTargets of requests) {
            const { registry, shown, persisted } = runRequest({
              bindings,
              shownTargets,
            });
            for (const [ref, index] of targetByRef) {
              expect(resolveEntity(registry, ref)).toEqual(entityTarget(index));
            }
            for (const { index, ref } of shown) {
              const earlier = targetByRef.get(ref);
              expect(earlier === undefined || earlier === index).toBe(true);
              targetByRef.set(ref, index);
            }
            bindings.push(...persisted);
          }
        },
      ),
      propertyConfig(),
    );
  });

  test("a new request that mints first does not hand out a stored spelling", () => {
    const first = runRequest({ bindings: [], shownTargets: [0, 1] });
    const next = createChatRefRegistry(first.persisted);

    // The wrong-document case: another target minted before the stale ref
    // is used must not take `ent_1`.
    expect(next.toEntityRef(entityTarget(7))).toBe("ent_3");
    expect(resolveEntity(next, "ent_1")).toEqual(entityTarget(0));
    expect(next.toEntityRef(entityTarget(1))).toBe("ent_2");
  });

  test("a restored matter keeps its spelling when a tool schema offers it again", () => {
    const first = createChatRefRegistry();
    const matterRef = first.toMatterRef(WORKSPACE_IDS[1]);
    const next = createChatRefRegistry(
      first.collectRefBindings({ matter: matterRef }),
    );

    expect(next.offerMatterRef(WORKSPACE_IDS[0])).toBe("mat_2");
    expect(next.offerMatterRef(WORKSPACE_IDS[1])).toBe(matterRef);
  });

  test("a ref stored history bound to two targets resolves to neither", () => {
    const registryA = createChatRefRegistry();
    const registryB = createChatRefRegistry();
    const refA = registryA.toEntityRef(entityTarget(0));
    const refB = registryB.toEntityRef(entityTarget(1));
    expect(refA).toBe(refB);

    const next = createChatRefRegistry([
      ...registryA.collectRefBindings(refA),
      ...registryB.collectRefBindings(refB),
    ]);

    expect(resolveEntity(next, refA)).toBeNull();
    expect(next.toEntityRef(entityTarget(0))).toBe("ent_2");
  });

  test("only whole minted tokens are collected", () => {
    const registry = createChatRefRegistry();
    for (let index = 0; index < 12; index += 1) {
      registry.toEntityRef(entityTarget(index));
    }

    const refs = registry
      .collectRefBindings("see ent_12, xent_2 and ent_3x")
      .map(({ ref }) => ref);

    expect(refs).toEqual(["ent_12"]);
  });

  test("a source citation ref round-trips through its binding", () => {
    const first = createChatRefRegistry();
    const href = first.toSourceCitationHref({
      type: "pdf-bates",
      bates: "NW-000042",
      entityId: entityTarget(0).entityId,
      entityVersionId: brandPersistedEntityVersionId(
        "01a0df7d-c93a-7105-99f9-c66cf1b14d10",
      ),
      fieldId: brandPersistedFieldId("01a0df7d-c93a-7105-99f9-c66cf1b14d11"),
      pageNumber: 3,
      workspaceId: WORKSPACE_IDS[0],
    });
    const next = createChatRefRegistry(first.collectRefBindings(href));

    expect(next.resolveAssistantTextRefs(`[p. 3](${href})`)).not.toContain(
      "#stella-unresolved-ref",
    );
  });
});
