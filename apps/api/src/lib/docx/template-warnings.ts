/**
 * Authoring warnings for DOCX template markers.
 *
 * A warning is a marker the grammar accepts (or silently ignores), or a field
 * configuration the save accepts, that almost certainly does not do what the
 * author meant: it never blocks a save, it tells whoever authored the file
 * what to fix before the first fill. Hard structural faults keep their own
 * channels — unbalanced block directives are
 * {@link import("./types").TemplateStructureError}s from `parseBlockTree`, and
 * spans no recognizer sees at all are `invalidMarker` findings from the
 * template check — so nothing here re-detects them.
 *
 * The paragraph scan is text-only; `discover-template.ts` supplies the loop
 * scopes and merges the result into {@link import("./types").DiscoveredTemplate}.
 */

import type { BusinessRegistrySlug } from "@stll/api-contract";
import {
  assertNever,
  classifyMarkerDefect,
  MARKER_DEFECT_KINDS,
  markerPattern,
  scanInvalidMarkers,
  scanMarkers,
} from "@stll/template-conditions";
import type { MarkerDefect } from "@stll/template-conditions";

import type { MisplacedRowBlock } from "./row-block-markers";

/**
 * Closed set of authoring mistakes reported at save time. The marker-shape
 * defects are derived from the grammar package, so a new defect kind there
 * lands here without a second list to update.
 */
export const TEMPLATE_WARNING_CODES = [
  "unaliased_item_path",
  "row_block_across_rows",
  "split_marker",
  "condition_removes_input",
  "registry_configuration_required",
  "unmatched_lookup_format",
  "inline_bytes_ignored",
  ...MARKER_DEFECT_KINDS,
] as const;

export type TemplateWarningCode = (typeof TEMPLATE_WARNING_CODES)[number];

export type TemplateWarning = {
  code: TemplateWarningCode;
  /** The field path or marker the warning is about, when it names one. */
  path?: string;
  /** What the marker does today, in the author's own terms. */
  message: string;
  /** The concrete edit that fixes it. */
  hint: string;
};

/** Upper bound on the reported list, so a pathological file cannot return an
 *  unbounded payload to an agent that must read all of it. */
const MAX_TEMPLATE_WARNINGS = 50;

const isItemScoped = (path: string, loopPath: string): boolean =>
  path === loopPath || path.startsWith(`${loopPath}.`);

const markerDefectWarning = (
  raw: string,
  defect: MarkerDefect,
): TemplateWarning => {
  const { construct, kind } = defect;
  switch (kind) {
    case "legacy_marker":
      return {
        code: kind,
        path: raw,
        message: `${raw} is the old marker dialect, which the grammar no longer reads, so it prints literally.`,
        hint:
          defect.replacement === undefined
            ? 'Write the Jinja form: {% if expr %}, {% for item in items %}, {{ clause("Name") }}, {{ num("key") }}, {{ ref("key") }}.'
            : `Write ${defect.replacement} instead.`,
      };
    case "unsupported_tag":
      return {
        code: kind,
        path: raw,
        message: `${raw} uses the {% ${construct} %} tag, which this dialect does not run, so it prints literally.`,
        hint: "The tags are {% if %}, {% elif %}, {% else %}, {% endif %}, {% for alias in path %} and {% endfor %}.",
      };
    case "unknown_filter":
      return {
        code: kind,
        path: raw,
        message: `${raw} pipes through "${construct}", which is not a field-configuration filter, so the marker is left unfilled.`,
        hint: "Use a filter from the template-markers reference, or drop the pipe to keep a plain text field.",
      };
    case "python_expression":
      return {
        code: kind,
        path: raw,
        message: `${raw} computes "${construct}" inside the marker; the dialect prints values, it does not evaluate expressions.`,
        hint: 'Move the arithmetic into a formula filter — {{ total | formula("rent * 12") }} — or fill the value from the input.',
      };
    case "bracket_index":
      return {
        code: kind,
        path: raw,
        message: `${raw} indexes with brackets, which the marker grammar does not support, so it prints literally.`,
        hint: "Repeat the item instead: {% for item in items %} ... {{ item.name }} ... {% endfor %}.",
      };
    default:
      return assertNever(kind);
  }
};

/** One enclosing `{% for %}`: the loop variable, the path as the author wrote
 *  it, plus the path discovery qualified it to inside an outer loop (the last
 *  two differ only for a nested loop whose declared path omits the outer
 *  prefix). A placeholder matching any of the three is item-scoped. */
type WarningLoopScope = {
  alias: string;
  declaredPath: string;
  scopedPath: string;
};

type ParagraphWarningOptions = {
  /** Concatenated text of one paragraph (`paragraphText` has already joined
   *  the runs Word split the markers across). */
  text: string;
  /** The `{% for %}` loops this paragraph sits inside, outermost first. Inline
   *  loops opened within the paragraph are tracked by the scan itself. */
  loops: readonly WarningLoopScope[];
  paragraphIndex: number;
};

/**
 * Warnings for one paragraph's markers. Walks the marker spans in document
 * order so an inline `{% for i in x %} ... {% endfor %}` scopes the
 * placeholders between its own markers, exactly as the fill pipeline does.
 */
export const collectParagraphWarnings = ({
  loops,
  paragraphIndex,
  text,
}: ParagraphWarningOptions): TemplateWarning[] => {
  const warnings: TemplateWarning[] = [];
  const inlineLoops: WarningLoopScope[] = [];

  for (const { form, inner, raw } of scanInvalidMarkers(text)) {
    const defect = classifyMarkerDefect(inner, form);
    if (defect !== null) {
      warnings.push(markerDefectWarning(raw, defect));
    }
  }

  for (const { meta, raw } of scanMarkers(text)) {
    if (meta.kind === "for") {
      inlineLoops.push({
        alias: meta.alias,
        declaredPath: meta.path,
        scopedPath: meta.path,
      });
      continue;
    }
    if (meta.kind === "endfor") {
      inlineLoops.pop();
      continue;
    }
    if (meta.kind !== "placeholder") {
      continue;
    }

    const path = meta.expr;
    const enclosingLoops = [...loops, ...inlineLoops];
    const innermostLoop = enclosingLoops.at(-1);
    if (
      innermostLoop === undefined ||
      enclosingLoops.some(
        ({ alias, declaredPath, scopedPath }) =>
          isItemScoped(path, alias) ||
          isItemScoped(path, declaredPath) ||
          isItemScoped(path, scopedPath),
      )
    ) {
      continue;
    }

    const { alias, declaredPath } = innermostLoop;
    warnings.push({
      code: "unaliased_item_path",
      path,
      message: `${raw} inside {% for ${alias} in ${declaredPath} %} is not an item field: it fills from a top-level "${path}", so every repeated row renders the same value (blank when no such field is filled).`,
      hint: `Write {{ ${alias}.${path} }} to fill it from each ${declaredPath} item.`,
    });
  }

  const residue = text.replaceAll(markerPattern(), "");
  if (residue.includes("{{") || residue.includes("}}")) {
    warnings.push({
      code: "split_marker",
      message: `A "{{" or "}}" in paragraph ${paragraphIndex} of its document part has no matching half in the same paragraph, so that marker is never substituted.`,
      hint: "Retype the marker so the whole {{...}} sits in one paragraph; a line break or a cell boundary inside it splits it.",
    });
  }

  return warnings;
};

type OverlayLookup = {
  registry: BusinessRegistrySlug;
  /** Named renderings of the one resolved hit; the first is the default. */
  formats: readonly { key: string }[];
};

type OverlayField = {
  path: string;
  condition?: string | undefined;
  conditionAst?: unknown;
  lookup?: OverlayLookup | undefined;
};

type LookupOverlayField = OverlayField & { lookup: OverlayLookup };

const hasLookup = (field: OverlayField): field is LookupOverlayField =>
  field.lookup !== undefined;

/**
 * Resolves registry availability from organization and deployment credentials.
 * Awaited only when a field declares a lookup, so other templates need no
 * read.
 */
export type RegistryAvailabilityLoader = () => Promise<
  (registry: BusinessRegistrySlug) => boolean
>;

type FieldOverlayWarningOptions = {
  /** Paths referenced by a `{% if %}` / `{% elif %}` expression. */
  conditionPaths: readonly string[];
  /** Paths that appear as a value marker `{{path}}` in the document. */
  placeholderPaths: readonly string[];
  /** The manifest fields as configured (create overlay or stored manifest). */
  fields: readonly OverlayField[];
  loadRegistryAvailability: RegistryAvailabilityLoader;
};

/**
 * A `condition` turns its field into a rule evaluated at fill time, so the
 * fill form and the MCP field list stop asking for it. That is what an author
 * wants for a path used only by `{% if path %}`; it silently removes the input
 * when the same path is also a value marker.
 */
const conditionWarning = (path: string): TemplateWarning => ({
  code: "condition_removes_input",
  path,
  message: `"${path}" has a condition, so it is derived at fill time and nobody is asked for it, yet {{${path}}} also prints its value in the document.`,
  hint: `Drop the condition to keep "${path}" as a yes/no input, or give the {% if %} rule its own path.`,
});

/**
 * Every declared format must have a marker to render into, and every dotted
 * marker under a lookup field must name a declared format: a format with no
 * marker renders nowhere, and a marker with no format is left unfilled. Every
 * format, the first included, is addressed by `{{path.key}}`; the first is
 * additionally the default a bare `{{path}}` marker renders.
 */
const lookupFormatWarnings = (
  { lookup, path }: LookupOverlayField,
  valueMarkers: ReadonlySet<string>,
): TemplateWarning[] => {
  const warnings: TemplateWarning[] = [];
  const [defaultFormat, ...keyedFormats] = lookup.formats;
  const keyedMarker = (key: string): string => `${path}.${key}`;

  const isDefaultPlaced =
    valueMarkers.has(path) ||
    (defaultFormat !== undefined &&
      valueMarkers.has(keyedMarker(defaultFormat.key)));
  if (defaultFormat !== undefined && !isDefaultPlaced) {
    warnings.push({
      code: "unmatched_lookup_format",
      path,
      message: `The first format ("${defaultFormat.key}") of lookup field "${path}" has no {{${path}}} marker, so it renders nowhere.`,
      hint: `Add {{${path}}} where the default rendering belongs.`,
    });
  }

  for (const { key } of keyedFormats) {
    if (valueMarkers.has(keyedMarker(key))) {
      continue;
    }
    warnings.push({
      code: "unmatched_lookup_format",
      path: keyedMarker(key),
      message: `Format "${key}" of lookup field "${path}" has no {{${keyedMarker(key)}}} marker, so it renders nowhere.`,
      hint: `Add {{${keyedMarker(key)}}} where that rendering belongs, or drop the format.`,
    });
  }

  const keyedKeys = new Set(lookup.formats.map((format) => format.key));
  const markerPrefix = `${path}.`;
  for (const marker of valueMarkers) {
    if (!marker.startsWith(markerPrefix)) {
      continue;
    }
    const key = marker.slice(markerPrefix.length);
    if (keyedKeys.has(key)) {
      continue;
    }
    warnings.push({
      code: "unmatched_lookup_format",
      path: marker,
      message: `{{${marker}}} names no format of lookup field "${path}", so it is left unfilled.`,
      hint: `Add a "${key}" format to the field's formats, or remove the marker.`,
    });
  }

  return warnings;
};

export const fieldOverlayWarnings = async ({
  conditionPaths,
  fields,
  placeholderPaths,
  loadRegistryAvailability,
}: FieldOverlayWarningOptions): Promise<TemplateWarning[]> => {
  const conditionDriven = new Set(conditionPaths);
  const valueMarkers = new Set(placeholderPaths);
  const warnings: TemplateWarning[] = [];

  for (const field of fields) {
    const isDerived =
      field.condition !== undefined || field.conditionAst !== undefined;
    if (
      isDerived &&
      conditionDriven.has(field.path) &&
      valueMarkers.has(field.path)
    ) {
      warnings.push(conditionWarning(field.path));
    }
    if (hasLookup(field)) {
      warnings.push(...lookupFormatWarnings(field, valueMarkers));
    }
  }

  const lookupFields = fields.filter(hasLookup);
  if (lookupFields.length > 0) {
    const isRegistryAvailable = await loadRegistryAvailability();
    for (const { lookup, path } of lookupFields) {
      if (isRegistryAvailable(lookup.registry)) {
        continue;
      }
      warnings.push({
        code: "registry_configuration_required",
        path,
        message: `Lookup field "${path}" resolves from the ${lookup.registry} registry, which is missing required configuration, so the field cannot be resolved at fill time.`,
        hint: `Configure credentials for that registry, or replace the lookup on "${path}" with a plain input.`,
      });
    }
  }

  return warnings;
};

/**
 * Deduplicate (the same defective marker repeated across paragraphs is one
 * finding) and cap. Order of first appearance is kept: it follows document
 * order, so the author reads the list top-down against the file.
 */
/**
 * A create call that carried both a host file reference and inline base64.
 * The host's file is the document that was stored: a host fills `file` from
 * its own transport, while `docx_base64` is typed by the caller, so when both
 * arrive the transported bytes are the trustworthy ones. Refusing the call
 * instead taught nothing — two models sent both on every attempt of every
 * task and never dropped one on retry — so the call succeeds and says which
 * source it used.
 */
export const inlineBytesIgnoredWarning = (): TemplateWarning => ({
  code: "inline_bytes_ignored",
  message:
    "Both 'file' and 'docx_base64' were sent; the attached file was stored " +
    "and the inline bytes were ignored.",
  hint:
    "Send one document source. 'docx_base64' is for a host that cannot " +
    "supply a file reference; when your host can, send 'file' alone.",
});

/**
 * A block pair that hugs the text of two cells in DIFFERENT rows. The author
 * meant a repeating (or conditional) row and the shape is nearly right, so the
 * warning names the rule against the cells they actually wrote.
 */
export const rowBlockAcrossRowsWarning = ({
  closer,
  closerCell,
  opener,
  openerCell,
}: MisplacedRowBlock): TemplateWarning => ({
  code: "row_block_across_rows",
  path: opener,
  message:
    `${opener} opens in "${excerptCell(openerCell)}" and ${closer} closes in ` +
    `"${excerptCell(closerCell)}", which is a different row. A block pair ` +
    "wrapping a row's text acts on ONE row, so the two halves must sit in " +
    "different cells of the SAME row.",
  hint:
    `Move ${opener} to the front of the first cell of the row that repeats — ` +
    "the row with the values in it, not the header row.",
});

const CELL_EXCERPT_LENGTH = 40;

const excerptCell = (text: string): string => {
  const trimmed = text.trim().replaceAll("\n", " ");
  return trimmed.length <= CELL_EXCERPT_LENGTH
    ? trimmed
    : `${trimmed.slice(0, CELL_EXCERPT_LENGTH)}…`;
};

export const boundTemplateWarnings = (
  warnings: readonly TemplateWarning[],
): TemplateWarning[] => {
  const seen = new Set<string>();
  const bounded: TemplateWarning[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}|${warning.path ?? ""}|${warning.message}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    bounded.push(warning);
    if (bounded.length === MAX_TEMPLATE_WARNINGS) {
      break;
    }
  }
  return bounded;
};
