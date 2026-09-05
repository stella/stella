import { panic, Result } from "better-result";

import {
  type ChatSourceCitationTarget,
  isSafeIdValue,
  replaceCanonicalChatSourceCitationHrefs,
  replaceCanonicalChatResourceHrefs,
  resourceRef,
  RESOURCE_TYPE,
  toChatSourceCitationHref,
  toChatResourceHref,
} from "@stll/api-contract";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import {
  CHAT_REF_INPUT_STATE,
  CHAT_REF_TOKEN_PREFIX,
  type ChatRefInputState,
  type ChatRefTokenKind,
} from "@/api/lib/chat/ref-token";
import { ChatToolError, TelemetryError } from "@/api/lib/errors/tagged-errors";
import {
  brandPersistedContactId,
  brandPersistedEntityId,
  brandPersistedPropertyId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

export const CHAT_ENTITY_REF_PREFIX = "#stella-entity-ref=";
export const CHAT_WORKSPACE_REF_PREFIX = "#stella-workspace-ref=";
export const CHAT_SOURCE_CITATION_REF_PREFIX = "#stella-source-ref=";
/**
 * Replacement href for a ref the model cited but this turn never minted — a
 * fabricated or mangled citation. The web renderer shows the link label as
 * plain text for this href, so an invented document can never render as a
 * real-looking clickable pill; the old behavior (pass the unknown ref
 * through verbatim) did exactly that via the client's fallback-workspace
 * chip. Kept href-shaped so the rewrite stays safe across streaming chunk
 * boundaries, where the link label may already have been flushed.
 */
export const CHAT_UNRESOLVED_REF_HREF = "#stella-unresolved-ref";
const REGEX_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/gu;
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const escapeRegex = (value: string) =>
  value.replaceAll(REGEX_SPECIAL_CHARS, "\\$&");

const createRefLinkRegex = (prefix: string) =>
  new RegExp(`${escapeRegex(prefix)}([^\\s)]+)`, "gu");

const ENTITY_REF_LINK_REGEX = createRefLinkRegex(CHAT_ENTITY_REF_PREFIX);
const WORKSPACE_REF_LINK_REGEX = createRefLinkRegex(CHAT_WORKSPACE_REF_PREFIX);
const SOURCE_CITATION_REF_LINK_REGEX = createRefLinkRegex(
  CHAT_SOURCE_CITATION_REF_PREFIX,
);

// Shape of a ref this registry mints: `<prefix>_<counter>`.
const MINTED_REF_SHAPE = /^[a-z]+_[0-9]+$/u;

/**
 * Telemetry description of a ref the registry never minted. Such a ref is
 * model-authored text captured by the link regex, not a token this turn
 * produced, so only its shape travels: a short digest correlates repeats of
 * the same ref without carrying its content.
 */
const describeUnresolvedRef = (ref: string) => ({
  refDigest: new Bun.CryptoHasher("sha256")
    .update(ref)
    .digest("hex")
    .slice(0, 8),
  refLength: String(ref.length),
  refMatchesMintedShape: String(MINTED_REF_SHAPE.test(ref)),
});

const escapeMarkdownLinkLabel = (label: string) =>
  label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");

const createEntityRefKey = ({ entityId, workspaceId }: EntityTarget) =>
  JSON.stringify([workspaceId, entityId]);

const createSourceCitationRefKey = (target: ChatSourceCitationTarget) => {
  switch (target.type) {
    case "docx-folio":
      return JSON.stringify([
        target.type,
        target.workspaceId,
        target.entityId,
        target.entityVersionId,
        target.fieldId,
        target.blockId,
        target.text,
      ]);
    case "pdf-bates":
      return JSON.stringify([
        target.type,
        target.workspaceId,
        target.entityId,
        target.entityVersionId,
        target.fieldId,
        target.pageNumber,
        target.bates,
      ]);
    default:
      target satisfies never;
      return panic(`Unhandled target: ${String(target)}`);
  }
};

const toWorkspaceResource = (workspaceId: SafeId<"workspace">) =>
  resourceRef({ type: RESOURCE_TYPE.WORKSPACE, id: workspaceId });

const toEntityResourceTarget = ({ entityId, workspaceId }: EntityTarget) => ({
  type: RESOURCE_TYPE.ENTITY,
  resource: resourceRef({ type: RESOURCE_TYPE.ENTITY, id: entityId }),
  location: {
    type: "workspace" as const,
    workspace: toWorkspaceResource(workspaceId),
  },
});

export type EntityTarget = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
};

type RefState<TTarget> = {
  counter: number;
  prefix: string;
  refToTarget: Map<string, TTarget>;
  targetToRef: Map<string, string>;
};

type ResolveRefsResult<TTarget> = Result<TTarget[], ChatToolError>;

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
}): ResolveRefsResult<TTarget> => {
  const targets: TTarget[] = [];

  for (const ref of refs) {
    const target = state.refToTarget.get(ref);
    if (target === undefined) {
      return Result.err(
        new ChatToolError({
          kind: "invalid-input",
          message: `Unknown ${kind} ref "${ref}". Use refs returned by stella tools.`,
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

const isPersistedIdForInput = (
  value: unknown,
  inputState: ChatRefInputState,
): value is string => {
  if (typeof value !== "string" || !isSafeIdValue(value)) {
    return false;
  }

  switch (inputState) {
    case CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_IDS_V1:
    case CHAT_REF_INPUT_STATE.PERSISTED_RESOURCE_REFS_V2:
      return true;
    case CHAT_REF_INPUT_STATE.LEGACY_UUID_IDS:
      return UUID_REGEX.test(value);
    default:
      inputState satisfies never;
      return false;
  }
};

/**
 * The four tenant-content id kinds this registry mediates. Every other id a
 * registry handler emits (user, task-link, invoice, time-entry, template,
 * clause, playbook, audit-log, usage-plan, or public case-law/BOE corpus id) is
 * a handle the model may pass back verbatim, not a tenant-content reference, so
 * it stays outside this set. `projection-schema.ts` re-exports this as
 * `RegistryRefKind`; the vocabulary lives here because the registry is the
 * lowest module that has to know all four.
 */
export type ChatRefKind = ChatRefTokenKind;

/**
 * One id to turn back into a chat ref. `workspaceId` applies only to
 * `kind: "entity"`, whose ref key is the (workspace, entity) pair; when it is
 * absent or empty the registry falls back to the unique ref it already
 * minted for that entity id this turn, and otherwise leaves the value alone.
 */
export type HydrateRefIdProps = {
  inputState: ChatRefInputState;
  kind: ChatRefKind;
  value: unknown;
  workspaceId?: unknown;
};

export type ResolveRefIdProps = {
  kind: ChatRefKind;
  value: unknown;
};

export type ChatRefRegistry = {
  /**
   * Deduped union of every workspace id any tool (including subagents)
   * resolved a matter or entity ref for on this turn, regardless of
   * whether that content ever reached the assistant's response parts.
   * Used to widen `chat_threads.data_workspace_ids` so a subagent that
   * read a matter but only returned a free-form summary still triggers
   * scope persistence — otherwise a later access revocation would leave
   * that content readable via the persisted assistant text.
   */
  getRegisteredWorkspaceIds: () => SafeId<"workspace">[];
  hydrateAssistantTextRefs: (text: string) => string;
  hydrateUserTextRefs: (text: string) => string;
  hydrateAssistantValueRefs: (value: unknown) => unknown;
  /**
   * Mint (or reuse) this turn's ref for one already-resolved id, chosen by
   * kind rather than by key name. Tool input and output kinds come from the
   * registry adapter's declared path policies. Empty and non-string values
   * are returned unchanged.
   */
  hydrateRefId: (props: HydrateRefIdProps) => unknown;
  /** Resolve one declared model-facing ref without guessing from its text. */
  resolveRefId: (props: ResolveRefIdProps) => unknown;
  resolveAssistantTextRefs: (text: string) => string;
  resolveAssistantValueRefs: (value: unknown) => unknown;
  resolveContactRefs: (
    refs: string[],
  ) => Result<SafeId<"contact">[], ChatToolError>;
  resolveEntityRefs: (
    refs: string[],
  ) => Result<SafeId<"entity">[], ChatToolError>;
  /**
   * Like `resolveEntityRefs`, but keeps each ref's owning workspace id
   * alongside its entity id. Callers that need to mint a ref for a
   * *different* entity known to share the resolved ref's workspace (e.g. a
   * task's linked entities) use this instead of discarding the workspace id.
   */
  resolveEntityRefTargets: (
    refs: string[],
  ) => Result<EntityTarget[], ChatToolError>;
  resolveMatterRefs: (
    refs: string[],
  ) => Result<SafeId<"workspace">[], ChatToolError>;
  resolveParentRef: (
    ref: string | undefined,
  ) => Result<SafeId<"entity"> | undefined, ChatToolError>;
  resolvePropertyRefs: (
    refs: string[],
  ) => Result<SafeId<"property">[], ChatToolError>;
  toContactRef: (contactId: SafeId<"contact">) => string;
  toEntityMention: (props: EntityTarget & { label: string }) => string;
  toEntityRef: (target: EntityTarget) => string;
  toMatterMention: (props: {
    label: string;
    workspaceId: SafeId<"workspace">;
  }) => string;
  toMatterRef: (workspaceId: SafeId<"workspace">) => string;
  toPropertyRef: (propertyId: SafeId<"property">) => string;
  toSourceCitationHref: (target: ChatSourceCitationTarget) => string;
};

export const createChatRefRegistry = (): ChatRefRegistry => {
  const contactState = createRefState<SafeId<"contact">>(
    CHAT_REF_TOKEN_PREFIX.contact,
  );
  const matterState = createRefState<SafeId<"workspace">>(
    CHAT_REF_TOKEN_PREFIX.matter,
  );
  const propertyState = createRefState<SafeId<"property">>(
    CHAT_REF_TOKEN_PREFIX.property,
  );
  const entityState = createRefState<EntityTarget>(
    CHAT_REF_TOKEN_PREFIX.entity,
  );
  const sourceCitationState = createRefState<ChatSourceCitationTarget>("src");

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

  const toContactRef = (contactId: SafeId<"contact">) =>
    getOrCreateRef({
      key: contactId,
      state: contactState,
      target: contactId,
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

  const toSourceCitationRef = (target: ChatSourceCitationTarget) => {
    // Source citations necessarily disclose content from their owning matter.
    // Register the entity as well so thread-scope persistence cannot omit that
    // workspace when the final answer contains only passage citations.
    toEntityRef({
      entityId: target.entityId,
      workspaceId: target.workspaceId,
    });
    return getOrCreateRef({
      key: createSourceCitationRefKey(target),
      state: sourceCitationState,
      target,
    });
  };

  const toSourceCitationRefHref = (target: ChatSourceCitationTarget) =>
    `${CHAT_SOURCE_CITATION_REF_PREFIX}${toSourceCitationRef(target)}`;

  const reportUnknownAssistantRef = (kind: string, ref: string) => {
    captureError(
      new TelemetryError({
        message: "Assistant text cited a chat ref this turn never minted",
      }),
      {
        source: "chat-ref-registry",
        kind,
        ...describeUnresolvedRef(ref),
      },
    );
  };

  const resolveAssistantTextRefs = (text: string) => {
    // Only opaque refs minted by this registry are trusted on live model
    // output. Reject any canonical locator the model wrote directly before
    // resolving legitimate refs into canonical persisted links.
    const withoutDirectSourceCitations =
      replaceCanonicalChatSourceCitationHrefs(
        text,
        () => CHAT_UNRESOLVED_REF_HREF,
      );
    const withSourceCitationRefs = replaceRefLinks({
      regex: SOURCE_CITATION_REF_LINK_REGEX,
      resolve: (ref) => {
        const target = sourceCitationState.refToTarget.get(ref);
        if (!target) {
          reportUnknownAssistantRef("source-citation", ref);
          return CHAT_UNRESOLVED_REF_HREF;
        }
        return toChatSourceCitationHref(target);
      },
      text: withoutDirectSourceCitations,
    });

    const withWorkspaceRefs = replaceRefLinks({
      regex: WORKSPACE_REF_LINK_REGEX,
      resolve: (ref) => {
        const workspaceId = matterState.refToTarget.get(ref);
        if (!workspaceId) {
          reportUnknownAssistantRef("matter", ref);
          return CHAT_UNRESOLVED_REF_HREF;
        }
        return toChatResourceHref({
          type: RESOURCE_TYPE.WORKSPACE,
          resource: toWorkspaceResource(workspaceId),
        });
      },
      text: withSourceCitationRefs,
    });

    return replaceRefLinks({
      regex: ENTITY_REF_LINK_REGEX,
      resolve: (ref) => {
        const target = entityState.refToTarget.get(ref);
        if (!target) {
          reportUnknownAssistantRef("entity", ref);
          return CHAT_UNRESOLVED_REF_HREF;
        }
        return toChatResourceHref(toEntityResourceTarget(target));
      },
      text: withWorkspaceRefs,
    });
  };

  const hydrateAssistantTextRefs = (text: string) => {
    const withSourceCitationRefs = replaceCanonicalChatSourceCitationHrefs(
      text,
      toSourceCitationRefHref,
    );
    return replaceCanonicalChatResourceHrefs(
      withSourceCitationRefs,
      ({ href, target }) => {
        switch (target.type) {
          case RESOURCE_TYPE.WORKSPACE:
            return `${CHAT_WORKSPACE_REF_PREFIX}${toMatterRef(
              brandPersistedWorkspaceId(target.resource.id),
            )}`;
          case RESOURCE_TYPE.ENTITY:
            if (target.location.type !== "workspace") {
              return href;
            }
            return `${CHAT_ENTITY_REF_PREFIX}${toEntityRef({
              entityId: brandPersistedEntityId(target.resource.id),
              workspaceId: brandPersistedWorkspaceId(
                target.location.workspace.id,
              ),
            })}`;
          case RESOURCE_TYPE.CASE_LAW_DECISION:
            return href;
          default:
            target satisfies never;
            return panic(`Unhandled target: ${String(target)}`);
        }
      },
    );
  };

  const hydrateUserTextRefs = (text: string) => {
    // A user may paste a durable source href, but only normalized review
    // output may mint a model-facing source ref. Strip the locator's raw ids
    // while preserving ordinary entity and matter mentions.
    const withoutUntrustedSourceCitations =
      replaceCanonicalChatSourceCitationHrefs(
        text,
        () => CHAT_UNRESOLVED_REF_HREF,
      );
    return replaceCanonicalChatResourceHrefs(
      withoutUntrustedSourceCitations,
      ({ href, target }) => {
        switch (target.type) {
          case RESOURCE_TYPE.WORKSPACE:
            return `${CHAT_WORKSPACE_REF_PREFIX}${toMatterRef(
              brandPersistedWorkspaceId(target.resource.id),
            )}`;
          case RESOURCE_TYPE.ENTITY:
            if (target.location.type !== "workspace") {
              return href;
            }
            return `${CHAT_ENTITY_REF_PREFIX}${toEntityRef({
              entityId: brandPersistedEntityId(target.resource.id),
              workspaceId: brandPersistedWorkspaceId(
                target.location.workspace.id,
              ),
            })}`;
          case RESOURCE_TYPE.CASE_LAW_DECISION:
            return href;
          default:
            target satisfies never;
            return panic(`Unhandled target: ${String(target)}`);
        }
      },
    );
  };

  const resolveRefId = ({ kind, value }: ResolveRefIdProps): unknown => {
    if (typeof value !== "string") {
      return value;
    }

    switch (kind) {
      case "matter":
        return matterState.refToTarget.get(value) ?? value;
      case "entity":
        return entityState.refToTarget.get(value)?.entityId ?? value;
      case "property":
        return propertyState.refToTarget.get(value) ?? value;
      case "contact":
        return contactState.refToTarget.get(value) ?? value;
      default:
        kind satisfies never;
        return panic(`Unhandled kind: ${String(kind)}`);
    }
  };

  const resolveAssistantValueRefs = (value: unknown): unknown => {
    if (typeof value === "string") {
      return resolveAssistantTextRefs(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => resolveAssistantValueRefs(item));
    }

    if (!isPlainRecord(value)) {
      return value;
    }

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        resolveAssistantValueRefs(child),
      ]),
    );
  };

  const toHydratedMatterRef = (
    value: unknown,
    inputState: ChatRefInputState,
  ) =>
    isPersistedIdForInput(value, inputState)
      ? toMatterRef(brandPersistedWorkspaceId(value))
      : value;

  const toHydratedPropertyRef = (
    value: unknown,
    inputState: ChatRefInputState,
  ) =>
    isPersistedIdForInput(value, inputState)
      ? toPropertyRef(brandPersistedPropertyId(value))
      : value;

  const toHydratedContactRef = (
    value: unknown,
    inputState: ChatRefInputState,
  ) =>
    isPersistedIdForInput(value, inputState)
      ? toContactRef(brandPersistedContactId(value))
      : value;

  const toHydratedEntityRef = ({
    entityId,
    inputState,
    workspaceId,
  }: {
    entityId: unknown;
    inputState: ChatRefInputState;
    workspaceId: unknown;
  }) => {
    if (!isPersistedIdForInput(entityId, inputState)) {
      return entityId;
    }

    if (!isPersistedIdForInput(workspaceId, inputState)) {
      const matchingRefs = [...entityState.refToTarget.entries()]
        .filter(([, target]) => target.entityId === entityId)
        .map(([ref]) => ref);

      return matchingRefs.length === 1 ? matchingRefs[0] : entityId;
    }

    return toEntityRef({
      entityId: brandPersistedEntityId(entityId),
      workspaceId: brandPersistedWorkspaceId(workspaceId),
    });
  };

  const hydrateRefId = ({
    inputState,
    kind,
    value,
    workspaceId,
  }: HydrateRefIdProps): unknown => {
    switch (kind) {
      case "matter":
        return toHydratedMatterRef(value, inputState);
      case "entity":
        return toHydratedEntityRef({
          entityId: value,
          inputState,
          workspaceId,
        });
      case "contact":
        return toHydratedContactRef(value, inputState);
      case "property":
        return toHydratedPropertyRef(value, inputState);
      default:
        kind satisfies never;
        return panic(`Unhandled kind: ${String(kind)}`);
    }
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

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        hydrateAssistantValueRefs(child),
      ]),
    );
  };

  const getRegisteredWorkspaceIds = (): SafeId<"workspace">[] => {
    const ids = new Set<SafeId<"workspace">>([
      ...matterState.refToTarget.values(),
      ...[...entityState.refToTarget.values()].map(
        (target) => target.workspaceId,
      ),
    ]);
    return [...ids];
  };

  return {
    getRegisteredWorkspaceIds,
    hydrateAssistantTextRefs,
    hydrateUserTextRefs,
    hydrateAssistantValueRefs,
    hydrateRefId,
    resolveAssistantTextRefs,
    resolveAssistantValueRefs,
    resolveRefId,
    resolveEntityRefs: (refs: string[]) => {
      const resolved = resolveRefs({
        kind: "entity",
        refs,
        state: entityState,
      });

      if (Result.isError(resolved)) {
        return Result.err(resolved.error);
      }

      return Result.ok(resolved.value.map(({ entityId }) => entityId));
    },
    resolveEntityRefTargets: (refs: string[]) =>
      resolveRefs({
        kind: "entity",
        refs,
        state: entityState,
      }),
    resolveContactRefs: (refs: string[]) =>
      resolveRefs({
        kind: "contact",
        refs,
        state: contactState,
      }),
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

      const resolved = resolveRefs({
        kind: "entity",
        refs: [ref],
        state: entityState,
      });

      if (Result.isError(resolved)) {
        return Result.err(resolved.error);
      }

      return Result.ok(resolved.value.at(0)?.entityId);
    },
    resolvePropertyRefs: (refs: string[]) =>
      resolveRefs({
        kind: "property",
        refs,
        state: propertyState,
      }),
    toEntityRef,
    toContactRef,
    toMatterRef,
    toPropertyRef,
    toSourceCitationHref: toSourceCitationRefHref,
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
