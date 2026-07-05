import { panic, Result } from "better-result";

import type { ChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import type { SafeId } from "@/api/lib/branded-types";
import type { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  brandPersistedContactId,
  brandPersistedEntityId,
  brandPersistedPropertyId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";

import type {
  EntityWorkspaceSource,
  OutputRefField,
  RegistryReadToolName,
} from "./ref-field-map";
import { READ_TOOL_REF_FIELD_MAP } from "./ref-field-map";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUID_ANYWHERE_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

const isUuidString = (value: unknown): value is string =>
  typeof value === "string" && UUID_REGEX.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A verbatim-UUID guard for the "no tenant UUID reaches the model" invariant.
 * After ref hydration a projected read tool's payload must serialize without any
 * raw UUID: every tenant id is a ref and every non-tenant handle in the map's
 * `passthroughIdPaths` is documented as either non-UUID-formatted (opaque
 * cursors) or an out-of-band handle. Tests assert this holds.
 */
export const containsRawUuid = (value: unknown): boolean =>
  UUID_ANYWHERE_REGEX.test(JSON.stringify(value));

// --- path grammar -----------------------------------------------------------
// Paths use the same `a.b` / `a[].b` shape as the egress text-field specs. A
// step is one dotted token; a `[]` suffix means "descend into the array at this
// key, then continue into each item". The final step is always a scalar key.

type PathStep = { key: string; array: boolean };

const parsePath = (path: string): readonly PathStep[] =>
  path.split(".").map((token) => {
    const array = token.endsWith("[]");
    return { key: array ? token.slice(0, -2) : token, array };
  });

/**
 * Visit every `(container, key)` slot a path resolves to, mutating in place. The
 * caller owns the parsed JSON payload, so in-place edits are safe. Missing or
 * wrong-typed intermediates are skipped rather than thrown: a tool's optional
 * branch (list vs. detail) simply produces no slots for the other branch's
 * paths.
 */
const visitPathSlots = (
  root: unknown,
  steps: readonly PathStep[],
  visit: (container: Record<string, unknown>, key: string) => void,
): void => {
  const [step, ...rest] = steps;
  if (step === undefined || !isRecord(root)) {
    return;
  }
  if (rest.length === 0) {
    visit(root, step.key);
    return;
  }
  const child = root[step.key];
  if (step.array) {
    if (Array.isArray(child)) {
      for (const item of child) {
        visitPathSlots(item, rest, visit);
      }
    }
    return;
  }
  visitPathSlots(child, rest, visit);
};

/** Read the first scalar a (non-array) absolute path resolves to. */
const readScalarAtPath = (root: unknown, path: string): unknown => {
  let cursor: unknown = root;
  for (const step of parsePath(path)) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[step.key];
  }
  return cursor;
};

// --- input dehydration ------------------------------------------------------

export type DehydratedInput = {
  args: Record<string, unknown>;
  /** Resolved workspace uuid per matter input param, for entity output refs. */
  resolvedMatterParams: Record<string, SafeId<"workspace">>;
  /** entity uuid -> the ref it was dehydrated from, for reuse on output. */
  dehydratedEntityRefs: Map<string, string>;
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
export const dehydrateInputRefs = ({
  toolName,
  args,
  refRegistry,
}: {
  toolName: RegistryReadToolName;
  args: Record<string, unknown>;
  refRegistry: ChatRefRegistry;
}): Result<DehydratedInput, ChatToolError> => {
  const nextArgs = { ...args };
  const resolvedMatterParams: Record<string, SafeId<"workspace">> = {};
  const dehydratedEntityRefs = new Map<string, string>();

  for (const { kind, param } of READ_TOOL_REF_FIELD_MAP[toolName].inputRefs) {
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
      const resolved = refRegistry.resolveEntityRefs([raw]);
      if (Result.isError(resolved)) {
        return Result.err(resolved.error);
      }
      const entityId = takeSingle(resolved.value);
      nextArgs[param] = entityId;
      dehydratedEntityRefs.set(entityId, raw);
      continue;
    }
    // `contact` is the only remaining input ref kind across the read tools; no
    // read tool declares a `property` input ref (only the write tool
    // set_field_value does). Adding one would widen `kind` here and break this
    // `satisfies`, forcing the extra branch to be written.
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
    dehydratedEntityRefs,
  });
};

// --- output hydration -------------------------------------------------------

const resolveEntityWorkspaceUuid = ({
  container,
  dehydration,
  root,
  source,
}: {
  container: Record<string, unknown>;
  dehydration: DehydratedInput;
  root: unknown;
  source: EntityWorkspaceSource;
}): unknown => {
  if (source.from === "sibling") {
    return container[source.key];
  }
  if (source.from === "outputPath") {
    return readScalarAtPath(root, source.path);
  }
  if (source.from === "inputParam") {
    return dehydration.resolvedMatterParams[source.param];
  }
  // "inputEntity": the output entity is the request's own entity input, so its
  // ref is minted from the reuse map below, never from a workspace lookup.
  return undefined;
};

const hydrateEntitySlot = ({
  container,
  dehydration,
  key,
  refRegistry,
  root,
  source,
}: {
  container: Record<string, unknown>;
  dehydration: DehydratedInput;
  key: string;
  refRegistry: ChatRefRegistry;
  root: unknown;
  source: EntityWorkspaceSource;
}): void => {
  const value = container[key];
  if (!isUuidString(value)) {
    return;
  }

  // The output entity IS one the request named on input: reuse the ref already
  // minted for it, so no workspace lookup is needed.
  const reused = dehydration.dehydratedEntityRefs.get(value);
  if (reused !== undefined) {
    container[key] = reused;
    return;
  }

  const workspaceUuid = resolveEntityWorkspaceUuid({
    container,
    dehydration,
    root,
    source,
  });
  if (!isUuidString(workspaceUuid)) {
    // Owning workspace not recoverable for this field (a deferred case, tracked
    // in the map's passthroughIdPaths); leave the id untouched rather than mint
    // a ref against a guessed workspace.
    return;
  }

  container[key] = refRegistry.toEntityRef({
    entityId: brandPersistedEntityId(value),
    workspaceId: brandPersistedWorkspaceId(workspaceUuid),
  });
};

const hydrateSimpleSlot = ({
  container,
  field,
  key,
  refRegistry,
}: {
  container: Record<string, unknown>;
  field: Extract<OutputRefField, { kind: "matter" | "contact" | "property" }>;
  key: string;
  refRegistry: ChatRefRegistry;
}): void => {
  const value = container[key];
  if (!isUuidString(value)) {
    return;
  }
  if (field.kind === "matter") {
    container[key] = refRegistry.toMatterRef(brandPersistedWorkspaceId(value));
    return;
  }
  if (field.kind === "contact") {
    container[key] = refRegistry.toContactRef(brandPersistedContactId(value));
    return;
  }
  container[key] = refRegistry.toPropertyRef(brandPersistedPropertyId(value));
};

/**
 * Rewrite every tenant UUID a projected read tool emits into its chat ref, in
 * place, driven by the tool's declared output ref fields. The payload is the
 * caller-owned JSON.parsed object, so it is mutated and returned. Fields the map
 * leaves un-refed (non-tenant handles, deferred entity ids) are untouched.
 */
export const hydrateOutputRefs = ({
  toolName,
  output,
  refRegistry,
  dehydration,
}: {
  toolName: RegistryReadToolName;
  output: unknown;
  refRegistry: ChatRefRegistry;
  dehydration: DehydratedInput;
}): unknown => {
  const { outputRefs } = READ_TOOL_REF_FIELD_MAP[toolName];

  // Entity refs first: an entity's `sibling`/`outputPath` workspace source reads
  // a workspace UUID that a matter ref in the same payload would otherwise
  // overwrite with a `mat_N` ref before the entity ref is minted.
  for (const field of outputRefs) {
    if (field.kind !== "entity") {
      continue;
    }
    visitPathSlots(output, parsePath(field.path), (container, key) => {
      hydrateEntitySlot({
        container,
        dehydration,
        key,
        refRegistry,
        root: output,
        source: field.workspace,
      });
    });
  }

  for (const field of outputRefs) {
    if (field.kind === "entity") {
      continue;
    }
    visitPathSlots(output, parsePath(field.path), (container, key) => {
      hydrateSimpleSlot({ container, field, key, refRegistry });
    });
  }

  return output;
};
