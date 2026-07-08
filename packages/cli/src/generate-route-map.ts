// THE generator (spec 051 S5.2): JSON-Schema tool listings + the baked-in
// Annotation Table -> a stricli-ready `RouteNode` tree. Pure, deterministic, no
// I/O, no `Date.now()`/`Math.random()`. Called at build time by the codegen
// script and (later, out of scope here) at runtime with a validated
// `tools/list`; both call sites share this one function and the same
// annotations, so the trees are byte-identical.

import { RESERVED_FLAGS, RESERVED_TOP_LEVEL_NAMES } from "./annotations.js";
import { CliBaseError } from "./auth/errors.js";
import type {
  FlagSpec,
  JsonSchema,
  LeafCommandSpec,
  RegistryToolListing,
  RouteNode,
  ToolAnnotation,
  ToolScope,
} from "./route-types.js";

/** Argument keys the pagination flags map onto, shared across every list tool. */
const CURSOR_ARG = "cursor";
const LIMIT_ARG = "limit";

/**
 * The destructive-confirm gate arg. A tool that gates a destructive action
 * advertises a boolean `confirm` prop, but the CLI never emits a redundant
 * `--confirm` flag: the reserved `--yes` flow owns the confirmation, and the
 * executor injects `confirm: true` after the human confirms. It is dropped from
 * the generated per-tool flags of EVERY leaf of any tool that declares it
 * (including non-destructive sibling subcommands of a discriminated tool such
 * as `manage_organization`, where only `remove-member` is destructive but all
 * three subcommands share the one schema). It stays reachable through `--input`
 * for scripts that want it.
 */
const CONFIRM_ARG = "confirm";

/** Prefixes that split an unknown tool name into `verb domain` (spec S1 rule 5). */
const VERB_PREFIXES: ReadonlySet<string> = new Set([
  "list",
  "save",
  "delete",
  "read",
  "get",
  "search",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Extract a `{ prop: schema }` map from a schema's `properties`, guarding shapes. */
const propertyMap = (schema: PropSchema): Record<string, PropSchema> => {
  const raw = schema["properties"];
  if (!isRecord(raw)) {
    return {};
  }
  const out: Record<string, PropSchema> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isRecord(value)) {
      out[key] = value;
    }
  }
  return out;
};

/** Hard codegen failure: a collision or reserved-name violation (spec S1). */
export class RouteGenerationError extends CliBaseError<"RouteGenerationError"> {
  override readonly name = "RouteGenerationError";

  constructor(message: string) {
    super("RouteGenerationError", message);
  }
}

/** snake_case or camelCase segment -> kebab-case. */
const kebabCase = (segment: string): string =>
  segment
    .replace(/_/gu, "-")
    .replace(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower>-$<upper>")
    .toLowerCase();

type PropSchema = Record<string, unknown>;

type TypeInfo = {
  base: string | undefined;
  nullable: boolean;
};

const schemaTypeList = (rawType: unknown): readonly string[] => {
  if (Array.isArray(rawType)) {
    return rawType.filter((t): t is string => typeof t === "string");
  }
  return typeof rawType === "string" ? [rawType] : [];
};

const typeInfo = (schema: PropSchema): TypeInfo => {
  const types = schemaTypeList(schema["type"]);
  const nullable = types.includes("null");
  const base = types.find((t) => t !== "null");
  return { base, nullable };
};

const enumValues = (schema: PropSchema): readonly string[] | undefined => {
  const values = schema["enum"];
  if (!Array.isArray(values)) {
    return undefined;
  }
  return values.every((v) => typeof v === "string")
    ? (values as readonly string[])
    : undefined;
};

/** Conditionally include `min`/`max` so an absent bound is omitted, not `undefined`. */
const boundFields = (schema: PropSchema): { min?: number; max?: number } => {
  const minimum = schema["minimum"];
  const maximum = schema["maximum"];
  return {
    ...(typeof minimum === "number" ? { min: minimum } : {}),
    ...(typeof maximum === "number" ? { max: maximum } : {}),
  };
};

/** Result of classifying one prop's schema into a CLI surface (spec S3). */
type PropClassification =
  | { kind: "flag"; spec: Omit<FlagSpec, "required"> }
  | {
      kind: "dot-path";
      children: readonly Omit<FlagSpec, "required">[];
    }
  | { kind: "input-only" };

const scalarFlagKind = (
  base: string,
): "string" | "int" | "number" | "boolean" | undefined => {
  if (base === "string") {
    return "string";
  }
  if (base === "integer") {
    return "int";
  }
  if (base === "number") {
    return "number";
  }
  if (base === "boolean") {
    return "boolean";
  }
  return undefined;
};

const classifyArrayItems = (
  prop: string,
  items: PropSchema,
): PropClassification => {
  const { base } = typeInfo(items);
  const itemEnum = enumValues(items);
  if (itemEnum) {
    return {
      kind: "flag",
      spec: {
        flag: `--${kebabCase(prop)}`,
        prop,
        kind: "enum-array",
        enum: itemEnum,
        repeatable: true,
      },
    };
  }
  if (base === "string") {
    return {
      kind: "flag",
      spec: {
        flag: `--${kebabCase(prop)}`,
        prop,
        kind: "string-array",
        repeatable: true,
      },
    };
  }
  if (base === "integer" || base === "number") {
    return {
      kind: "flag",
      spec: {
        flag: `--${kebabCase(prop)}`,
        prop,
        kind: "int-array",
        repeatable: true,
      },
    };
  }
  // array-of-object (and anything else) -> --input only (spec S3).
  return { kind: "input-only" };
};

const classifyObject = (
  prop: string,
  schema: PropSchema,
): PropClassification => {
  // Free map (additionalProperties: true) -> --input only (spec S3).
  if (schema["additionalProperties"] === true) {
    return { kind: "input-only" };
  }
  if (!isRecord(schema["properties"])) {
    return { kind: "input-only" };
  }

  // Dot-path flags only for a depth-2 object all of whose children are scalars
  // (spec S3). Any non-scalar child (nested object/array/untyped) pushes the
  // whole subtree to --input rather than emitting half-generated flags.
  const children: Omit<FlagSpec, "required">[] = [];
  for (const [childName, childSchema] of Object.entries(schema["properties"])) {
    if (!isRecord(childSchema)) {
      return { kind: "input-only" };
    }
    const child = childSchema;
    const childEnum = enumValues(child);
    const { base } = typeInfo(child);
    if (childEnum) {
      children.push({
        flag: `--${kebabCase(prop)}.${kebabCase(childName)}`,
        prop: `${prop}.${childName}`,
        kind: "enum",
        enum: childEnum,
        repeatable: false,
      });
      continue;
    }
    const scalar = scalarFlagKind(base ?? "");
    if (scalar === undefined) {
      return { kind: "input-only" };
    }
    children.push({
      flag: `--${kebabCase(prop)}.${kebabCase(childName)}`,
      prop: `${prop}.${childName}`,
      kind: scalar,
      ...(scalar === "int" || scalar === "number" ? boundFields(child) : {}),
      repeatable: false,
    });
  }
  return { kind: "dot-path", children };
};

const classifyProp = (prop: string, schema: PropSchema): PropClassification => {
  const { base, nullable } = typeInfo(schema);
  const values = enumValues(schema);

  if (values && base === "string") {
    return {
      kind: "flag",
      spec: {
        flag: `--${kebabCase(prop)}`,
        prop,
        kind: "enum",
        enum: values,
        repeatable: false,
      },
    };
  }

  if (base === "string") {
    return {
      kind: "flag",
      spec: {
        flag: `--${kebabCase(prop)}`,
        prop,
        kind: nullable ? "nullable-string" : "string",
        repeatable: false,
      },
    };
  }

  if (base === "integer") {
    return {
      kind: "flag",
      spec: {
        flag: `--${kebabCase(prop)}`,
        prop,
        kind: "int",
        ...boundFields(schema),
        repeatable: false,
      },
    };
  }

  if (base === "number") {
    return {
      kind: "flag",
      spec: {
        flag: `--${kebabCase(prop)}`,
        prop,
        kind: "number",
        ...boundFields(schema),
        repeatable: false,
      },
    };
  }

  if (base === "boolean") {
    return {
      kind: "flag",
      spec: {
        flag: `--${kebabCase(prop)}`,
        prop,
        kind: "boolean",
        repeatable: false,
      },
    };
  }

  if (base === "array") {
    const items = schema["items"];
    if (!isRecord(items)) {
      return { kind: "input-only" };
    }
    return classifyArrayItems(prop, items);
  }

  if (base === "object") {
    return classifyObject(prop, schema);
  }

  return { kind: "input-only" };
};

type PaginationMode = "full" | "cursor-only" | "none";

const resolvePaginationMode = (
  properties: Record<string, PropSchema>,
  annotation: ToolAnnotation | undefined,
): PaginationMode => {
  const cursor = properties[CURSOR_ARG];
  const limit = properties[LIMIT_ARG];
  const hasCursor = cursor !== undefined && typeInfo(cursor).base === "string";
  const hasLimit = limit !== undefined && typeInfo(limit).base === "integer";
  if (!hasCursor) {
    return "none";
  }
  // Windowed-text and paginationless tools page a cursor but expose no --limit.
  if (annotation?.windowedText || annotation?.paginationless) {
    return "cursor-only";
  }
  return hasLimit ? "full" : "cursor-only";
};

type BuiltFlags = {
  flags: FlagSpec[];
  inputOnly: string[];
};

const buildFlags = ({
  properties,
  required,
  includeProps,
  skipProps,
}: {
  properties: Record<string, PropSchema>;
  required: ReadonlySet<string>;
  includeProps: readonly string[] | undefined;
  skipProps: ReadonlySet<string>;
}): BuiltFlags => {
  const flags: FlagSpec[] = [];
  const inputOnly: string[] = [];
  const seenFlags = new Set<string>();

  const propNames =
    includeProps ?? Object.keys(properties).filter((p) => !skipProps.has(p));

  for (const prop of propNames) {
    if (skipProps.has(prop)) {
      continue;
    }
    const schema = properties[prop];
    if (schema === undefined) {
      continue;
    }
    const classification = classifyProp(prop, schema);
    if (classification.kind === "input-only") {
      inputOnly.push(prop);
      continue;
    }
    const isRequired = required.has(prop);
    const candidates =
      classification.kind === "flag"
        ? [classification.spec]
        : classification.children;
    for (const candidate of candidates) {
      if (RESERVED_FLAGS.has(candidate.flag)) {
        throw new RouteGenerationError(
          `Generated flag ${candidate.flag} (from prop ${candidate.prop}) collides with a reserved global flag`,
        );
      }
      if (seenFlags.has(candidate.flag)) {
        throw new RouteGenerationError(
          `Flag ${candidate.flag} is generated twice within one command; add a flagRename annotation`,
        );
      }
      seenFlags.add(candidate.flag);
      // A dot-path leaf is required only if the whole object prop is required
      // AND the child schema itself is required; the CLI keeps this simple by
      // treating dot-path leaves as optional (the server enforces sub-requiredness).
      flags.push({
        ...candidate,
        required: classification.kind === "flag" ? isRequired : false,
      });
    }
  }

  return { flags, inputOnly };
};

const scopeOf = (annotation: ToolAnnotation): ToolScope | undefined =>
  annotation.scope;

/** Split an unknown tool name into a `[domain, verb]` command path (spec S1 rule 5). */
const heuristicCommandPath = (name: string): readonly string[] => {
  const underscore = name.indexOf("_");
  if (underscore === -1) {
    return [kebabCase(name)];
  }
  const head = name.slice(0, underscore);
  const rest = name.slice(underscore + 1);
  if (VERB_PREFIXES.has(head)) {
    return [kebabCase(rest), head];
  }
  return [kebabCase(head), kebabCase(rest)];
};

const leafSpecsForTool = ({
  listing,
  annotation,
}: {
  listing: RegistryToolListing;
  annotation: ToolAnnotation | undefined;
}): LeafCommandSpec[] => {
  const schema: JsonSchema = listing.inputSchema;
  const properties = propertyMap(schema);
  const requiredList = Array.isArray(schema["required"])
    ? schema["required"].filter((r): r is string => typeof r === "string")
    : [];
  const required = new Set(requiredList);
  const destructiveHint = listing.annotations?.destructiveHint === true;

  const command = annotation?.command ?? heuristicCommandPath(listing.name);
  const scope = annotation ? scopeOf(annotation) : undefined;
  const itemsKey = annotation?.itemsKey;
  const windowedText = annotation?.windowedText === true;
  const mode = resolvePaginationMode(properties, annotation);
  const paginated = mode !== "none";

  const paginationSkip = new Set<string>();
  if (mode === "full") {
    paginationSkip.add(CURSOR_ARG);
    paginationSkip.add(LIMIT_ARG);
  } else if (mode === "cursor-only") {
    paginationSkip.add(CURSOR_ARG);
  }
  // A tool that declares a boolean `confirm` gate (either the whole tool is
  // destructive, or one discriminated subcommand is) hides it from the generated
  // flags on every leaf: the reserved --yes flow owns it, and the executor
  // injects `confirm: true` only after confirming an actually-destructive op.
  if (destructiveHint || properties[CONFIRM_ARG] !== undefined) {
    paginationSkip.add(CONFIRM_ARG);
  }

  // Discriminator split (spec S2). An ANNOTATED tool splits only when its
  // annotation explicitly marks a `discriminator` (so a plain required-enum
  // filter such as `lookup_business_registry.registry` stays a normal flag). An
  // UNKNOWN tool (runtime, no annotation) falls back to the safe-superset
  // heuristic: split on its first required-enum prop.
  const discriminatorProp = annotation
    ? annotation.discriminator?.prop
    : Object.keys(properties).find((prop) => {
        const values = enumValues(properties[prop] ?? {});
        return values !== undefined && required.has(prop);
      });

  if (discriminatorProp !== undefined) {
    const propSchema = properties[discriminatorProp];
    const values = enumValues(propSchema ?? {}) ?? [];
    const skipWithDiscriminator = new Set([
      ...paginationSkip,
      discriminatorProp,
    ]);
    const baseRequired = new Set(
      [...required].filter((r) => r !== discriminatorProp),
    );

    const specs: LeafCommandSpec[] = [];
    for (const value of values) {
      const sub = annotation?.discriminator?.subcommands[value];
      const subCommandName = sub?.command ?? kebabCase(value);
      const subRequired = new Set([...baseRequired, ...(sub?.required ?? [])]);
      const { flags, inputOnly } = buildFlags({
        properties,
        required: subRequired,
        includeProps: sub?.include,
        skipProps: skipWithDiscriminator,
      });
      specs.push({
        commandPath: [...command, subCommandName],
        toolName: listing.name,
        discriminatorInject: { [discriminatorProp]: value },
        flags,
        inputOnly,
        paginated,
        windowedText,
        ...(itemsKey === undefined ? {} : { itemsKey }),
        destructive: sub?.destructive === true || destructiveHint,
        ...(scope === undefined ? {} : { scope }),
        inputSchema: schema,
      });
    }
    return specs;
  }

  const { flags, inputOnly } = buildFlags({
    properties,
    required,
    includeProps: undefined,
    skipProps: paginationSkip,
  });

  return [
    {
      commandPath: command,
      toolName: listing.name,
      flags,
      inputOnly,
      paginated,
      windowedText,
      ...(itemsKey === undefined ? {} : { itemsKey }),
      destructive: destructiveHint,
      ...(scope === undefined ? {} : { scope }),
      inputSchema: schema,
    },
  ];
};

const insertLeaf = (root: RouteNode, spec: LeafCommandSpec): void => {
  if (root.kind !== "route") {
    throw new RouteGenerationError("Cannot insert into a leaf node");
  }
  const path = spec.commandPath;
  const top = path[0];
  if (top !== undefined && RESERVED_TOP_LEVEL_NAMES.has(top)) {
    throw new RouteGenerationError(
      `Command domain '${top}' (tool ${spec.toolName}) collides with a reserved top-level name`,
    );
  }

  let node: RouteNode = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const segment = path[index];
    if (segment === undefined) {
      continue;
    }
    if (node.kind !== "route") {
      throw new RouteGenerationError(
        `Command path ${path.join(" ")} passes through leaf '${segment}'`,
      );
    }
    const existing: RouteNode | undefined = node.children[segment];
    if (existing === undefined) {
      const created: RouteNode = { kind: "route", children: {} };
      node.children[segment] = created;
      node = created;
      continue;
    }
    node = existing;
  }

  const verb = path.at(-1);
  if (verb === undefined) {
    throw new RouteGenerationError(
      `Tool ${spec.toolName} produced an empty command path`,
    );
  }
  if (node.kind !== "route") {
    throw new RouteGenerationError(
      `Command path ${path.join(" ")} cannot attach under a leaf`,
    );
  }
  if (node.children[verb] !== undefined) {
    throw new RouteGenerationError(
      `Duplicate command '${path.join(" ")}' (tool ${spec.toolName})`,
    );
  }
  node.children[verb] = { kind: "leaf", spec };
};

/**
 * THE generator. Deterministic and pure: same inputs -> byte-identical
 * `RouteNode`. Excludes tools annotated `excluded`, splits required-enum
 * discriminators into subcommands, maps every prop to a flag or `inputOnly`
 * per spec S3, and fails hard on any reserved-name or kebab collision.
 */
export const generateRouteMap = (
  listings: readonly RegistryToolListing[],
  annotations: Readonly<Record<string, ToolAnnotation>>,
): RouteNode => {
  const root: RouteNode = { kind: "route", children: {} };

  for (const listing of listings) {
    const annotation = annotations[listing.name];
    if (annotation?.excluded === true) {
      continue;
    }
    for (const spec of leafSpecsForTool({ listing, annotation })) {
      insertLeaf(root, spec);
    }
  }

  return root;
};
