import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ChatRefInputState } from "@/api/lib/chat/ref-token";

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
 * with its input refs already resolved to real ids
 * (`resolveAssistantMessageRefs`); a `mat_3` written into the row would point
 * at whatever the *next* turn happened to number third. Replaying that row
 * therefore has to mint the ref again, or the call reaches `dehydrateRefs` as a
 * raw UUID it cannot resolve, and reaches the model as an id the ingress guard
 * redacts.
 *
 * `hydrateAssistantValueRefs` cannot do this on its own: it recognizes the
 * *output* projection's key names (`matterRef`, `entityRef`, ...), while a tool
 * call's input params are named per tool (`matter_id`, `task_id`). The kinds
 * come from the same declared map that drives dehydration, so the two sides
 * cannot drift.
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
  for (const [toolName, entry] of entries) {
    if (entry.chatProjectable && entry.inputRefs.length > 0) {
      byTool.set(toolName, entry.inputRefs);
    }
  }
  return byTool;
};

const INPUT_REFS_BY_TOOL = buildInputRefsByTool();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The workspace an entity param's ref key needs. Chat's write tools that take
 * an entity id also take the matter it lives in (`save_task`'s `task_id` beside
 * its `matter_id`), so the sibling matter param is the reliable source; without
 * one the registry falls back to a ref it already minted for that entity id.
 */
const findWorkspaceId = ({
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

export type HydrateRegistryToolInputRefsProps = {
  input: unknown;
  inputState: ChatRefInputState;
  refRegistry: ChatRefRegistry;
  toolName: string;
};

export type ResolveRegistryToolInputRefsProps = {
  input: unknown;
  refRegistry: ChatRefRegistry;
  toolName: string;
};

/**
 * Persistence-side inverse of `hydrateRegistryToolInputRefs`. Only parameters
 * declared by the registry tool's input-ref policy are resolved; every other
 * opaque value remains untouched even when its text equals a minted ref.
 */
export const resolveRegistryToolInputRefs = ({
  input,
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
    resolved[param] = refRegistry.resolveRefId({
      kind,
      value: resolved[param],
    });
  }
  return resolved;
};

export const hydrateRegistryToolInputRefs = ({
  input,
  inputState,
  refRegistry,
  toolName,
}: HydrateRegistryToolInputRefsProps): unknown => {
  const inputRefs = INPUT_REFS_BY_TOOL.get(toolName);
  if (inputRefs === undefined || !isRecord(input)) {
    return input;
  }

  const workspaceId = findWorkspaceId({ input, inputRefs });
  const hydrated = { ...input };
  for (const { kind, param } of inputRefs) {
    if (!(param in hydrated)) {
      continue;
    }
    hydrated[param] = refRegistry.hydrateRefId({
      inputState,
      kind,
      value: hydrated[param],
      workspaceId,
    });
  }
  return hydrated;
};
