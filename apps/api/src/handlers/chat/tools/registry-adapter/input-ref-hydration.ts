import { panic, Result } from "better-result";

import type {
  ChatRefRegistry,
  EntityTarget,
} from "@/api/lib/chat/ref-registry";
import type {
  ChatEntityRefContext,
  ChatRefInputState,
  ChatUnresolvedInputRefContext,
} from "@/api/lib/chat/ref-token";
import { isRecord } from "@/api/lib/type-guards";

import { NATIVE_CHAT_REF_POLICY } from "./native-chat-ref-policy";
import type { InputRefParam, RegistryRefFieldMapEntry } from "./ref-field-map";
import {
  READ_TOOL_REF_FIELD_MAP,
  WRITE_TOOL_REF_FIELD_MAP,
} from "./ref-field-map";

/**
 * Ingress counterpart to `dehydrateRefs`, for a persisted tool call replayed on
 * a later turn.
 *
 * A turn's refs are minted per turn, so an assistant tool call is persisted
 * with successful input refs resolved to real ids (`resolveAssistantMessageRefs`).
 * Unknown refs retain their model token and are declared in `refContext`.
 * Replaying the row therefore re-mints only resolved refs; a failed call stays
 * failed instead of turning its unknown token into an invented resource id.
 *
 * Generic value hydration only rewrites canonical links. Tool-call input ids
 * are mediated through the declared map that also drives dehydration, so
 * external payload keys cannot acquire ref semantics by coincidence and the
 * two directions cannot drift.
 */

/**
 * Declared input refs per chat-projected registry tool, read and write. Built
 * from the two ref-field maps rather than restated, so a tool whose input refs
 * change is hydrated by the same declaration that dehydrates it.
 */
const buildInputRefsByTool = (): ReadonlyMap<
  string,
  readonly InputRefParam[]
> => {
  const byTool = new Map<string, readonly InputRefParam[]>();
  const entries: [string, RegistryRefFieldMapEntry][] = [
    ...Object.entries(READ_TOOL_REF_FIELD_MAP),
    ...Object.entries(WRITE_TOOL_REF_FIELD_MAP),
  ];
  for (const [toolName, policy] of Object.entries(NATIVE_CHAT_REF_POLICY)) {
    if (policy.inputRefs.length > 0) {
      byTool.set(toolName, policy.inputRefs);
    }
  }
  for (const [toolName, entry] of entries) {
    if (entry.chatProjectable && entry.inputRefs.length > 0) {
      if (byTool.has(toolName)) {
        panic(`Duplicate chat input ref policy: ${toolName}`);
      }
      byTool.set(toolName, entry.inputRefs);
    }
  }
  return byTool;
};

const INPUT_REFS_BY_TOOL = buildInputRefsByTool();

/**
 * The workspace an entity param's ref key needs. Chat's write tools that take
 * an entity id also take the matter it lives in (`save_task`'s `task_id` beside
 * its `matter_id`), so the sibling matter param is the reliable source; without
 * one the registry falls back to a ref it already minted for that entity id.
 */
const findMatterWorkspaceId = ({
  input,
  inputRefs,
}: {
  input: Record<string, unknown>;
  inputRefs: readonly InputRefParam[];
}): unknown => {
  for (const { kind, param } of inputRefs) {
    if (kind === "matter" && typeof input[param] === "string") {
      return input[param];
    }
  }
  return undefined;
};

const findEntityWorkspaceId = ({
  contexts,
  input,
  matterWorkspaceId,
  param,
}: {
  contexts: readonly ChatEntityRefContext[];
  input: Record<string, unknown>;
  matterWorkspaceId: unknown;
  param: string;
}): unknown => {
  if (matterWorkspaceId !== undefined) {
    return matterWorkspaceId;
  }
  const entityId = input[param];
  return contexts.find((context) => context.entity.id === entityId)?.workspace
    .id;
};

export type HydrateRegistryToolInputRefsProps = {
  entityContexts?: readonly ChatEntityRefContext[] | undefined;
  input: unknown;
  inputState: ChatRefInputState;
  refRegistry: ChatRefRegistry;
  toolName: string;
  unresolvedInputRefs?: readonly ChatUnresolvedInputRefContext[] | undefined;
};

export type ResolveRegistryToolInputRefsProps = {
  input: unknown;
  onEntityRefResolved?: ((target: EntityTarget) => void) | undefined;
  onRefUnresolved?:
    | ((
        ref: Pick<ChatUnresolvedInputRefContext, "kind" | "param" | "ref">,
      ) => void)
    | undefined;
  refRegistry: ChatRefRegistry;
  toolName: string;
};

const isKnownRef = ({
  kind,
  ref,
  refRegistry,
}: {
  kind: InputRefParam["kind"];
  ref: string;
  refRegistry: ChatRefRegistry;
}): boolean => {
  switch (kind) {
    case "matter":
      return Result.isOk(refRegistry.resolveMatterRefs([ref]));
    case "entity":
      return Result.isOk(refRegistry.resolveEntityRefTargets([ref]));
    case "property":
      return Result.isOk(refRegistry.resolvePropertyRefs([ref]));
    case "contact":
      return Result.isOk(refRegistry.resolveContactRefs([ref]));
    default:
      kind satisfies never;
      return panic(`Unhandled kind: ${String(kind)}`);
  }
};

/**
 * Persistence-side inverse of `hydrateRegistryToolInputRefs`. Only parameters
 * declared by the registry tool's input-ref policy are resolved; every other
 * opaque value remains untouched even when its text equals a minted ref.
 */
export const resolveRegistryToolInputRefs = ({
  input,
  onEntityRefResolved,
  onRefUnresolved,
  refRegistry,
  toolName,
}: ResolveRegistryToolInputRefsProps): unknown => {
  const inputRefs = INPUT_REFS_BY_TOOL.get(toolName);
  if (inputRefs === undefined || !isRecord(input)) {
    return input;
  }

  const resolved = { ...input };
  for (const { kind, param } of inputRefs) {
    if (!(param in resolved)) {
      continue;
    }
    const value = resolved[param];
    if (
      typeof value === "string" &&
      !isKnownRef({ kind, ref: value, refRegistry })
    ) {
      onRefUnresolved?.({ kind, param, ref: value });
      continue;
    }
    if (
      kind === "entity" &&
      typeof value === "string" &&
      onEntityRefResolved !== undefined
    ) {
      const target = refRegistry.resolveEntityRefTargets([value]);
      if (Result.isOk(target)) {
        const firstTarget = target.value.at(0);
        if (firstTarget !== undefined) {
          onEntityRefResolved(firstTarget);
        }
      }
    }
    resolved[param] = refRegistry.resolveRefId({
      kind,
      value,
    });
  }
  return resolved;
};

export const hydrateRegistryToolInputRefs = ({
  entityContexts = [],
  input,
  inputState,
  refRegistry,
  toolName,
  unresolvedInputRefs = [],
}: HydrateRegistryToolInputRefsProps): unknown => {
  const inputRefs = INPUT_REFS_BY_TOOL.get(toolName);
  if (inputRefs === undefined || !isRecord(input)) {
    return input;
  }

  const matterWorkspaceId = findMatterWorkspaceId({ input, inputRefs });
  const hydrated = { ...input };
  for (const { kind, param } of inputRefs) {
    if (!(param in hydrated)) {
      continue;
    }
    const unresolvedInputRef = unresolvedInputRefs.find(
      (context) => context.param === param,
    );
    if (unresolvedInputRef !== undefined) {
      if (
        unresolvedInputRef.kind !== kind ||
        unresolvedInputRef.ref !== hydrated[param]
      ) {
        panic("Stored unresolved chat reference context does not match input");
      }
      continue;
    }
    hydrated[param] = refRegistry.hydrateRefId({
      inputState,
      kind,
      value: hydrated[param],
      workspaceId:
        kind === "entity"
          ? findEntityWorkspaceId({
              contexts: entityContexts,
              input,
              matterWorkspaceId,
              param,
            })
          : matterWorkspaceId,
    });
  }
  return hydrated;
};
