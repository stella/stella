import { panic, Result } from "better-result";

import type { DehydratedInput } from "@/api/lib/chat/projection-schema";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ChatToolError } from "@/api/lib/errors/tagged-errors";

import type {
  InputRefParam,
  RefMediationEntry,
  RegistryReadToolName,
} from "./ref-field-map";
import { READ_TOOL_REF_FIELD_MAP } from "./ref-field-map";

/**
 * Input-side ref mediation: replace the chat refs a model passes as tool args
 * with the real UUIDs the registry handlers expect. The output side (strip,
 * hydrate, UUID invariant) lives in `projectForChat`
 * (`projection-schema.ts`), which consumes the `DehydratedInput` produced
 * here.
 */

/**
 * The chat-projected read entry for a tool name, for the read-tool
 * convenience wrapper below. The orchestrator refuses a non-projectable
 * tool before any mediation runs, so reaching this with one is programmer
 * misuse, not a data case: it panics rather than falling back.
 */
const requireProjectableReadEntry = (
  toolName: RegistryReadToolName,
): RefMediationEntry => {
  const entry = READ_TOOL_REF_FIELD_MAP[toolName];
  if (!entry.chatProjectable) {
    panic(`Read tool ${toolName} is not chat-projectable`);
  }
  return entry;
};

const takeSingle = <T>(values: readonly T[]): T =>
  values.at(0) ?? panic("resolved ref list is unexpectedly empty");

/**
 * Replace every input ref arg (`mat_N`/`ent_N`/`contact_N`/`prop_N`) with the
 * real UUID the registry handler expects, via the chat ref registry. An unknown
 * ref surfaces as the registry's own `ChatToolError`. Records the resolved
 * workspace ids and entity refs so output hydration can mint entity refs and
 * reuse the request's own entity ref.
 */
export const dehydrateRefs = ({
  inputRefs,
  args,
  refRegistry,
}: {
  inputRefs: readonly InputRefParam[];
  args: Record<string, unknown>;
  refRegistry: ChatRefRegistry;
}): Result<DehydratedInput, ChatToolError> => {
  const nextArgs = { ...args };
  const resolvedMatterParams: DehydratedInput["resolvedMatterParams"] = {};
  const resolvedEntityParams: DehydratedInput["resolvedEntityParams"] = {};
  const dehydratedEntityRefs = new Map<string, string>();

  for (const { kind, param } of inputRefs) {
    const raw = args[param];
    if (typeof raw !== "string") {
      // The param is optional and absent (or already a non-ref value); nothing
      // to resolve.
      continue;
    }

    if (kind === "matter") {
      const resolved = refRegistry.resolveMatterRefs([raw]);
      if (Result.isError(resolved)) {
        return Result.err(resolved.error);
      }
      const workspaceId = takeSingle(resolved.value);
      nextArgs[param] = workspaceId;
      resolvedMatterParams[param] = workspaceId;
      continue;
    }
    if (kind === "entity") {
      const resolved = refRegistry.resolveEntityRefTargets([raw]);
      if (Result.isError(resolved)) {
        return Result.err(resolved.error);
      }
      const { entityId, workspaceId } = takeSingle(resolved.value);
      nextArgs[param] = entityId;
      resolvedEntityParams[param] = workspaceId;
      dehydratedEntityRefs.set(entityId, raw);
      continue;
    }
    if (kind === "property") {
      // Only the write tool set_field_value declares a `property` input ref;
      // no read tool does. Resolving it here keeps input dehydration uniform
      // across the read and write callers that share this core.
      const resolved = refRegistry.resolvePropertyRefs([raw]);
      if (Result.isError(resolved)) {
        return Result.err(resolved.error);
      }
      nextArgs[param] = takeSingle(resolved.value);
      continue;
    }
    // `contact` is the only remaining ref kind; the exhaustiveness check makes
    // a newly added kind break here until its branch is written.
    kind satisfies "contact";
    const resolved = refRegistry.resolveContactRefs([raw]);
    if (Result.isError(resolved)) {
      return Result.err(resolved.error);
    }
    nextArgs[param] = takeSingle(resolved.value);
  }

  return Result.ok({
    args: nextArgs,
    resolvedMatterParams,
    resolvedEntityParams,
    dehydratedEntityRefs,
  });
};

/**
 * Replace every input ref arg (`mat_N`/`ent_N`/`contact_N`/`prop_N`) with the
 * real UUID the registry read handler expects, via the chat ref registry. An
 * unknown ref surfaces as the registry's own `ChatToolError`. Delegates to
 * `dehydrateRefs` with the read tool's declared input refs.
 */
export const dehydrateInputRefs = ({
  toolName,
  args,
  refRegistry,
}: {
  toolName: RegistryReadToolName;
  args: Record<string, unknown>;
  refRegistry: ChatRefRegistry;
}): Result<DehydratedInput, ChatToolError> =>
  dehydrateRefs({
    inputRefs: requireProjectableReadEntry(toolName).inputRefs,
    args,
    refRegistry,
  });
