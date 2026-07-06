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
  InputRefParam,
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

// --- path-aware UUID backstop ------------------------------------------------

export type UuidPathHit = { path: string; value: string };

/**
 * Walk every string leaf in a payload, recording the normalized path (dot-
 * joined, arrays collapsed to `[]`, the same `a.b` / `a[].b` grammar
 * `outputRefs`/`passthroughIdPaths` use) of every value that matches the UUID
 * pattern anywhere in the string. A substring match (not just a bare-UUID
 * exact match) so a UUID embedded inside a longer string (a url, free text)
 * is still caught, matching the whole-payload check this replaces.
 */
const walkUuidPaths = (
  node: unknown,
  path: readonly string[],
  hits: UuidPathHit[],
): void => {
  if (typeof node === "string") {
    if (UUID_ANYWHERE_REGEX.test(node)) {
      hits.push({ path: path.join("."), value: node });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      walkUuidPaths(item, path, hits);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const segment = Array.isArray(value) ? `${key}[]` : key;
    walkUuidPaths(value, [...path, segment], hits);
  }
};

/** Every UUID-matching string value in a payload, with its normalized path. */
export const collectUuidPaths = (payload: unknown): readonly UuidPathHit[] => {
  const hits: UuidPathHit[] = [];
  walkUuidPaths(payload, [], hits);
  return hits;
};

/**
 * Find the first UUID surviving in a hydrated read-tool payload at a path the
 * tool's ref-field-map entry does not license. Only `passthroughIdPaths`
 * grants a path permission to still hold a raw UUID (a declared non-tenant
 * handle); an `outputRefs` path is deliberately excluded from this allowlist,
 * since `hydrateOutputRefs` should have already rewritten it to a chat ref —
 * a UUID still there means hydration missed it, which fails closed the same
 * as a wholly undeclared path. Returns the offending path, never the value,
 * so callers can log it without leaking the id it is refusing.
 */
export const findUndeclaredUuidPathIn = ({
  passthroughIdPaths,
  payload,
}: {
  passthroughIdPaths: readonly string[];
  payload: unknown;
}): string | undefined => {
  const allowedPaths = new Set<string>(passthroughIdPaths);
  return collectUuidPaths(payload).find((hit) => !allowedPaths.has(hit.path))
    ?.path;
};

export const findUndeclaredUuidPath = ({
  toolName,
  payload,
}: {
  toolName: RegistryReadToolName;
  payload: unknown;
}): string | undefined =>
  findUndeclaredUuidPathIn({
    passthroughIdPaths: READ_TOOL_REF_FIELD_MAP[toolName].passthroughIdPaths,
    payload,
  });

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
  /**
   * Resolved workspace uuid per entity input param, for output entities that
   * are *different* from the input entity but share its workspace (e.g. a
   * task's linked entities). `resolvedMatterParams` covers the reverse case
   * (workspace named directly); this covers the entity-ref case, where the
   * workspace is recovered from the ref the caller already resolved rather
   * than from a fresh lookup.
   */
  resolvedEntityParams: Record<string, SafeId<"workspace">>;
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
  const resolvedMatterParams: Record<string, SafeId<"workspace">> = {};
  const resolvedEntityParams: Record<string, SafeId<"workspace">> = {};
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
    inputRefs: READ_TOOL_REF_FIELD_MAP[toolName].inputRefs,
    args,
    refRegistry,
  });

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
  if (source.from === "inputEntityWorkspace") {
    return dehydration.resolvedEntityParams[source.param];
  }
  // "inputEntity": the output entity is the request's own entity input, so its
  // ref is minted from the reuse map below, never from a workspace lookup.
  source.from satisfies "inputEntity";
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
 * Rewrite every tenant UUID a projected tool emits into its chat ref, in place,
 * driven by the passed output ref fields. The payload is the caller-owned
 * JSON.parsed object, so it is mutated and returned. Fields left un-refed
 * (non-tenant handles, deferred entity ids) are untouched. Shared by the read
 * and write orchestrators, each supplying its own tool's `outputRefs`.
 */
export const hydrateRefs = ({
  outputRefs,
  output,
  refRegistry,
  dehydration,
}: {
  outputRefs: readonly OutputRefField[];
  output: unknown;
  refRegistry: ChatRefRegistry;
  dehydration: DehydratedInput;
}): unknown => {
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

/**
 * Rewrite every tenant UUID a projected read tool emits into its chat ref, in
 * place, driven by the read tool's declared output ref fields. Delegates to
 * `hydrateRefs` with the read tool's `outputRefs`.
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
}): unknown =>
  hydrateRefs({
    outputRefs: READ_TOOL_REF_FIELD_MAP[toolName].outputRefs,
    output,
    refRegistry,
    dehydration,
  });
