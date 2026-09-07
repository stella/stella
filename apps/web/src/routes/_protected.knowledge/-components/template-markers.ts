import {
  assertNever,
  legacyLoopAlias,
  scanMarkers,
  type FilterArgument,
  type FilterCall,
  type MarkerLiteral,
  type MarkerMeta,
} from "@stll/template-conditions";

/**
 * The Studio's marker writer: the one place `apps/web` turns a directive into
 * document text. {@link formatMarker} switches over `MarkerMeta`, so a kind
 * added to the grammar is a compile error here until it has a written form,
 * and the property test proves `scanMarkers` reads every form back.
 *
 * Block tags are written bare (`{% if … %}`, never `{%p if … %}`): the Studio
 * wraps whole paragraphs and mid-paragraph selections through the same writer,
 * and only the paragraph case could carry the docxtpl placement prefix.
 */

const quote = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

const formatLiteral = (value: MarkerLiteral): string =>
  typeof value === "string" ? quote(value) : String(value);

const formatArgument = (argument: FilterArgument): string =>
  argument.kind === "positional"
    ? formatLiteral(argument.value)
    : `${argument.name}=${formatLiteral(argument.value)}`;

const formatFilters = (filters: readonly FilterCall[]): string =>
  filters
    .map(({ name, args }) =>
      args.length === 0
        ? ` | ${name}`
        : ` | ${name}(${args.map(formatArgument).join(", ")})`,
    )
    .join("");

/** One directive as the document text an author would have typed. */
export const formatMarker = (meta: MarkerMeta): string => {
  switch (meta.kind) {
    case "placeholder":
      return `{{ ${meta.expr}${formatFilters(meta.filters)} }}`;
    case "clause":
      return meta.version === undefined
        ? `{{ clause(${quote(meta.name)}) }}`
        : `{{ clause(${quote(meta.name)}, ${quote(meta.version)}) }}`;
    case "num":
      return `{{ num(${quote(meta.key)}) }}`;
    case "ref":
      return `{{ ref(${quote(meta.key)}) }}`;
    case "loop":
      return `{{ loop.${meta.property} }}`;
    case "if":
      return `{% if ${meta.expr} %}`;
    case "elif":
      return `{% elif ${meta.expr} %}`;
    case "else":
      return "{% else %}";
    case "endif":
      return "{% endif %}";
    case "for":
      return `{% for ${meta.alias} in ${meta.path}${formatFilters(meta.filters)} %}`;
    case "endfor":
      return "{% endfor %}";
    default:
      return assertNever(meta);
  }
};

// ── Named writers for the Studio's insert actions ─────────

/** The loop variable a fresh `{% for %}` names its item, derived from the
 *  array path by the same rule the marker codemod uses. */
const loopAliasFor = (path: string): string => legacyLoopAlias(path);

export const fieldMarker = (path: string): string =>
  formatMarker({ kind: "placeholder", expr: path, filters: [] });

export const clauseSlotMarker = (name: string, version?: string): string =>
  formatMarker({ kind: "clause", name, version });

export const conditionOpenTag = (expr: string): string =>
  formatMarker({ kind: "if", expr });

export const conditionBranchTag = (expr: string): string =>
  formatMarker({ kind: "elif", expr });

export const CONDITION_CLOSE_TAG = formatMarker({ kind: "endif" });

export const loopOpenTag = (path: string): string =>
  formatMarker({
    kind: "for",
    alias: loopAliasFor(path),
    path,
    filters: [],
  });

export const LOOP_CLOSE_TAG = formatMarker({ kind: "endfor" });

export const LOOP_INDEX_MARKER = formatMarker({
  kind: "loop",
  property: "index",
});

export const LOOP_LENGTH_MARKER = formatMarker({
  kind: "loop",
  property: "length",
});

/**
 * Rewrite one value marker's path, keeping the filter chain that configures
 * the field. Renaming reads the marker back through the scanner rather than
 * matching text, so `{{ old | label("Fee") }}` survives the rename intact.
 * Returns null when `raw` is not a single value marker.
 */
export const rewriteFieldMarkerPath = (
  raw: string,
  nextPath: string,
): string | null => {
  const [scanned, ...rest] = scanMarkers(raw);
  if (
    scanned === undefined ||
    rest.length > 0 ||
    scanned.meta.kind !== "placeholder"
  ) {
    return null;
  }
  return formatMarker({
    kind: "placeholder",
    expr: nextPath,
    filters: scanned.meta.filters,
  });
};
