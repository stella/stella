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
  classifyMarker,
  classifyMarkerDefect,
  MARKER_DEFECT_KINDS,
  markerPattern,
} from "@stll/template-conditions";

/**
 * Closed set of authoring mistakes reported at save time. The marker-shape
 * defects are derived from the grammar package, so a new defect kind there
 * lands here without a second list to update.
 */
export const TEMPLATE_WARNING_CODES = [
  "unprefixed_item_path",
  "this_prefix",
  "split_marker",
  "condition_removes_input",
  "registry_disabled",
  "unmatched_lookup_format",
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

/** `{{this}}` / `{{this.name}}`: a valid field path, but there is no `this`
 *  scope in the grammar, so it resolves to a top-level field called `this`. */
const THIS_PREFIX = "this.";

const isItemScoped = (path: string, loopPath: string): boolean =>
  path === loopPath || path.startsWith(`${loopPath}.`);

const markerDefectWarning = (
  raw: string,
  inner: string,
): TemplateWarning | null => {
  const defect = classifyMarkerDefect(inner);
  if (defect === null) {
    return null;
  }
  switch (defect) {
    case "unknown_directive":
      return {
        code: defect,
        path: raw,
        message: `${raw} is not a directive in the marker grammar, so it opens and closes nothing and prints literally.`,
        hint: "Close a loop with {{/each}} and a condition with {{/if}}; the openers are {{#each path}}, {{#if expr}}, {{#elseif expr}} and {{#else}}.",
      };
    case "bracket_index":
      return {
        code: defect,
        path: raw,
        message: `${raw} indexes with brackets, which the marker grammar does not support, so it prints literally.`,
        hint: "Repeat the item instead: {{#each items}} ... {{items.name}} ... {{/each}}.",
      };
    default:
      return assertNever(defect);
  }
};

/** One enclosing `{{#each}}`: the path as the author wrote it, plus the path
 *  discovery qualified it to inside an outer loop (they differ only for a
 *  nested loop whose declared path omits the outer prefix). A placeholder
 *  matching either form is item-scoped. */
type WarningLoopScope = {
  declaredPath: string;
  scopedPath: string;
};

type ParagraphWarningOptions = {
  /** Concatenated text of one paragraph (`paragraphText` has already joined
   *  the runs Word split the markers across). */
  text: string;
  /** The `{{#each}}` loops this paragraph sits inside, outermost first. Inline
   *  loops opened within the paragraph are tracked by the scan itself. */
  loops: readonly WarningLoopScope[];
  paragraphIndex: number;
};

/**
 * Warnings for one paragraph's markers. Walks the `{{...}}` spans in document
 * order so an inline `{{#each x}} ... {{/each}}` scopes the placeholders
 * between its own markers, exactly as the fill pipeline does.
 */
export const collectParagraphWarnings = ({
  loops,
  paragraphIndex,
  text,
}: ParagraphWarningOptions): TemplateWarning[] => {
  const warnings: TemplateWarning[] = [];
  const inlineLoops: WarningLoopScope[] = [];

  for (const match of text.matchAll(markerPattern())) {
    const raw = match[0];
    const inner = (match.groups?.["inner"] ?? "").trim();
    const meta = classifyMarker(inner);

    if (meta === null) {
      const defectWarning = markerDefectWarning(raw, inner);
      if (defectWarning) {
        warnings.push(defectWarning);
      }
      continue;
    }

    if (meta.kind === "each") {
      inlineLoops.push({ declaredPath: meta.expr, scopedPath: meta.expr });
      continue;
    }
    if (meta.kind === "endeach") {
      inlineLoops.pop();
      continue;
    }
    if (meta.kind !== "placeholder") {
      continue;
    }

    const path = meta.expr;
    if (path === "this" || path.startsWith(THIS_PREFIX)) {
      const suffix = path.slice(THIS_PREFIX.length);
      warnings.push({
        code: "this_prefix",
        path,
        message: `${raw} uses "this", which is not a scope in the marker grammar: it fills from a top-level field literally named "${path}".`,
        hint: `Inside {{#each items}} write the loop path: {{items.${suffix === "" ? "name" : suffix}}}.`,
      });
      continue;
    }

    const enclosingLoops = [...loops, ...inlineLoops];
    const innermostLoop = enclosingLoops.at(-1);
    if (
      innermostLoop === undefined ||
      enclosingLoops.some(
        ({ declaredPath, scopedPath }) =>
          isItemScoped(path, declaredPath) || isItemScoped(path, scopedPath),
      )
    ) {
      continue;
    }

    const loopPath = innermostLoop.declaredPath;
    warnings.push({
      code: "unprefixed_item_path",
      path,
      message: `${raw} inside {{#each ${loopPath}}} is not an item field: it fills from a top-level "${path}", so every repeated row renders the same value (blank when no such field is filled).`,
      hint: `Write {{${loopPath}.${path}}} to fill it from each ${loopPath} item.`,
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
 * Resolves the org's registry-enablement predicate. Awaited only when a field
 * actually declares a lookup, so a template without one costs no settings
 * read.
 */
export type RegistryGate = () => Promise<
  (registry: BusinessRegistrySlug) => boolean
>;

type FieldOverlayWarningOptions = {
  /** Paths referenced by a `{{#if}}` / `{{#elseif}}` expression. */
  conditionPaths: readonly string[];
  /** Paths that appear as a value marker `{{path}}` in the document. */
  placeholderPaths: readonly string[];
  /** The manifest fields as configured (create overlay or stored manifest). */
  fields: readonly OverlayField[];
  registryGate: RegistryGate;
};

/**
 * A `condition` turns its field into a rule evaluated at fill time, so the
 * fill form and the MCP field list stop asking for it. That is what an author
 * wants for a path used only by `{{#if path}}`; it silently removes the input
 * when the same path is also a value marker.
 */
const conditionWarning = (path: string): TemplateWarning => ({
  code: "condition_removes_input",
  path,
  message: `"${path}" has a condition, so it is derived at fill time and nobody is asked for it, yet {{${path}}} also prints its value in the document.`,
  hint: `Drop the condition to keep "${path}" as a yes/no input, or give the {{#if}} rule its own path.`,
});

/** The default format's nested alias: `{{company.value}}` renders the same
 *  hit as the bare `{{company}}` marker, so it names no keyed format. */
const DEFAULT_FORMAT_ALIAS = "value";

/**
 * Every format must have a marker to render into, and every dotted marker
 * under a lookup field must name one: a format with no marker renders nowhere,
 * and a marker with no format is left unfilled.
 *
 * Placement follows the fill resolver exactly (`lookup-fields.ts`): the FIRST
 * format is written to the bare `{{path}}` marker and its `{{path.value}}`
 * alias whatever its key is, and only later formats are written to
 * `{{path.<key>}}`. A `{{path.<first key>}}` marker is therefore never filled,
 * which is the case this reports rather than accepts.
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
    valueMarkers.has(keyedMarker(DEFAULT_FORMAT_ALIAS));
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

  const keyedKeys = new Set(keyedFormats.map((format) => format.key));
  const markerPrefix = `${path}.`;
  for (const marker of valueMarkers) {
    if (!marker.startsWith(markerPrefix)) {
      continue;
    }
    const key = marker.slice(markerPrefix.length);
    if (key === DEFAULT_FORMAT_ALIAS || keyedKeys.has(key)) {
      continue;
    }
    warnings.push(
      key === defaultFormat?.key
        ? {
            code: "unmatched_lookup_format",
            path: marker,
            message: `{{${marker}}} names the FIRST format of lookup field "${path}", which is written to the bare {{${path}}} marker, so {{${marker}}} is left unfilled.`,
            hint: `Write {{${path}}} instead, or move "${key}" after the first entry in formats.`,
          }
        : {
            code: "unmatched_lookup_format",
            path: marker,
            message: `{{${marker}}} names no format of lookup field "${path}", so it is left unfilled.`,
            hint: `Add a "${key}" format to the field's formats, or remove the marker.`,
          },
    );
  }

  return warnings;
};

export const fieldOverlayWarnings = async ({
  conditionPaths,
  fields,
  placeholderPaths,
  registryGate,
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

  // A registry the organization has not enabled is refused by the resolver at
  // every fill, and until now only there: the save that introduced it reported
  // nothing.
  const lookupFields = fields.filter(hasLookup);
  if (lookupFields.length > 0) {
    const isRegistryEnabled = await registryGate();
    for (const { lookup, path } of lookupFields) {
      if (isRegistryEnabled(lookup.registry)) {
        continue;
      }
      warnings.push({
        code: "registry_disabled",
        path,
        message: `Lookup field "${path}" resolves from the ${lookup.registry} registry, which is not enabled for this organization, so every fill of the field fails at lookup time.`,
        hint: `Enable that registry in the organization's tool settings, or replace the lookup on "${path}" with a plain input.`,
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
