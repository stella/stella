import { Result } from "better-result";

import type { SafeId } from "@/api/lib/branded-types";
import { toSafeId } from "@/api/lib/branded-types";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";

export const CHAT_ENTITY_REF_PREFIX = "#stella-entity-ref=";
export const CHAT_WORKSPACE_REF_PREFIX = "#stella-workspace-ref=";
const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const createRefLinkRegex = (prefix: string) =>
  new RegExp(
    `${prefix.replaceAll(REGEX_SPECIAL_CHARS, "\\$&")}([^\\s)]+)`,
    "g",
  );

const ENTITY_REF_LINK_REGEX = createRefLinkRegex(CHAT_ENTITY_REF_PREFIX);
const WORKSPACE_REF_LINK_REGEX = createRefLinkRegex(CHAT_WORKSPACE_REF_PREFIX);
const UUID_REGEX = new RegExp(`^${UUID_PATTERN}$`, "i");
const PERSISTED_ENTITY_LINK_REGEX = new RegExp(
  `#stella-entity=(${UUID_PATTERN}):(${UUID_PATTERN})`,
  "gi",
);
const PERSISTED_WORKSPACE_LINK_REGEX = new RegExp(
  `#stella-workspace=(${UUID_PATTERN})`,
  "gi",
);

const escapeMarkdownLinkLabel = (label: string) =>
  label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");

const createEntityRefKey = ({ entityId, workspaceId }: EntityTarget) =>
  `${workspaceId}:${entityId}`;

type EntityTarget = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
};

type RefState<TTarget> = {
  counter: number;
  prefix: string;
  refToTarget: Map<string, TTarget>;
  targetToRef: Map<string, string>;
};

const createRefState = <TTarget>(prefix: string): RefState<TTarget> => ({
  counter: 0,
  prefix,
  refToTarget: new Map(),
  targetToRef: new Map(),
});

const getOrCreateRef = <TTarget>({
  key,
  state,
  target,
}: {
  key: string;
  state: RefState<TTarget>;
  target: TTarget;
}) => {
  const existingRef = state.targetToRef.get(key);
  if (existingRef) {
    return existingRef;
  }

  state.counter += 1;
  const ref = `${state.prefix}_${state.counter}`;
  state.targetToRef.set(key, ref);
  state.refToTarget.set(ref, target);
  return ref;
};

const resolveRefs = <TTarget>({
  kind,
  refs,
  state,
}: {
  kind: string;
  refs: string[];
  state: RefState<TTarget>;
}) => {
  const targets: TTarget[] = [];

  for (const ref of refs) {
    const target = state.refToTarget.get(ref);
    if (target === undefined) {
      return Result.err(
        new ChatToolError({
          message: `Unknown ${kind} ref "${ref}". Use refs returned by Stella tools.`,
        }),
      );
    }

    targets.push(target);
  }

  return Result.ok(targets);
};

const replaceRefLinks = ({
  regex,
  resolve,
  text,
}: {
  regex: RegExp;
  resolve: (ref: string) => string | null;
  text: string;
}) => text.replaceAll(regex, (href, ref: string) => resolve(ref) ?? href);

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  Object.getPrototypeOf(value) === Object.prototype;

const isUnknownArray = (value: unknown): value is unknown[] =>
  Array.isArray(value);

const isUuidString = (value: unknown): value is string =>
  typeof value === "string" && UUID_REGEX.test(value);

export type ChatRefRegistry = ReturnType<typeof createChatRefRegistry>;

export const createChatRefRegistry = () => {
  const matterState = createRefState<SafeId<"workspace">>("mat");
  const propertyState = createRefState<SafeId<"property">>("prop");
  const entityState = createRefState<EntityTarget>("ent");

  const toMatterRef = (workspaceId: SafeId<"workspace">) =>
    getOrCreateRef({
      key: workspaceId,
      state: matterState,
      target: workspaceId,
    });

  const toPropertyRef = (propertyId: SafeId<"property">) =>
    getOrCreateRef({
      key: propertyId,
      state: propertyState,
      target: propertyId,
    });

  const toEntityRef = ({ entityId, workspaceId }: EntityTarget) =>
    getOrCreateRef({
      key: createEntityRefKey({ entityId, workspaceId }),
      state: entityState,
      target: {
        entityId,
        workspaceId,
      },
    });

  const resolveAssistantTextRefs = (text: string) => {
    const withWorkspaceRefs = replaceRefLinks({
      regex: WORKSPACE_REF_LINK_REGEX,
      resolve: (ref) => {
        const workspaceId = matterState.refToTarget.get(ref);
        return workspaceId ? `#stella-workspace=${workspaceId}` : null;
      },
      text,
    });

    return replaceRefLinks({
      regex: ENTITY_REF_LINK_REGEX,
      resolve: (ref) => {
        const target = entityState.refToTarget.get(ref);
        return target
          ? `#stella-entity=${target.workspaceId}:${target.entityId}`
          : null;
      },
      text: withWorkspaceRefs,
    });
  };

  const hydrateAssistantTextRefs = (text: string) => {
    const withWorkspaceRefs = text.replaceAll(
      PERSISTED_WORKSPACE_LINK_REGEX,
      (_href, rawWorkspaceId: string) =>
        `${CHAT_WORKSPACE_REF_PREFIX}${toMatterRef(toSafeId<"workspace">(rawWorkspaceId))}`,
    );

    return withWorkspaceRefs.replaceAll(
      PERSISTED_ENTITY_LINK_REGEX,
      (_href, rawWorkspaceId: string, rawEntityId: string) =>
        `${CHAT_ENTITY_REF_PREFIX}${toEntityRef({
          entityId: toSafeId<"entity">(rawEntityId),
          workspaceId: toSafeId<"workspace">(rawWorkspaceId),
        })}`,
    );
  };

  const resolveAssistantValueRefs = (value: unknown): unknown => {
    if (typeof value === "string") {
      const workspaceId = matterState.refToTarget.get(value);
      if (workspaceId) {
        return workspaceId;
      }

      const entity = entityState.refToTarget.get(value);
      if (entity) {
        return entity.entityId;
      }

      const propertyId = propertyState.refToTarget.get(value);
      if (propertyId) {
        return propertyId;
      }

      return resolveAssistantTextRefs(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => resolveAssistantValueRefs(item));
    }

    if (!isPlainRecord(value)) {
      return value;
    }

    const entries: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value)) {
      entries.push([key, resolveAssistantValueRefs(child)]);
    }
    return Object.fromEntries(entries);
  };

  const toHydratedMatterRef = (value: unknown) =>
    isUuidString(value) ? toMatterRef(toSafeId<"workspace">(value)) : value;

  const toHydratedPropertyRef = (value: unknown) =>
    isUuidString(value) ? toPropertyRef(toSafeId<"property">(value)) : value;

  const toHydratedEntityRef = ({
    entityId,
    workspaceId,
  }: {
    entityId: unknown;
    workspaceId: unknown;
  }) => {
    if (!isUuidString(entityId)) {
      return entityId;
    }

    if (!isUuidString(workspaceId)) {
      const matchingRefs = [...entityState.refToTarget.entries()]
        .filter(([, target]) => target.entityId === entityId)
        .map(([ref]) => ref);

      return matchingRefs.length === 1 ? matchingRefs[0] : entityId;
    }

    return toEntityRef({
      entityId: toSafeId<"entity">(entityId),
      workspaceId: toSafeId<"workspace">(workspaceId),
    });
  };

  const getHydrationWorkspaceId = (value: Record<string, unknown>): unknown => {
    if (isUuidString(value["matterRef"])) {
      return value["matterRef"];
    }

    if (isUuidString(value["workspaceId"])) {
      return value["workspaceId"];
    }

    const matterRefs = value["matterRefs"];
    if (isUnknownArray(matterRefs) && matterRefs.length === 1) {
      return matterRefs[0];
    }

    return undefined;
  };

  const getHydrationWorkspaceIds = (value: Record<string, unknown>) => {
    const matterRefs = value["matterRefs"];
    return isUnknownArray(matterRefs) ? matterRefs : [];
  };

  const hydrateAssistantValueRefs = (value: unknown): unknown => {
    if (typeof value === "string") {
      return hydrateAssistantTextRefs(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => hydrateAssistantValueRefs(item));
    }

    if (!isPlainRecord(value)) {
      return value;
    }

    const workspaceId = getHydrationWorkspaceId(value);
    const workspaceIds = getHydrationWorkspaceIds(value);
    const entries: [string, unknown][] = [];

    for (const [key, child] of Object.entries(value)) {
      if (key === "matterRef") {
        entries.push([key, toHydratedMatterRef(child)]);
        continue;
      }

      if (key === "matterRefs" && Array.isArray(child)) {
        entries.push([key, child.map(toHydratedMatterRef)]);
        continue;
      }

      if (key === "entityRef") {
        entries.push([
          key,
          toHydratedEntityRef({ entityId: child, workspaceId }),
        ]);
        continue;
      }

      if (key === "parentRef") {
        entries.push([
          key,
          child === null
            ? null
            : toHydratedEntityRef({ entityId: child, workspaceId }),
        ]);
        continue;
      }

      if (key === "entityRefs" && Array.isArray(child)) {
        entries.push([
          key,
          child.map((entityId, index) =>
            toHydratedEntityRef({
              entityId,
              workspaceId:
                workspaceIds.length === child.length
                  ? workspaceIds.at(index)
                  : workspaceId,
            }),
          ),
        ]);
        continue;
      }

      if (key === "propertyRef" || key === "dependsOnPropertyRef") {
        entries.push([key, toHydratedPropertyRef(child)]);
        continue;
      }

      if (key === "propertyRefs" && Array.isArray(child)) {
        entries.push([key, child.map(toHydratedPropertyRef)]);
        continue;
      }

      entries.push([key, hydrateAssistantValueRefs(child)]);
    }

    return Object.fromEntries(entries);
  };

  return {
    hydrateAssistantTextRefs,
    hydrateAssistantValueRefs,
    resolveAssistantTextRefs,
    resolveAssistantValueRefs,
    resolveEntityRefs: (refs: string[]) =>
      resolveRefs({
        kind: "entity",
        refs,
        state: entityState,
      }).map((targets) => targets.map(({ entityId }) => entityId)),
    resolveMatterRefs: (refs: string[]) =>
      resolveRefs({
        kind: "matter",
        refs,
        state: matterState,
      }),
    resolveParentRef: (ref: string | undefined) => {
      if (!ref) {
        return Result.ok(undefined);
      }

      return resolveRefs({
        kind: "entity",
        refs: [ref],
        state: entityState,
      }).map((targets) => targets.at(0)?.entityId);
    },
    resolvePropertyRefs: (refs: string[]) =>
      resolveRefs({
        kind: "property",
        refs,
        state: propertyState,
      }),
    toEntityRef,
    toMatterRef,
    toPropertyRef,
    toEntityMention: ({
      entityId,
      label,
      workspaceId,
    }: EntityTarget & { label: string }) => {
      const ref = toEntityRef({ entityId, workspaceId });
      return `[${escapeMarkdownLinkLabel(label)}](${CHAT_ENTITY_REF_PREFIX}${ref})`;
    },
    toMatterMention: ({
      label,
      workspaceId,
    }: {
      label: string;
      workspaceId: SafeId<"workspace">;
    }) => {
      const ref = toMatterRef(workspaceId);
      return `[${escapeMarkdownLinkLabel(label)}](${CHAT_WORKSPACE_REF_PREFIX}${ref})`;
    },
  };
};
