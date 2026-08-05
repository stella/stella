import { panic, Result } from "better-result";
import * as v from "valibot";

/**
 * Chat projection schemas: one Valibot `strictObject` per converted tool that
 * describes exactly what the chat surface forwards, with each id-bearing
 * field's chat semantics attached via `v.metadata`. The strict parse makes an
 * undeclared handler field structurally unable to reach the model (an unknown
 * key fails the parse, fail-closed), and the ref-mediation path lists
 * (`outputRefs`/`passthroughIdPaths`/`stripPaths`) are derived mechanically
 * from the same artifact, so the shape and its ref decisions cannot drift
 * apart the way a hand-maintained path list can.
 */

// --- Ref vocabulary -----------------------------------------------------------
// The id-kind types the annotations carry. They live here (not in
// ref-field-map.ts) so this module has no import back into the map and the
// module graph stays cycle-free; the map imports the vocabulary from here.

/**
 * The four tenant-content id kinds the chat ref registry mediates
 * (`createChatRefRegistry`). Every other id a registry handler emits (user,
 * task-link, invoice, time-entry, template, clause, playbook, audit-log,
 * usage-plan, or public case-law/BOE corpus id) is a handle the model may pass
 * back verbatim, not a tenant-content reference, so it stays outside this set.
 */
export type RegistryRefKind = "matter" | "entity" | "contact" | "property";

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
 * The three output-side path lists the generic mediation cores
 * (`hydrateRefs`/`findUndeclaredUuidPathIn`/`stripDeclaredPaths`) consume:
 * hand-written on unconverted map entries, derived from the projection schema
 * on converted ones.
 */
export type RefMediationLists = {
  outputRefs: readonly OutputRefField[];
  /**
   * UUID-bearing output paths intentionally left un-refed: non-tenant handles
   * (user/invoice/template/audit/public-corpus ids) or opaque cursors.
   * Load-bearing allowlist for the runtime UUID backstop; an `outputRefs`
   * path is deliberately NOT part of it — hydration must have already
   * rewritten it, so a uuid still there fails closed.
   */
  passthroughIdPaths: readonly string[];
  /**
   * Output paths deleted from the chat projection before hydration and the
   * UUID backstop run: ids other surfaces need (web-UI field/file plumbing
   * handles) that chat cannot act on.
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
]);

type ChatProjectionAnnotation = v.InferOutput<typeof annotationSchema>;

const CHAT_PROJECTION_METADATA_KEY = "chatProjection";

/**
 * The widened schema type every projection value and annotated field carries.
 * Deliberately not the inferred builder type: the payload arrives as `unknown`
 * from `JSON.parse`, so nothing consumes the precise input/output types, and
 * widening at the wrapper boundary keeps valibot's generic instantiation cost
 * out of the map (per the type-cost guard).
 */
export type ChatProjectionSchema = v.GenericSchema<
  Record<string, unknown>,
  Record<string, unknown>
>;

type AnnotatedFieldSchema = v.GenericSchema;

/** A tenant id field hydrated into a `mat_N`/`contact_N`/`prop_N` chat ref. */
export const chatRef = (kind: SimpleRefKind): AnnotatedFieldSchema =>
  v.pipe(
    v.string(),
    v.metadata({ [CHAT_PROJECTION_METADATA_KEY]: { role: "ref", kind } }),
  );

/**
 * A tenant entity id field hydrated into an `ent_N` chat ref, declaring where
 * its owning workspace id is recovered from.
 */
export const chatEntityRef = (
  workspace: EntityWorkspaceSource,
): AnnotatedFieldSchema =>
  v.pipe(
    v.string(),
    v.metadata({
      [CHAT_PROJECTION_METADATA_KEY]: { role: "entityRef", workspace },
    }),
  );

/**
 * A non-tenant handle (user/version/link/library id, opaque cursor) the model
 * may pass back verbatim; licensed to survive the runtime UUID backstop.
 */
export const passthroughId = (): AnnotatedFieldSchema =>
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
export const strippedField = (): AnnotatedFieldSchema =>
  v.pipe(
    v.unknown(),
    v.metadata({ [CHAT_PROJECTION_METADATA_KEY]: { role: "strip" } }),
  );

// --- Schema AST walking ---------------------------------------------------------
// Valibot schemas are plain objects: `v.pipe` spreads its base schema and adds
// a `pipe` array whose items include `{ type: "metadata", metadata }` actions;
// wrappers carry `wrapped`; objects carry `entries`; arrays carry `item`;
// unions/variants carry `options`. The walker reads that runtime AST through
// structural guards, so it needs no valibot generics at all.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read the chat annotation off a schema node's metadata pipe items, if any. */
const readAnnotation = (
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
 * in the `a.b` / `a[].b` grammar `ref-mediation.ts` consumes. Wrappers are
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
  // A scalar leaf (string/number/boolean/literal/picklist/unknown/null):
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
      default: {
        annotation satisfies never;
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
 * `stripPaths` from its projection schema's annotations. Memoized per schema:
 * the walk runs once per tool per process, not per request.
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
export type ProjectionSchemaViolation = { issuePaths: readonly string[] };

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
 * a field nobody classified — fails here, before strip/hydrate/backstop ever
 * see the payload, so an undeclared field cannot flow to the model by
 * construction. On failure the violation carries issue paths only.
 */
export const applyProjectionSchema = ({
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
