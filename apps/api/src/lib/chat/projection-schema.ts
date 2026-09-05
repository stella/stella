import { panic, Result } from "better-result";
import * as v from "valibot";

import { isSafeIdValue } from "@stll/api-contract/safe-id";

import { captureError } from "@/api/lib/analytics/capture";
import type { SafeId } from "@/api/lib/branded-types";
import { isPersistedJsonValue } from "@/api/lib/chat/persisted-message-content";
import type { ChatRefKind, ChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { ChatToolError } from "@/api/lib/errors/tagged-errors";
import {
  brandPersistedContactId,
  brandPersistedEntityId,
  brandPersistedPropertyId,
  brandPersistedWorkspaceId,
} from "@/api/lib/safe-id-boundaries";
import { isRecord } from "@/api/lib/type-guards";

/**
 * Chat projection schemas: one Valibot `strictObject` per converted tool that
 * describes exactly what the chat surface forwards, with each id-bearing
 * field's chat semantics attached via `v.metadata`. `projectForChat` applies a
 * schema in a single pass: one strict parse (an unknown handler field fails
 * closed, structurally unable to reach the model), then one walk over the
 * parsed value guided by the same annotations that strips declared fields,
 * hydrates tenant UUIDs into chat refs, and enforces the "no raw tenant UUID
 * reaches the model" invariant together — so the shape and its ref decisions
 * cannot drift apart the way a hand-maintained path list can.
 *
 * Lives in `lib/` rather than the chat handler slice because the MCP tool
 * handlers (`@/api/mcp/*-tools.ts`) import their own projection to tie payload
 * literals at compile time. handlers -> lib is the only correct direction: the
 * reverse would make the shared MCP core depend on the chat slice, and
 * `lib-to-handler-imports` is a ratcheted metric. Keep this module's imports
 * limited to `@/api/lib/*`, valibot, and better-result so that stays true.
 */

// --- Ref vocabulary -----------------------------------------------------------
// The id-kind types the annotations carry. They live here (not in
// ref-field-map.ts) so this module has no import back into the map and the
// module graph stays cycle-free; the map imports the vocabulary from here.

/**
 * The four tenant-content id kinds the chat ref registry mediates. Re-exported
 * from `ref-registry.ts` rather than restated: the registry is the lowest
 * module that must know all four (it keys one ref state per kind), and a second
 * declaration here would be a hand-maintained mirror of that set.
 */
export type { ChatRefKind as RegistryRefKind } from "@/api/lib/chat/ref-registry";
type RegistryRefKind = ChatRefKind;

export type SimpleRefKind = Exclude<RegistryRefKind, "entity">;

/**
 * How an entity output ref recovers its owning workspace id, which
 * `toEntityRef` needs alongside the entity id. MCP handlers name these fields
 * differently per tool (a sibling `workspaceId`, a fixed `matter.id`, or the
 * tool's resolved `matter_id` input), so the source is declared per field
 * rather than guessed from key names.
 */
export type EntityWorkspaceSource =
  | { from: "sibling"; key: string }
  | { from: "outputPath"; path: string }
  | { from: "inputParam"; param: string }
  // The output entity is a *different* entity than the request's own entity
  // input named by `param`, but is validated (at write time, outside this
  // orchestrator) to share its workspace, e.g. a task's linked entities. The
  // workspace is the one already resolved when `param`'s ref was dehydrated,
  // not a fresh lookup.
  | { from: "inputEntityWorkspace"; param: string }
  // The output entity IS the request's own entity input; the orchestrator
  // reuses the ref it dehydrated on the way in, so no workspace lookup runs.
  | { from: "inputEntity"; param: string };

/**
 * One UUID-bearing output path and the tenant ref kind it carries. `path` uses
 * the same `a.b` / `a[].b` grammar as the egress text-field specs. Entity
 * fields additionally declare where their owning workspace id lives.
 */
export type OutputRefField =
  | { kind: SimpleRefKind; path: string }
  | { kind: "entity"; path: string; workspace: EntityWorkspaceSource };

/**
 * The three output-side path lists derived from a projection schema's
 * annotations. The forward runtime transform (`projectForChat`) walks the
 * annotations directly; persistence resolution consumes `outputRefs` as the
 * inverse path policy. The contract corpus also derives all three lists to
 * prove its fixtures exercise every declared ref path and that every declared
 * strip path is absent from the projected payload (its anti-vacuity guard).
 */
export type RefMediationLists = {
  outputRefs: readonly OutputRefField[];
  /**
   * UUID-bearing output paths intentionally left un-refed: non-tenant handles
   * (user/invoice/template/audit/public-corpus ids) or opaque cursors. These
   * are the positions licensed to survive the runtime UUID invariant; an
   * `outputRefs` path is deliberately NOT part of it — hydration must have
   * already rewritten it, so a uuid still there fails closed.
   */
  passthroughIdPaths: readonly string[];
  /**
   * Output paths deleted from the chat projection before the payload reaches
   * the model: ids other surfaces need (web-UI field/file plumbing handles)
   * that chat cannot act on.
   */
  stripPaths: readonly string[];
};

// --- Annotated field wrappers ---------------------------------------------------

/**
 * The chat semantics one projected field carries, stored under
 * `CHAT_PROJECTION_METADATA_KEY` in the field schema's `v.metadata` pipe item
 * and read back by the schema walker below.
 */
const workspaceSourceSchema = v.variant("from", [
  v.strictObject({ from: v.literal("sibling"), key: v.string() }),
  v.strictObject({ from: v.literal("outputPath"), path: v.string() }),
  v.strictObject({ from: v.literal("inputParam"), param: v.string() }),
  v.strictObject({
    from: v.literal("inputEntityWorkspace"),
    param: v.string(),
  }),
  v.strictObject({ from: v.literal("inputEntity"), param: v.string() }),
]);

const annotationSchema = v.variant("role", [
  v.strictObject({
    role: v.literal("ref"),
    kind: v.picklist(["matter", "contact", "property"]),
  }),
  v.strictObject({
    role: v.literal("entityRef"),
    workspace: workspaceSourceSchema,
  }),
  v.strictObject({ role: v.literal("passthroughId") }),
  v.strictObject({ role: v.literal("strip") }),
  v.strictObject({ role: v.literal("json") }),
]);

type ChatProjectionAnnotation = v.InferOutput<typeof annotationSchema>;

const CHAT_PROJECTION_METADATA_KEY = "chatProjection";

/**
 * The widened schema type used by the runtime projection registry. Individual
 * annotated field builders retain their inferred input/output types so the
 * same schemas can provide precise handler contracts at compile time; only the
 * heterogeneous registry boundary widens them for AST walking.
 */
export type ChatProjectionSchema = v.GenericSchema<
  Record<string, unknown>,
  Record<string, unknown>
>;

const selectedProjectionBranches = new WeakMap<
  Record<string, unknown>,
  ChatProjectionSchema
>();

const projectionBranchSources = new WeakMap<
  v.GenericSchema,
  ChatProjectionSchema
>();

/**
 * Mark one union/variant option as a projection branch. Its Valibot transform
 * records which schema produced the canonical output object during the one
 * strict parse; the annotation walk can then follow that branch without
 * validating it again.
 */
export const projectionBranch = <TSchema extends ChatProjectionSchema>(
  schema: TSchema,
) => {
  const branch = v.pipe(
    schema,
    v.transform((output) => {
      selectedProjectionBranches.set(output, schema);
      return output;
    }),
  );
  projectionBranchSources.set(branch, schema);
  return branch;
};

type SimpleRefId<TKind extends SimpleRefKind> = {
  contact: SafeId<"contact">;
  matter: SafeId<"workspace">;
  property: SafeId<"property">;
}[TKind];

/** A tenant id field hydrated into a `mat_N`/`contact_N`/`prop_N` chat ref. */
export const chatRef = <TKind extends SimpleRefKind>(kind: TKind) =>
  v.pipe(
    v.custom<SimpleRefId<TKind>>(
      (value) => typeof value === "string" && isSafeIdValue(value),
      `Expected a ${kind} identifier`,
    ),
    v.metadata({ [CHAT_PROJECTION_METADATA_KEY]: { role: "ref", kind } }),
  );

/**
 * A tenant entity id field hydrated into an `ent_N` chat ref, declaring where
 * its owning workspace id is recovered from.
 */
export const chatEntityRef = (workspace: EntityWorkspaceSource) =>
  v.pipe(
    v.custom<SafeId<"entity">>(
      (value) => typeof value === "string" && isSafeIdValue(value),
      "Expected an entity identifier",
    ),
    v.metadata({
      [CHAT_PROJECTION_METADATA_KEY]: { role: "entityRef", workspace },
    }),
  );

/**
 * A non-tenant handle (user/version/link/library id, opaque cursor) the model
 * may pass back verbatim; licensed to survive the runtime UUID backstop.
 */
export const passthroughId = () =>
  v.pipe(
    v.string(),
    v.metadata({ [CHAT_PROJECTION_METADATA_KEY]: { role: "passthroughId" } }),
  );

/**
 * A field other surfaces need but chat deletes from the projection before the
 * payload reaches the model (web-UI field/file plumbing handles). `v.unknown()`
 * base: the strict parse admits it at its declared key, then the derived
 * `stripPaths` remove it.
 */
export const strippedField = () =>
  v.pipe(
    v.unknown(),
    v.metadata({ [CHAT_PROJECTION_METADATA_KEY]: { role: "strip" } }),
  );

/**
 * A free-form JSON subtree the schema cannot enumerate by path: public-source
 * jsonb (`decision.metadata`), an external API envelope (BOE sections,
 * registry `details`), or a structural config with no stable leaf grammar
 * (playbook ask content, condition ASTs). Its annotation tells the walker to
 * record no mediation paths but to scan every nested string for unlicensed
 * UUIDs. A UUID-shaped value therefore fails closed exactly as it did under
 * the hand-written entries, which never enumerated these subtrees either. The
 * schema also proves that the subtree is canonical JSON, so direct typed
 * execution cannot smuggle cycles, bigint, functions, symbols, or non-finite
 * numbers past the former MCP serialization boundary.
 */
export const unenumeratedJson = () =>
  v.pipe(
    v.unknown(),
    v.rawTransform(({ addIssue, dataset, NEVER }) => {
      if (!isPersistedJsonValue(dataset.value)) {
        addIssue({ message: "Expected a canonical JSON value" });
        return NEVER;
      }
      return dataset.value;
    }),
    v.metadata({ [CHAT_PROJECTION_METADATA_KEY]: { role: "json" } }),
  );

// --- Schema AST walking ---------------------------------------------------------
// Valibot schemas are plain objects: `v.pipe` spreads its base schema and adds
// a `pipe` array whose items include `{ type: "metadata", metadata }` actions;
// wrappers carry `wrapped`; objects carry `entries`; arrays carry `item`;
// unions/variants carry `options`. The walker reads that runtime AST through
// structural guards, so it needs no valibot generics at all.

const isSchemaNode = (value: unknown): value is v.GenericSchema =>
  isRecord(value) &&
  value["kind"] === "schema" &&
  typeof value["type"] === "string";

// Memoized per schema node: `projectForChat` reads annotations on every
// request's walk, and a node's annotation never changes after construction.
// `null` records a node checked and found unannotated.
const annotationCache = new WeakMap<
  Record<string, unknown>,
  ChatProjectionAnnotation | null
>();

/** Read the chat annotation off a schema node's metadata pipe items, if any. */
const readAnnotation = (
  node: Record<string, unknown>,
): ChatProjectionAnnotation | undefined => {
  const cached = annotationCache.get(node);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  const annotation = parseAnnotation(node);
  annotationCache.set(node, annotation ?? null);
  return annotation;
};

const parseAnnotation = (
  node: Record<string, unknown>,
): ChatProjectionAnnotation | undefined => {
  const pipe = node["pipe"];
  if (!Array.isArray(pipe)) {
    return undefined;
  }
  for (const item of pipe) {
    if (!isRecord(item) || item["type"] !== "metadata") {
      continue;
    }
    const metadata = item["metadata"];
    if (!isRecord(metadata)) {
      continue;
    }
    const raw = metadata[CHAT_PROJECTION_METADATA_KEY];
    if (raw === undefined) {
      continue;
    }
    const parsed = v.safeParse(annotationSchema, raw);
    if (!parsed.success) {
      panic("chat projection metadata does not match the annotation shape");
    }
    return parsed.output;
  }
  return undefined;
};

const WRAPPER_TYPES = new Set([
  "optional",
  "exact_optional",
  "nullable",
  "nullish",
  "undefinedable",
  "non_optional",
  "non_nullable",
  "non_nullish",
]);

const OBJECT_TYPES = new Set([
  "object",
  "strict_object",
  "loose_object",
  "object_with_rest",
]);

const UNION_TYPES = new Set(["union", "variant"]);

const asSchemaNode = (value: unknown): Record<string, unknown> =>
  isRecord(value) ? value : panic("expected a valibot schema node");

type AnnotationVisitor = (
  path: string,
  annotation: ChatProjectionAnnotation,
) => void;

/**
 * Walk one object-field value schema under `key`, recording annotated leaves
 * in the `a.b` / `a[].b` grammar the derived lists use. Wrappers are
 * transparent; an array descends as `key[]` into its item; unions merge every
 * option's contributions (the grammar has no discriminator — the paths are
 * allowlists, so a path only one variant produces is simply absent from the
 * other variant's payloads).
 */
const walkFieldSchema = (
  value: unknown,
  segments: readonly string[],
  key: string,
  visit: AnnotationVisitor,
): void => {
  const node = asSchemaNode(value);
  const annotation = readAnnotation(node);
  if (annotation !== undefined) {
    visit([...segments, key].join("."), annotation);
    return;
  }
  if (typeof node["type"] === "string" && WRAPPER_TYPES.has(node["type"])) {
    walkFieldSchema(node["wrapped"], segments, key, visit);
    return;
  }
  if (node["type"] === "array") {
    const item = asSchemaNode(node["item"]);
    if (readAnnotation(item) !== undefined) {
      panic(
        "the ref path grammar cannot address annotated array items; annotate an object field instead",
      );
    }
    walkContainerSchema(item, [...segments, `${key}[]`], visit);
    return;
  }
  walkContainerSchema(node, [...segments, key], visit);
};

/** Walk a non-leaf schema (object, union, wrapped container) at `segments`. */
const walkContainerSchema = (
  value: unknown,
  segments: readonly string[],
  visit: AnnotationVisitor,
): void => {
  const node = asSchemaNode(value);
  const nodeType = node["type"];
  if (typeof nodeType !== "string") {
    panic("valibot schema node has no type");
  }
  if (WRAPPER_TYPES.has(nodeType)) {
    walkContainerSchema(node["wrapped"], segments, visit);
    return;
  }
  if (UNION_TYPES.has(nodeType)) {
    const options = node["options"];
    if (!Array.isArray(options)) {
      panic("union schema node has no options array");
    }
    for (const option of options) {
      if (!isSchemaNode(option)) {
        panic("union option is not a valibot schema");
      }
      if (!projectionBranchSources.has(option)) {
        panic(
          "chat projection union option is not wrapped in projectionBranch",
        );
      }
      walkContainerSchema(option, segments, visit);
    }
    return;
  }
  if (OBJECT_TYPES.has(nodeType)) {
    const entries = node["entries"];
    if (!isRecord(entries)) {
      panic("object schema node has no entries record");
    }
    for (const [key, child] of Object.entries(entries)) {
      walkFieldSchema(child, segments, key, visit);
    }
    return;
  }
  if (nodeType === "array") {
    panic("the ref path grammar cannot address nested arrays");
  }
  if (nodeType === "unknown") {
    panic(
      "unknown chat projection fields must use strippedField or unenumeratedJson",
    );
  }
  // A scalar leaf (string/number/boolean/literal/picklist/null):
  // ordinary data, nothing to record.
};

// --- Deriving the mediation lists -------------------------------------------------

const sameRefField = (a: OutputRefField, b: OutputRefField): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

const buildMediationLists = (
  schema: ChatProjectionSchema,
): RefMediationLists => {
  const outputRefsByPath = new Map<string, OutputRefField>();
  const passthroughIdPaths = new Set<string>();
  const stripPaths = new Set<string>();

  const recordRefField = (field: OutputRefField): void => {
    const existing = outputRefsByPath.get(field.path);
    if (existing !== undefined && !sameRefField(existing, field)) {
      panic(
        `conflicting chat projection annotations at output path ${field.path}`,
      );
    }
    outputRefsByPath.set(field.path, field);
  };

  walkContainerSchema(schema, [], (path, annotation) => {
    switch (annotation.role) {
      case "ref": {
        recordRefField({ kind: annotation.kind, path });
        return;
      }
      case "entityRef": {
        recordRefField({
          kind: "entity",
          path,
          workspace: annotation.workspace,
        });
        return;
      }
      case "passthroughId": {
        passthroughIdPaths.add(path);
        return;
      }
      case "strip": {
        stripPaths.add(path);
        return;
      }
      case "json": {
        return;
      }
      default: {
        annotation satisfies never;
        panic(`Unhandled annotation: ${String(annotation)}`);
      }
    }
  });

  return {
    outputRefs: [...outputRefsByPath.values()],
    passthroughIdPaths: [...passthroughIdPaths],
    stripPaths: [...stripPaths],
  };
};

const mediationListsCache = new WeakMap<
  ChatProjectionSchema,
  RefMediationLists
>();

/**
 * Mechanically derive a converted tool's `outputRefs`/`passthroughIdPaths`/
 * `stripPaths` from its projection schema's annotations. `projectForChat`
 * reads annotations directly; reverse persistence resolution consumes the
 * ref paths, and the contract corpus consumes all paths for its
 * declared-vs-exercised anti-vacuity guard. Memoized per schema.
 */
export const deriveRefMediationEntry = (
  schema: ChatProjectionSchema,
): RefMediationLists => {
  const cached = mediationListsCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const lists = buildMediationLists(schema);
  mediationListsCache.set(schema, lists);
  return lists;
};

// --- Applying a projection schema ---------------------------------------------------

/**
 * A payload that failed its projection schema: a handler emitted a field
 * nobody classified (or a declared field changed shape). Carries only the
 * dot-paths of the issues, never any payload value, so it can reach telemetry
 * without leaking what it refused.
 */
type ProjectionSchemaViolation = { issuePaths: readonly string[] };

/** Normalize a valibot issue path into the map's `a.b` / `a[].b` grammar. */
const issueRefPath = (issue: v.BaseIssue<unknown>): string => {
  const segments: string[] = [];
  for (const item of issue.path ?? []) {
    if (typeof item.key === "number") {
      const last = segments.pop();
      if (last !== undefined) {
        segments.push(last.endsWith("[]") ? last : `${last}[]`);
      }
      continue;
    }
    segments.push(String(item.key));
  }
  return segments.length > 0 ? segments.join(".") : "(root)";
};

/**
 * Collect the leaf paths of an issue tree. A union/variant that matched no
 * option emits one top-level issue whose specifics live in its nested
 * `issues`; the leaves carry the paths worth logging.
 */
const collectIssuePaths = (
  issue: v.BaseIssue<unknown>,
  paths: string[],
): void => {
  if (issue.issues !== undefined && issue.issues.length > 0) {
    for (const nested of issue.issues) {
      collectIssuePaths(nested, paths);
    }
    return;
  }
  paths.push(issueRefPath(issue));
};

/**
 * Strict-parse a tool payload against its projection schema. The parse is the
 * structural guarantee: an unknown key anywhere in the declared object tree —
 * a field nobody classified — fails here, before the annotation walk ever
 * sees the payload, so an undeclared field cannot flow to the model by
 * construction. On failure the violation carries issue paths only.
 */
const strictParseProjection = ({
  payload,
  schema,
}: {
  schema: ChatProjectionSchema;
  payload: unknown;
}): Result<Record<string, unknown>, ProjectionSchemaViolation> => {
  const parsed = v.safeParse(schema, payload);
  if (parsed.success) {
    return Result.ok(parsed.output);
  }
  const issuePaths: string[] = [];
  for (const issue of parsed.issues) {
    collectIssuePaths(issue, issuePaths);
  }
  return Result.err({ issuePaths: [...new Set(issuePaths)] });
};

// --- Projecting a payload for chat ---------------------------------------------------
// `projectForChat` is the single output-side transform for a projected tool
// payload: one strict parse, then one walk over the parsed value guided by the
// schema's annotations. The walk strips `strippedField` leaves, hydrates
// `chatRef`/`chatEntityRef` leaves into chat refs, forwards `passthroughId`
// leaves and `unenumeratedJson` subtrees, and enforces the terminal "no raw
// tenant UUID reaches the model" invariant, all in the same pass.

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const UUID_ANYWHERE_REGEX =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

const isUuidString = (value: unknown): value is string =>
  typeof value === "string" && UUID_REGEX.test(value);

/**
 * A verbatim-UUID guard for the "no tenant UUID reaches the model" invariant.
 * A projected payload must serialize without any raw UUID: every tenant id is
 * a ref and every `passthroughId` handle is documented as either
 * non-UUID-formatted (opaque cursors) or an out-of-band handle. Tests assert
 * this holds.
 */
export const containsRawUuid = (value: unknown): boolean =>
  UUID_ANYWHERE_REGEX.test(JSON.stringify(value));

/**
 * What input dehydration resolved, carried into the output walk so entity
 * refs can be minted (or reused) without fresh lookups. Produced by
 * `dehydrateRefs` in `ref-mediation.ts`.
 */
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

/**
 * Surfaced to the model when a projected payload still carries a raw uuid at
 * a position the schema does not license. Deliberately does not say
 * "anonymization": the anonymization feature (the anonymized MCP surface) is
 * a different mechanism and is not involved — chat egress runs in default
 * mode. This is the chat ref projection's own fail-closed invariant, it fires
 * regardless of any anonymization setting, and the model can do nothing about
 * it, so the message says both.
 */
export const REF_PROJECTION_FAILURE_MESSAGE =
  "The tool result contained an internal identifier the chat projection " +
  "could not map to a reference. This is a server-side defect, not a " +
  "problem with your input; do not retry this call.";

/**
 * Surfaced to the model when a converted tool's payload fails its projection
 * schema's strict parse: a handler emitted a field nobody classified (or a
 * declared field changed shape). Same fail-closed semantics as
 * `REF_PROJECTION_FAILURE_MESSAGE`; the parse fires before any field can be
 * forwarded, so the undeclared field never reaches the model by construction.
 */
export const PROJECTION_SCHEMA_FAILURE_MESSAGE =
  "The tool result did not match the shape the chat projection declares " +
  "for this tool. This is a server-side defect, not a problem with your " +
  "input; do not retry this call.";

/** Sentinel a `strippedField` leaf projects to; the object builder omits it. */
const OMITTED = Symbol("stripped-from-chat-projection");

/**
 * The state one projection walk threads through its recursion. `raw` is the
 * pristine parse output the walk never mutates (hydrated values go into
 * freshly built containers), so `sibling`/`outputPath` workspace sources
 * always read the raw handler values — the guarantee the previous two-pass
 * hydration provided by ordering entity refs before matter refs, which would
 * otherwise overwrite a sibling workspace UUID with a `mat_N` ref before the
 * entity ref could be minted.
 */
type ProjectWalkContext = {
  raw: Record<string, unknown>;
  refRegistry: ChatRefRegistry;
  dehydration: DehydratedInput;
  /**
   * Offending paths of the terminal UUID invariant, recorded during the walk:
   * a UUID-bearing string at any position not licensed by a `passthroughId`
   * annotation (an ordinary declared field, an unenumerated subtree, a ref
   * leaf hydration could not rewrite). Paths only, never values.
   */
  uuidViolations: string[];
};

/**
 * Record a violation if a string leaf carries a UUID anywhere in it. A
 * substring match (not just a bare-UUID exact match) so a UUID embedded
 * inside a longer string (a url, free text) is still caught.
 */
const checkStringLeaf = (
  ctx: ProjectWalkContext,
  value: unknown,
  segments: readonly string[],
): void => {
  if (typeof value === "string" && UUID_ANYWHERE_REGEX.test(value)) {
    ctx.uuidViolations.push(segments.join("."));
  }
};

/**
 * Scan an `unenumeratedJson` subtree, which is forwarded unmodified: every
 * string inside stays subject to the UUID invariant, unlicensed. Paths use
 * the same `a.b` / `a[].b` grammar as the rest of the walk (arrays collapsed
 * to a `[]` suffix on their key).
 */
const scanUnenumerated = (
  ctx: ProjectWalkContext,
  node: unknown,
  segments: readonly string[],
): void => {
  if (typeof node === "string") {
    checkStringLeaf(ctx, node, segments);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      scanUnenumerated(ctx, item, segments);
    }
    return;
  }
  if (!isRecord(node)) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    const segment = Array.isArray(value) ? `${key}[]` : key;
    scanUnenumerated(ctx, value, [...segments, segment]);
  }
};

/** Read the first scalar a (non-array) dotted path resolves to in `raw`. */
const readRawScalar = (ctx: ProjectWalkContext, path: string): unknown => {
  let cursor: unknown = ctx.raw;
  for (const key of path.split(".")) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
};

const resolveEntityWorkspaceUuid = (
  ctx: ProjectWalkContext,
  workspace: EntityWorkspaceSource,
  container: Record<string, unknown>,
): unknown => {
  switch (workspace.from) {
    case "sibling": {
      // Reads the RAW container, untouched by hydration in this same walk.
      return container[workspace.key];
    }
    case "outputPath": {
      return readRawScalar(ctx, workspace.path);
    }
    case "inputParam": {
      return ctx.dehydration.resolvedMatterParams[workspace.param];
    }
    case "inputEntityWorkspace": {
      return ctx.dehydration.resolvedEntityParams[workspace.param];
    }
    case "inputEntity": {
      // The output entity is the request's own entity input; its ref comes
      // from the reuse map in `projectEntityLeaf`, never a workspace lookup.
      return undefined;
    }
    default: {
      workspace satisfies never;
      return panic(`Unhandled workspace: ${String(workspace)}`);
    }
  }
};

type ProjectEntityLeafArgs = {
  ctx: ProjectWalkContext;
  value: unknown;
  container: Record<string, unknown>;
  workspace: EntityWorkspaceSource;
  segments: readonly string[];
};

const projectEntityLeaf = ({
  ctx,
  value,
  container,
  workspace,
  segments,
}: ProjectEntityLeafArgs): unknown => {
  if (!isUuidString(value)) {
    // Not an exact UUID (an opaque or already-shaped value): forwarded, but
    // an embedded UUID substring still fails closed.
    checkStringLeaf(ctx, value, segments);
    return value;
  }

  // The output entity IS one the request named on input: reuse the ref already
  // minted for it, so no workspace lookup is needed.
  const reused = ctx.dehydration.dehydratedEntityRefs.get(value);
  if (reused !== undefined) {
    return reused;
  }

  const workspaceUuid = resolveEntityWorkspaceUuid(ctx, workspace, container);
  if (!isUuidString(workspaceUuid)) {
    // Owning workspace not recoverable for this field: refusing to mint a ref
    // against a guessed workspace leaves the raw UUID at an entity-ref
    // position, which the terminal invariant refuses (never licensed).
    ctx.uuidViolations.push(segments.join("."));
    return value;
  }

  return ctx.refRegistry.toEntityRef({
    entityId: brandPersistedEntityId(value),
    workspaceId: brandPersistedWorkspaceId(workspaceUuid),
  });
};

type ProjectRefLeafArgs = {
  ctx: ProjectWalkContext;
  value: unknown;
  kind: SimpleRefKind;
  segments: readonly string[];
};

const projectRefLeaf = ({
  ctx,
  value,
  kind,
  segments,
}: ProjectRefLeafArgs): unknown => {
  if (!isUuidString(value)) {
    checkStringLeaf(ctx, value, segments);
    return value;
  }
  switch (kind) {
    case "matter": {
      return ctx.refRegistry.toMatterRef(brandPersistedWorkspaceId(value));
    }
    case "contact": {
      return ctx.refRegistry.toContactRef(brandPersistedContactId(value));
    }
    case "property": {
      return ctx.refRegistry.toPropertyRef(brandPersistedPropertyId(value));
    }
    default: {
      kind satisfies never;
      return panic(`Unhandled kind: ${String(kind)}`);
    }
  }
};

/**
 * Recover the branch proof recorded while Valibot produced this canonical
 * object. Every union/variant option must use `projectionBranch`; accepting an
 * unmarked branch would make its annotation policy unknowable without a
 * second parse, so it is an impossible projection-schema state.
 */
const selectUnionOption = (
  unionNode: Record<string, unknown>,
  value: unknown,
): v.GenericSchema => {
  const options = unionNode["options"];
  if (!Array.isArray(options)) {
    panic("union schema node has no options array");
  }
  if (!isRecord(value)) {
    return panic("chat projection unions must contain object branches");
  }
  const selected = selectedProjectionBranches.get(value);
  if (selected === undefined) {
    return panic("parsed projection union value has no branch proof");
  }
  for (const option of options) {
    if (!isSchemaNode(option)) {
      panic("union option is not a valibot schema");
    }
    const source = projectionBranchSources.get(option);
    if (source === undefined) {
      panic("chat projection union option is not wrapped in projectionBranch");
    }
    if (source === selected) {
      return source;
    }
  }
  return panic("projection branch proof does not belong to its union");
};

type ProjectFieldArgs = {
  ctx: ProjectWalkContext;
  node: unknown;
  value: unknown;
  container: Record<string, unknown>;
  segments: readonly string[];
  key: string;
};

/**
 * A field's annotation, read through transparent wrappers
 * (optional/nullable/...): chat semantics attach to the field, not to a
 * particular wrapping, so `v.optional(strippedField())` strips exactly like a
 * bare `strippedField()` even when the present value is null.
 */
const readFieldAnnotation = (
  node: Record<string, unknown>,
): ReturnType<typeof readAnnotation> => {
  const annotation = readAnnotation(node);
  if (annotation !== undefined) {
    return annotation;
  }
  const nodeType = node["type"];
  if (typeof nodeType === "string" && WRAPPER_TYPES.has(nodeType)) {
    return readFieldAnnotation(asSchemaNode(node["wrapped"]));
  }
  return undefined;
};

/**
 * Project one object-field value. Annotated leaves get their chat semantics
 * applied here, where the RAW containing object is in hand for `sibling`
 * workspace sources; everything else descends structurally.
 */
const projectField = ({
  ctx,
  node,
  value,
  container,
  segments,
  key,
}: ProjectFieldArgs): unknown => {
  const schemaNode = asSchemaNode(node);
  const annotation = readFieldAnnotation(schemaNode);
  if (annotation !== undefined) {
    switch (annotation.role) {
      case "strip": {
        return OMITTED;
      }
      case "passthroughId": {
        // Licensed to survive verbatim, UUID-shaped or not.
        return value;
      }
      case "json": {
        const segment = Array.isArray(value) ? `${key}[]` : key;
        scanUnenumerated(ctx, value, [...segments, segment]);
        return value;
      }
      case "ref": {
        return projectRefLeaf({
          ctx,
          kind: annotation.kind,
          segments: [...segments, key],
          value,
        });
      }
      case "entityRef": {
        return projectEntityLeaf({
          container,
          ctx,
          segments: [...segments, key],
          value,
          workspace: annotation.workspace,
        });
      }
      default: {
        annotation satisfies never;
        return panic(`Unhandled annotation: ${String(annotation)}`);
      }
    }
  }

  const nodeType = schemaNode["type"];
  if (typeof nodeType === "string" && WRAPPER_TYPES.has(nodeType)) {
    if (value === null || value === undefined) {
      return value;
    }
    return projectField({
      container,
      ctx,
      key,
      node: schemaNode["wrapped"],
      segments,
      value,
    });
  }
  if (nodeType === "array") {
    if (!Array.isArray(value)) {
      panic("array projection schema admitted a non-array value");
    }
    const item = asSchemaNode(schemaNode["item"]);
    if (readAnnotation(item) !== undefined) {
      panic(
        "the ref path grammar cannot address annotated array items; annotate an object field instead",
      );
    }
    const itemSegments = [...segments, `${key}[]`];
    return value.map((entry) => projectValue(ctx, item, entry, itemSegments));
  }
  if (nodeType === "unknown") {
    return panic(
      "unknown chat projection fields must use strippedField or unenumeratedJson",
    );
  }
  return projectValue(ctx, schemaNode, value, [...segments, key]);
};

/** Project a non-field position: a union option, object, or array item. */
const projectValue = (
  ctx: ProjectWalkContext,
  node: unknown,
  value: unknown,
  segments: readonly string[],
): unknown => {
  const schemaNode = asSchemaNode(node);
  if (readAnnotation(schemaNode) !== undefined) {
    panic("chat projection annotations must sit on object fields");
  }
  const nodeType = schemaNode["type"];
  if (typeof nodeType !== "string") {
    panic("valibot schema node has no type");
  }
  if (WRAPPER_TYPES.has(nodeType)) {
    if (value === null || value === undefined) {
      return value;
    }
    return projectValue(ctx, schemaNode["wrapped"], value, segments);
  }
  if (UNION_TYPES.has(nodeType)) {
    return projectValue(
      ctx,
      selectUnionOption(schemaNode, value),
      value,
      segments,
    );
  }
  if (OBJECT_TYPES.has(nodeType)) {
    const entries = schemaNode["entries"];
    if (!isRecord(entries)) {
      panic("object schema node has no entries record");
    }
    if (!isRecord(value)) {
      panic("object projection schema admitted a non-object value");
    }
    const projectedEntries: [string, unknown][] = [];
    for (const [key, child] of Object.entries(value)) {
      const childSchema =
        entries[key] ??
        panic("strict parse admitted a key its schema does not declare");
      const projected = projectField({
        container: value,
        ctx,
        key,
        node: childSchema,
        segments,
        value: child,
      });
      if (projected !== OMITTED) {
        projectedEntries.push([key, projected]);
      }
    }
    return Object.fromEntries(projectedEntries);
  }
  if (nodeType === "array") {
    panic("the ref path grammar cannot address nested arrays");
  }
  if (nodeType === "unknown") {
    return panic(
      "unknown chat projection fields must use strippedField or unenumeratedJson",
    );
  }
  // A scalar leaf (string/number/boolean/literal/picklist/null): ordinary
  // data. A UUID-bearing string here is undeclared and fails closed.
  checkStringLeaf(ctx, value, segments);
  return value;
};

/** Where a projection ran, for the fail-closed telemetry context. */
type ProjectionTelemetrySource =
  | "run-registry-tool"
  | "run-registry-write-tool";

export type ProjectForChatOptions<TPayload> = {
  schema: ChatProjectionSchema;
  payload: TPayload;
  refRegistry: ChatRefRegistry;
  dehydration: DehydratedInput;
  /** Telemetry context only; never part of the transform. */
  source: ProjectionTelemetrySource;
  toolName: string;
};

/**
 * The single output-side transform for a projected tool payload:
 *
 * 1. Strict-parse against the projection schema. An unknown key anywhere in
 *    the declared object tree — a field nobody classified — fails closed as a
 *    `server-defect`, with the issue dot-paths (never values) to telemetry.
 * 2. One walk over the parsed value, guided by the schema annotations:
 *    `strippedField` leaves are omitted, `chatRef`/`chatEntityRef` leaves are
 *    hydrated into chat refs (entity workspaces resolved per their declared
 *    `EntityWorkspaceSource`, always against the raw parsed snapshot),
 *    `passthroughId` leaves and `unenumeratedJson` subtrees pass through.
 * 3. The terminal invariant, enforced in the same walk: no UUID survives at
 *    any position a `passthroughId` annotation does not license. The schema
 *    annotations are documentation the type system cannot fully enforce (a
 *    wrong workspace source silently skips hydration), so every forwarded
 *    string is checked rather than trusting the static mapping alone; a
 *    survivor fails closed as a `server-defect`, its path (never its value)
 *    to telemetry.
 */
export const projectForChat = <TPayload>({
  schema,
  payload,
  refRegistry,
  dehydration,
  source,
  toolName,
}: ProjectForChatOptions<TPayload>): Result<unknown, ChatToolError> => {
  const parsed = strictParseProjection({ payload, schema });
  if (Result.isError(parsed)) {
    const error = new ChatToolError({
      kind: "server-defect",
      message: PROJECTION_SCHEMA_FAILURE_MESSAGE,
    });
    captureError(error, {
      paths: parsed.error.issuePaths.join(", "),
      source,
      toolName,
    });
    return Result.err(error);
  }

  const ctx: ProjectWalkContext = {
    dehydration,
    raw: parsed.value,
    refRegistry,
    uuidViolations: [],
  };
  const projected = projectValue(ctx, schema, parsed.value, []);

  const offendingPath = ctx.uuidViolations.at(0);
  if (offendingPath !== undefined) {
    const error = new ChatToolError({
      kind: "server-defect",
      message: REF_PROJECTION_FAILURE_MESSAGE,
    });
    captureError(error, { path: offendingPath, source, toolName });
    return Result.err(error);
  }

  return Result.ok(projected);
};

// --- Model-facing shape rendering ---------------------------------------------------

/**
 * Objects nested deeper than this render as `{…}`; unions below the top level
 * render as `…`. Keeps the `Returns:` line in a tool description terse enough
 * for the provider-visible catalog while still naming the keys the model
 * actually iterates over.
 */
const MAX_RENDERED_OBJECT_DEPTH = 2;

const COLLAPSED_OBJECT = "{…}";
const COLLAPSED_VALUE = "…";

type RenderedField = { key: string; optional: boolean; shape: string };

/**
 * Render one field's value shape; empty string means "bare key" (a scalar or
 * an id/ref leaf whose type adds nothing), `undefined` means the field is
 * stripped from the projection and must not be shown at all.
 */
const renderFieldShape = (
  value: unknown,
  depth: number,
  optional: boolean,
): RenderedFieldShape => {
  const node = asSchemaNode(value);
  const annotation = readAnnotation(node);
  if (annotation !== undefined) {
    return annotation.role === "strip"
      ? { render: false }
      : { render: true, optional, shape: "" };
  }
  const nodeType = node["type"];
  if (typeof nodeType === "string" && WRAPPER_TYPES.has(nodeType)) {
    return renderFieldShape(
      node["wrapped"],
      depth,
      optional || nodeType === "optional" || nodeType === "exact_optional",
    );
  }
  if (nodeType === "array") {
    const item = renderFieldShape(node["item"], depth, false);
    const itemShape = item.render && item.shape !== "" ? item.shape : "";
    return { render: true, optional, shape: `${itemShape}[]` };
  }
  if (typeof nodeType === "string" && UNION_TYPES.has(nodeType)) {
    return { render: true, optional, shape: COLLAPSED_VALUE };
  }
  if (typeof nodeType === "string" && OBJECT_TYPES.has(nodeType)) {
    return {
      render: true,
      optional,
      shape: renderObjectShape(node, depth + 1),
    };
  }
  return { render: true, optional, shape: "" };
};

type RenderedFieldShape =
  | { render: false }
  | { render: true; optional: boolean; shape: string };

const renderObjectShape = (
  node: Record<string, unknown>,
  depth: number,
): string => {
  if (depth > MAX_RENDERED_OBJECT_DEPTH) {
    return COLLAPSED_OBJECT;
  }
  const entries = node["entries"];
  if (!isRecord(entries)) {
    panic("object schema node has no entries record");
  }
  const fields: RenderedField[] = [];
  for (const [key, child] of Object.entries(entries)) {
    const rendered = renderFieldShape(child, depth, false);
    if (rendered.render) {
      fields.push({ key, optional: rendered.optional, shape: rendered.shape });
    }
  }
  const body = fields
    .map(({ key, optional, shape }) => {
      const name = optional ? `${key}?` : key;
      return shape === "" ? name : `${name}: ${shape}`;
    })
    .join(", ");
  return `{ ${body} }`;
};

const renderTopLevel = (value: unknown): string => {
  const node = asSchemaNode(value);
  const nodeType = node["type"];
  if (typeof nodeType === "string" && WRAPPER_TYPES.has(nodeType)) {
    return renderTopLevel(node["wrapped"]);
  }
  if (typeof nodeType === "string" && UNION_TYPES.has(nodeType)) {
    const options = node["options"];
    if (!Array.isArray(options)) {
      panic("union schema node has no options array");
    }
    return options.map((option) => renderTopLevel(option)).join(" | ");
  }
  if (typeof nodeType === "string" && OBJECT_TYPES.has(nodeType)) {
    return renderObjectShape(node, 1);
  }
  return COLLAPSED_VALUE;
};

const renderedShapeCache = new WeakMap<ChatProjectionSchema, string>();

/**
 * A terse TS-ish `Returns:` shape for a converted tool's description, derived
 * from the same projection schema that gates its payload — so the shape the
 * model plans against and the shape the runtime enforces cannot drift.
 * Stripped fields are omitted (they never reach the model); depth-capped so
 * the provider-visible catalog stays short. Memoized per schema.
 */
export const renderProjectionShape = (schema: ChatProjectionSchema): string => {
  const cached = renderedShapeCache.get(schema);
  if (cached !== undefined) {
    return cached;
  }
  const rendered = renderTopLevel(schema);
  renderedShapeCache.set(schema, rendered);
  return rendered;
};
