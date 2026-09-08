/**
 * The manifest merge: what a template's fields are, once the configuration its
 * markers declare meets the structure discovery found.
 *
 * The DOCX is the template, so the field metadata comes from the marker filter
 * chains (`lib/docx/field-filters.ts`); this module says how that metadata and
 * the document's structure (a field's kind, its occurrence count, the items a
 * repeat holds, the condition that gates it) become the one resolved field list
 * the fill form asks and the agent reads. `lib/docx/derived-manifest.ts`
 * is the only caller that should assemble a manifest from these.
 */

import { arrayOrEmpty } from "@/api/lib/array";

import type {
  DiscoveredField,
  DiscoveredTemplate,
  FieldMeta,
  InputType,
  ResolvedField,
  TemplateManifest,
} from "./types";

/**
 * Markers a lookup field's named formats own (`company.name`, `company.krs`,
 * …): each renders the one resolved hit through its own template, so they are
 * outputs of a single input rather than fillable fields of their own. Every
 * consumer that decides "is this dotted path a field?" reads this set, so the
 * manifest merge and the configure service cannot disagree about it.
 */
export const lookupFormatMarkerPaths = (
  fields: readonly FieldMeta[],
): Set<string> => {
  const markers = new Set<string>();
  for (const field of fields) {
    for (const format of arrayOrEmpty(field.lookup?.formats)) {
      markers.add(`${field.path}.${format.key}`);
    }
  }
  return markers;
};

/** The manifest properties a resolved field carries back. Named so the
 *  projection below stays one list, not one per caller. */
const toFieldMeta = (field: ResolvedField): FieldMeta => ({
  path: field.path,
  label: field.label,
  hint: field.hint,
  inputType: field.inputType,
  options: field.options,
  validation: field.validation,
  required: field.required,
  aiPrompt: field.aiPrompt,
  aiAdapt: field.aiAdapt,
  aiSeesDocument: field.aiSeesDocument,
  optionsFrom: field.optionsFrom,
  lookup: field.lookup,
  source: field.source,
  formula: field.formula,
  condition: field.condition,
  conditionAst: field.conditionAst,
  dateFormat: field.dateFormat,
});

/**
 * The manifest field list a merge produces: one entry per resolved field, plus
 * the loop-item entries the merge folded into their array root's `itemFields`.
 * A loop item (`attorneys.name`) is a manifest field in its own right — the
 * fill form asks it once per row and the field reference documents it as such
 * — but it is never a top-level `ResolvedField`, so building the manifest from
 * the resolved list alone silently discarded every item-field configuration.
 *
 * Format markers of a lookup are excluded: those are renderings of the one
 * resolved hit, not fields (see {@link lookupFormatMarkerPaths}).
 */
export const manifestFieldsFromMerge = (
  resolved: readonly ResolvedField[],
  manifest: TemplateManifest | null,
): FieldMeta[] => {
  const fields = resolved.map(toFieldMeta);
  const arrayRoots = new Set(
    resolved.filter((field) => field.kind === "array").map(({ path }) => path),
  );
  const formatMarkers = lookupFormatMarkerPaths(arrayOrEmpty(manifest?.fields));
  const claimed = new Set(fields.map(({ path }) => path));
  for (const field of arrayOrEmpty(manifest?.fields)) {
    const root = field.path.split(".").at(0);
    if (
      claimed.has(field.path) ||
      formatMarkers.has(field.path) ||
      root === undefined ||
      root === field.path ||
      !arrayRoots.has(root)
    ) {
      continue;
    }
    fields.push(field);
  }
  return fields;
};

/**
 * Merge manifest field metadata with auto-discovered fields
 * to produce a fully resolved schema. Manifest metadata takes
 * precedence; discovery fills in gaps for fields without
 * manifest entries.
 */
export const mergeManifestWithDiscovery = (
  manifest: TemplateManifest | null,
  discovered: DiscoveredTemplate,
): ResolvedField[] => {
  // Index manifest fields by path
  const metaByPath = new Map<string, FieldMeta>();
  const lookupFormatMarkers = lookupFormatMarkerPaths(
    arrayOrEmpty(manifest?.fields),
  );
  if (manifest) {
    for (const f of manifest.fields) {
      metaByPath.set(f.path, f);
    }
  }

  // Start with discovered fields, enriching with manifest
  const resolved: ResolvedField[] = [];
  const seen = new Set<string>();
  const arrayRoots = new Set<string>();

  for (const df of discovered.fields) {
    seen.add(df.path);
    if (df.kind === "array") {
      arrayRoots.add(df.path);
    }
    const meta = metaByPath.get(df.path);
    resolved.push(mergeField(df, meta, metaByPath));
  }

  // Add manifest-only fields (not discovered)
  if (manifest) {
    for (const f of manifest.fields) {
      if (seen.has(f.path)) {
        continue;
      }
      // Loop-item metadata (e.g. "lawyers.name" under a discovered
      // {% for lawyer in lawyers %}) merges into the array's itemFields above; adding
      // it as a flat field would shadow the array root in the prefix filter
      // below and break the array rendering.
      const root = f.path.split(".").at(0);
      if (root !== undefined && root !== f.path && arrayRoots.has(root)) {
        continue;
      }
      resolved.push({
        path: f.path,
        kind: inputTypeToFieldKind(f.inputType),
        count: 0,
        label: f.label,
        hint: f.hint,
        inputType: f.inputType,
        options: f.options,
        validation: f.validation,
        required: f.required,
        aiAdapt: f.aiAdapt,
        aiPrompt: f.aiPrompt,
        aiSeesDocument: f.aiSeesDocument,
        optionsFrom: f.optionsFrom,
        lookup: f.lookup,
        source: f.source,
        formula: f.formula,
        condition: f.condition,
        conditionAst: f.conditionAst,
        dateFormat: f.dateFormat,
      });
    }
  }

  // Drop namespace parents: a path that is ONLY a dotted prefix of others
  // (e.g. "tenant" when "tenant.name"/"tenant.krs" exist) is structural, not a
  // fillable field. Discovery registers such roots to infer object/array kinds.
  //
  // Three kinds of path are not structural and survive the prefix filter:
  //  - a lookup field, a real leaf input whose dotted format markers
  //    ({{company.krs}}) are renderings of its one resolved hit;
  //  - an array, a value-bearing loop input whose items are dotted;
  //  - a path the document writes as its own {{marker}}. Dropping that one left
  //    the marker with no field behind it, so it survived fill as literal text.
  const markerPaths = new Set(
    discovered.placeholders.map((placeholder) => placeholder.name),
  );
  const paths = resolved.map((f) => f.path);
  return resolved.filter((f) => {
    if (lookupFormatMarkers.has(f.path)) {
      return false;
    }
    if (
      f.lookup !== undefined ||
      f.kind === "array" ||
      markerPaths.has(f.path)
    ) {
      return true;
    }
    return !paths.some((p) => p !== f.path && p.startsWith(`${f.path}.`));
  });
};

// ── Helpers ──────────────────────────────────────────────

const mergeField = (
  discovered: DiscoveredField,
  meta?: FieldMeta,
  metaByPath?: ReadonlyMap<string, FieldMeta>,
): ResolvedField => {
  const resolved: ResolvedField = {
    path: discovered.path,
    kind: discovered.kind,
    count: discovered.count,
  };

  if (meta) {
    if (meta.label !== undefined) {
      resolved.label = meta.label;
    }
    if (meta.hint !== undefined) {
      resolved.hint = meta.hint;
    }
    if (meta.inputType) {
      resolved.inputType = meta.inputType;
    }
    if (meta.options) {
      resolved.options = meta.options;
    }
    if (meta.validation) {
      resolved.validation = meta.validation;
    }
    if (meta.required !== undefined) {
      resolved.required = meta.required;
    }
    if (meta.aiAdapt !== undefined) {
      resolved.aiAdapt = meta.aiAdapt;
    }
    if (meta.aiPrompt !== undefined) {
      resolved.aiPrompt = meta.aiPrompt;
    }
    if (meta.aiSeesDocument !== undefined) {
      resolved.aiSeesDocument = meta.aiSeesDocument;
    }
    if (meta.optionsFrom !== undefined) {
      resolved.optionsFrom = meta.optionsFrom;
    }
    if (meta.lookup !== undefined) {
      resolved.lookup = meta.lookup;
    }
    // A discovered placeholder that also carries a data binding in the manifest
    // keeps that binding on save (the common case); without this, `source` is
    // preserved only for manifest-only fields and a bound in-document field
    // loses its binding on every round-trip. Mirrors lookup/formula above.
    if (meta.source !== undefined) {
      resolved.source = meta.source;
    }
    if (meta.formula !== undefined) {
      resolved.formula = meta.formula;
    }
    if (meta.condition !== undefined) {
      resolved.condition = meta.condition;
    }
    if (meta.conditionAst !== undefined) {
      resolved.conditionAst = meta.conditionAst;
    }
    if (meta.dateFormat !== undefined) {
      resolved.dateFormat = meta.dateFormat;
    }
  }

  // Preserve visibleWhen from discovery
  if (discovered.visibleWhen !== undefined) {
    resolved.visibleWhen = discovered.visibleWhen;
  }

  if (discovered.itemFields) {
    // Item paths are relative to the array root; their manifest entries are
    // stored dotted ("lawyers.name"), so resolve item metadata through the
    // full path.
    resolved.itemFields = discovered.itemFields.map((item) =>
      mergeField(item, metaByPath?.get(`${discovered.path}.${item.path}`)),
    );
  }

  return resolved;
};

const inputTypeToFieldKind = (
  inputType: InputType | undefined,
): ResolvedField["kind"] => {
  if (!inputType) {
    return "string";
  }

  switch (inputType) {
    case "boolean":
      return "boolean";
    case "number": // numbers are strings in templates
    case "date":
    case "select":
    case "text":
      return "string";
    default:
      return "string";
  }
};
