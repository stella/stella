import { panic, Result } from "better-result";

import type { DehydratedInput } from "@/api/lib/chat/projection-schema";
import type { ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import type { ChatToolError } from "@/api/lib/errors/tagged-errors";

import { mapInputRefLeaves } from "./input-ref-path";
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
  const resolvedMatterParams: DehydratedInput["resolvedMatterParams"] = {};
  const resolvedEntityParams: DehydratedInput["resolvedEntityParams"] = {};
  const dehydratedEntityRefs = new Map<string, string>();

  type ResolveLeafArgs = {
    kind: InputRefParam["kind"];
    raw: string;
    location: string;
  };

  const resolveLeaf = ({
    kind,
    raw,
    location,
  }: ResolveLeafArgs): Result<string, ChatToolError> => {
    if (kind === "matter") {
      return refRegistry.resolveMatterRefs([raw]).map((resolved) => {
        const workspaceId = takeSingle(resolved);
        resolvedMatterParams[location] = workspaceId;
        return workspaceId;
      });
    }
    if (kind === "entity") {
      return refRegistry.resolveEntityRefTargets([raw]).map((resolved) => {
        const { entityId, workspaceId } = takeSingle(resolved);
        resolvedEntityParams[location] = workspaceId;
        dehydratedEntityRefs.set(entityId, raw);
        return entityId;
      });
    }
    if (kind === "property") {
      // Only the write tool set_field_value declares a `property` input ref;
      // no read tool does. Resolving it here keeps input dehydration uniform
      // across the read and write callers that share this core.
      return refRegistry.resolvePropertyRefs([raw]).map(takeSingle);
    }
    // `contact` is the only remaining ref kind; the exhaustiveness check makes
    // a newly added kind break here until its branch is written.
    kind satisfies "contact";
    return refRegistry.resolveContactRefs([raw]).map(takeSingle);
  };

  let nextArgs = args;
  for (const { kind, param } of inputRefs) {
    // The first ref that fails to resolve fails the whole call.
    // `mapInputRefLeaves` cannot stop early, so the remaining values are
    // still visited but returned unchanged.
    let failure: ChatToolError | undefined;
    nextArgs = mapInputRefLeaves({
      input: nextArgs,
      path: param,
      mapLeaf: (raw, location) => {
        if (failure !== undefined || typeof raw !== "string") {
          // Nothing to resolve: an earlier ref already failed, or this
          // value is not a string and so is not a ref.
          return raw;
        }
        const resolved = resolveLeaf({ kind, raw, location });
        if (Result.isError(resolved)) {
          failure = resolved.error;
          return raw;
        }
        return resolved.value;
      },
    });
    if (failure !== undefined) {
      return Result.err(failure);
    }
  }

  return Result.ok({
    args: { ...nextArgs },
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
