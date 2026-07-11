import * as v from "valibot";

import type { TemplateRecipeDefinition } from "@stll/api/types";
import type { ConditionNode } from "@stll/conditions";
import { conditionNodeSchema } from "@stll/conditions";
import { isFieldPath } from "@stll/template-conditions";

import { optionalArray } from "@/lib/arrays";
import { DATE_FORMAT_STYLES } from "@/routes/_protected.knowledge/-components/template-date-format";
import {
  defaultStudioField,
  type OutlineNode,
  type StudioField,
} from "@/routes/_protected.knowledge/-components/template-studio-store";
import {
  defaultCompositeFormat,
  type EditableLookupFormat,
  type EditablePart,
  type FieldValidation,
  isLookupRegistry,
  type TemplateEditableField,
} from "@/routes/_protected.knowledge/-components/template-wizard";
// ── Manifest <-> state ───────────────────────────────────

const INPUT_TYPE_VALUES = [
  "text",
  "number",
  "boolean",
  "date",
  "select",
] as const;

export const isInputType = (
  value: string,
): value is TemplateEditableField["inputType"] =>
  INPUT_TYPE_VALUES.some((type) => type === value);

const trimChar = (value: string, ch: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === ch) {
    start++;
  }
  while (end > start && value[end - 1] === ch) {
    end--;
  }
  return value.slice(start, end);
};

// Derive a field path from selected prose: "Jan Kowalski" -> "jan_kowalski".
/** Lowercase + underscore a typed field name without word-count capping —
 *  "Name of lawyer" becomes a valid path instead of a validation error. */
export const sanitizeFieldPath = (text: string): string => {
  const collapsed = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.]+/gu, "_");
  return trimChar(collapsed, "_").slice(0, 64);
};

export const slugify = (text: string): string => {
  const collapsed = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "_");
  // Long selections make unwieldy paths; the first few words identify the
  // field just as well (the label carries the rest).
  const slug = trimChar(collapsed, "_")
    .split("_")
    .slice(0, 4)
    .join("_")
    .slice(0, 40);
  return slug.length > 0 ? slug : "field";
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Read a non-negative integer attribute, or undefined when absent/invalid. */
const parseBound = (value: unknown): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
};

export const fieldHasLoopBounds = (field: StudioField): boolean =>
  field.validation?.minItems !== undefined ||
  field.validation?.maxItems !== undefined;

/** Parse the full persisted `validation` record verbatim so scalar rules the
 *  Studio UI does not surface (required/minLength/maxLength/min/max/pattern,
 *  authored via prepare/suggest/import) round-trip through a Studio save
 *  instead of being dropped. Returns undefined when nothing is set. */
const parseValidation = (raw: unknown): FieldValidation | undefined => {
  if (!isRecord(raw)) {
    return undefined;
  }
  const validation: FieldValidation = {};
  if (typeof raw["required"] === "boolean") {
    validation.required = raw["required"];
  }
  if (typeof raw["pattern"] === "string") {
    validation.pattern = raw["pattern"];
  }
  const numericKeys = [
    "minLength",
    "maxLength",
    "min",
    "max",
    "minItems",
    "maxItems",
  ] as const;
  for (const key of numericKeys) {
    const bound = parseBound(raw[key]);
    if (bound !== undefined) {
      validation[key] = bound;
    }
  }
  return Object.keys(validation).length > 0 ? validation : undefined;
};

export const parseFields = (manifest: unknown): StudioField[] => {
  if (!isRecord(manifest) || !Array.isArray(manifest["fields"])) {
    return [];
  }
  const fields: StudioField[] = manifest["fields"]
    .filter(isRecord)
    .map((raw) => {
      const rawType = raw["inputType"];
      const inputType =
        typeof rawType === "string" && isInputType(rawType) ? rawType : "text";
      const field: StudioField = {
        path: typeof raw["path"] === "string" ? raw["path"] : "",
        kind: typeof raw["kind"] === "string" ? raw["kind"] : "string",
        label: typeof raw["label"] === "string" ? raw["label"] : "",
        inputType,
        required: raw["required"] === true,
        options: Array.isArray(raw["options"])
          ? raw["options"].filter((o): o is string => typeof o === "string")
          : [],
        aiPrompt:
          typeof raw["aiPrompt"] === "string" ? raw["aiPrompt"] : undefined,
        aiAdapt: raw["aiAdapt"] === true,
        aiSeesDocument: raw["aiSeesDocument"] === true,
      };
      if (typeof raw["optionsFrom"] === "string") {
        field.optionsFrom = raw["optionsFrom"];
      }
      const rawLookup = raw["lookup"];
      if (isRecord(rawLookup) && isLookupRegistry(rawLookup["registry"])) {
        const formats = parseEditableLookupFormats(rawLookup["formats"]);
        if (formats.length > 0) {
          field.lookup = { registry: rawLookup["registry"], formats };
        }
      }
      if (Array.isArray(raw["parts"]) && typeof raw["format"] === "string") {
        field.parts = parseEditableParts(raw["parts"]);
        field.format = raw["format"];
      }
      if (typeof raw["formula"] === "string") {
        field.formula = raw["formula"];
      }
      // A boolean field's value rule: derived by this expression rather than
      // asked. Only meaningful on boolean fields (a condition-field).
      if (typeof raw["condition"] === "string" && inputType === "boolean") {
        field.condition = raw["condition"];
      }
      // AST-backed condition rule (authoritative; the only form for rules that
      // contain a formula operand). Validate against the canonical node schema
      // so a malformed manifest entry is dropped rather than carried verbatim.
      if (raw["conditionAst"] !== undefined && inputType === "boolean") {
        const parsed = v.safeParse(conditionNodeSchema, raw["conditionAst"]);
        if (parsed.success) {
          field.conditionAst = parsed.output;
        }
      }
      if (typeof raw["hint"] === "string") {
        field.hint = raw["hint"];
      }
      const rawDateFormat = raw["dateFormat"];
      if (
        isRecord(rawDateFormat) &&
        typeof rawDateFormat["locale"] === "string"
      ) {
        const style = DATE_FORMAT_STYLES.find(
          (s) => s === rawDateFormat["style"],
        );
        if (style !== undefined) {
          field.dateFormat = { locale: rawDateFormat["locale"], style };
        }
      }
      const validation = parseValidation(raw["validation"]);
      if (validation !== undefined) {
        field.validation = validation;
      }
      return field;
    });

  // Mirror the server merge: namespace parents (a path that is only a dotted
  // prefix of others) are not fillable inputs. This keeps the display clean
  // for templates saved before the server fix landed. A loop-container field
  // (carries `validation.minItems`/`maxItems`) is exempt: it is the bounds
  // record for an `{{#each <path>}}` and its only "child" is the loop body,
  // so it must survive to round-trip the repeat bounds.
  const paths = fields.map((f) => f.path);
  return fields.filter(
    (f) =>
      fieldHasLoopBounds(f) ||
      !paths.some((p) => p !== f.path && p.startsWith(`${f.path}.`)),
  );
};

const parseEditableParts = (raw: unknown[]): EditablePart[] =>
  raw.filter(isRecord).map((part) => ({
    key: typeof part["key"] === "string" ? part["key"] : "",
    label: typeof part["label"] === "string" ? part["label"] : undefined,
    inputType: part["inputType"] === "select" ? "select" : "text",
    options: Array.isArray(part["options"])
      ? part["options"].filter((o): o is string => typeof o === "string")
      : [],
    pattern: typeof part["pattern"] === "string" ? part["pattern"] : undefined,
  }));

/** Parse the persisted lookup `formats` list (the sole carrier of renderings;
 *  the first entry is the default). Rows missing a key or template are
 *  dropped; an empty result drops the lookup entirely upstream. */
const parseEditableLookupFormats = (raw: unknown): EditableLookupFormat[] => {
  if (!Array.isArray(raw)) {
    return [];
  }
  const formats: EditableLookupFormat[] = [];
  for (const entry of raw) {
    if (
      isRecord(entry) &&
      typeof entry["key"] === "string" &&
      typeof entry["template"] === "string"
    ) {
      formats.push({ key: entry["key"], template: entry["template"] });
    }
  }
  return formats;
};

type ManifestField = {
  path: string;
  inputType: TemplateEditableField["inputType"];
  label?: string;
  required?: boolean;
  options?: string[];
  aiPrompt?: string;
  aiAdapt?: boolean;
  aiSeesDocument?: boolean;
  parts?: EditablePart[];
  format?: string;
  optionsFrom?: string;
  lookup?: TemplateEditableField["lookup"];
  formula?: string;
  condition?: string;
  conditionAst?: ConditionNode;
  hint?: string;
  dateFormat?: TemplateEditableField["dateFormat"];
  validation?: FieldValidation;
};

/** One session field as it is persisted: only the settings that are
 *  actually set, in the manifest's `FieldMeta` shape. Shared by the
 *  template manifest build and recipe snapshots. */
const studioFieldToManifestField = (f: StudioField): ManifestField => {
  const field: ManifestField = { path: f.path, inputType: f.inputType };
  if (f.label) {
    field.label = f.label;
  }
  if (f.required) {
    field.required = true;
  }
  if (f.options.length > 0) {
    field.options = f.options;
  }
  if (f.hint !== undefined && f.hint.trim() !== "") {
    field.hint = f.hint.trim();
  }
  if (f.dateFormat !== undefined && f.inputType === "date") {
    field.dateFormat = f.dateFormat;
  }
  // Re-emit the full validation record verbatim before the value-source early
  // returns: loop repeat bounds ride on the array-container FieldMeta (a
  // bounds-only container record has no marker of its own), and scalar rules
  // the Studio UI does not surface (required/minLength/maxLength/min/max/
  // pattern, authored via prepare/suggest/import) must round-trip rather than
  // be dropped on save.
  if (f.validation !== undefined && Object.keys(f.validation).length > 0) {
    field.validation = f.validation;
  }
  // A formula is one of the mutually exclusive value sources; the manifest
  // validator rejects it next to aiPrompt/aiAdapt/lookup/parts, and a
  // composite configuration takes precedence (mirrors the wizard's emit).
  const formula = f.parts === undefined ? (f.formula?.trim() ?? "") : "";
  if (formula !== "") {
    field.formula = formula;
    return field;
  }
  // A boolean condition-field DERIVED by rule. The AST is authoritative (the
  // only form for a rule containing a formula operand); otherwise the
  // `condition` expression. Both are mutually exclusive with the other value
  // sources (backend-validated).
  if (f.inputType === "boolean" && f.conditionAst !== undefined) {
    field.conditionAst = f.conditionAst;
    return field;
  }
  const condition =
    f.inputType === "boolean" ? (f.condition?.trim() ?? "") : "";
  if (condition !== "") {
    field.condition = condition;
    return field;
  }
  if (f.aiPrompt) {
    field.aiPrompt = f.aiPrompt;
  }
  if (f.aiAdapt) {
    field.aiAdapt = true;
  }
  // Only an AI-drafted field (aiPrompt) reads the document; the flag is
  // meaningless without one, so do not persist a stale opt-in.
  if (f.aiSeesDocument && f.aiPrompt) {
    field.aiSeesDocument = true;
  }
  if (f.optionsFrom !== undefined && f.inputType === "select") {
    field.optionsFrom = f.optionsFrom;
  }
  if (f.lookup !== undefined) {
    field.lookup = f.lookup;
  }
  if (f.parts !== undefined && f.parts.length > 0) {
    // Mirror the wizard: an untyped format defaults to the part keys joined
    // by spaces, so a composite configured in the face never silently saves
    // as a plain field.
    const format = f.format?.trim() || defaultCompositeFormat(f.parts);
    if (format !== undefined && format !== "") {
      field.parts = f.parts;
      field.format = format;
    }
  }
  return field;
};

export const buildManifest = (original: unknown, fields: StudioField[]) => {
  const version =
    isRecord(original) && typeof original["version"] === "number"
      ? original["version"]
      : 1;
  return {
    version,
    fields: fields.filter((f) => f.path).map(studioFieldToManifestField),
  };
};

// ── Recipes (saved structural blocks) ────────────────────

type RecipeField = TemplateRecipeDefinition["fields"][number];

const outlineFieldPaths = (nodes: OutlineNode[]): Set<string> => {
  const paths = new Set<string>();
  for (const node of nodes) {
    if (node.type === "field") {
      paths.add(node.path);
    }
    if (node.type === "group") {
      for (const path of outlineFieldPaths(node.children)) {
        paths.add(path);
      }
    }
  }
  return paths;
};

export type OutlineGroup = Extract<OutlineNode, { type: "group" }>;

/** Innermost `{{#each}}` group whose subtree contains the field's marker. */
export const findEnclosingEachGroup = (
  nodes: OutlineNode[],
  path: string,
  enclosing: OutlineGroup | null,
): OutlineGroup | null => {
  for (const node of nodes) {
    if (node.type === "field" && node.path === path && enclosing !== null) {
      return enclosing;
    }
    if (node.type === "group") {
      const next = node.kind === "each" ? node : enclosing;
      const found = findEnclosingEachGroup(node.children, path, next);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
};

/** Innermost `if`/`elseif`/`else` group whose subtree contains the field's
 *  marker. Mirrors findEnclosingEachGroup but for condition branches. */
export const findEnclosingIfGroup = (
  nodes: OutlineNode[],
  path: string,
  enclosing: OutlineGroup | null,
): OutlineGroup | null => {
  for (const node of nodes) {
    if (node.type === "field" && node.path === path && enclosing !== null) {
      return enclosing;
    }
    if (node.type === "group") {
      const branch =
        node.kind === "if" || node.kind === "elseif" || node.kind === "else";
      const next = branch ? node : enclosing;
      const found = findEnclosingIfGroup(node.children, path, next);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
};

/** Snapshot a recipe from the live session: when the field's marker sits
 *  inside a `{{#each}}` block, the recipe is the whole block (loop path +
 *  every field used inside it); otherwise just this field's config. */
export const buildRecipeDefinition = (
  fieldPath: string,
  outline: OutlineNode[],
  fields: StudioField[],
): TemplateRecipeDefinition => {
  const group = findEnclosingEachGroup(outline, fieldPath, null);
  const loopPath =
    group !== null && isFieldPath(group.expr) ? group.expr : null;
  const paths =
    group !== null && loopPath !== null
      ? [...outlineFieldPaths(group.children)]
      : [fieldPath];
  const recipeFields = paths.map((path) => {
    const field =
      fields.find((f) => f.path === path) ?? defaultStudioField(path);
    // The recipe schema is a strict FieldMeta subset without formula,
    // validation, or condition; strip them so saving a recipe passes boundary
    // validation (the snapshot keeps the field's label and type; the formula,
    // condition rule, and loop repeat bounds stay template-local).
    const {
      formula: _formula,
      validation: _validation,
      condition: _condition,
      conditionAst: _conditionAst,
      ...recipeField
    } = studioFieldToManifestField(field);
    return recipeField;
  });
  if (loopPath === null) {
    return { fields: recipeFields };
  }
  return { fields: recipeFields, loop: { path: loopPath } };
};

export const nextFreePath = (
  base: string,
  isTaken: (candidate: string) => boolean,
): string => {
  let path = base;
  for (let n = 2; isTaken(path); n++) {
    path = `${base}_${n}`;
  }
  return path;
};

type PreparedRecipeField = { path: string; config: Partial<StudioField> };

type PreparedRecipe = {
  loopPath: string | null;
  fields: PreparedRecipeField[];
};

/** Resolve the recipe's paths against the session so inserting never
 *  clobbers existing fields: a conflicting loop renames its whole namespace
 *  at once (`persons` -> `persons_2`, fields move with it), conflicting
 *  plain fields get a `_2` suffix individually (like makeField). */
export const prepareRecipeInsert = (
  definition: TemplateRecipeDefinition,
  existing: StudioField[],
): PreparedRecipe => {
  const taken = new Set(existing.map((f) => f.path));

  let loopPath: string | null = null;
  let mapPath = (path: string): string => path;
  if (definition.loop !== undefined) {
    const base = definition.loop.path;
    loopPath = nextFreePath(base, (candidate) =>
      existing.some(
        (f) => f.path === candidate || f.path.startsWith(`${candidate}.`),
      ),
    );
    const renamed = loopPath;
    mapPath = (path) => {
      if (path === base) {
        return renamed;
      }
      if (path.startsWith(`${base}.`)) {
        return `${renamed}${path.slice(base.length)}`;
      }
      return path;
    };
  }

  // Track each recipe field's original path -> final inserted path so
  // reference metadata (e.g. `optionsFrom`) can be rewritten to point at the
  // inserted source field instead of the original/now-renamed recipe path.
  const renames = new Map<string, string>();
  const prepared: { field: RecipeField; path: string }[] = [];
  for (const field of definition.fields) {
    const path = nextFreePath(mapPath(field.path), (candidate) =>
      taken.has(candidate),
    );
    taken.add(path);
    renames.set(field.path, path);
    prepared.push({ field, path });
  }
  const remapReference = (reference: string): string =>
    renames.get(reference) ?? mapPath(reference);
  const fields: PreparedRecipeField[] = prepared.map(({ field, path }) => ({
    path,
    config: recipeFieldToStudioPatch(field, remapReference),
  }));
  return { loopPath, fields };
};

/** The saved recipe field config as an upsertField patch (path excluded:
 *  the prepared, conflict-free path is passed separately). `remapReference`
 *  rewrites field-path references (e.g. `optionsFrom`) through the same
 *  loop/per-field renames applied to the inserted fields. */
const recipeFieldToStudioPatch = (
  field: RecipeField,
  remapReference: (reference: string) => string,
): Partial<StudioField> => {
  const patch: Partial<StudioField> = {
    label: field.label ?? "",
    inputType: field.inputType ?? "text",
    required: field.required === true,
    options: optionalArray(field.options),
    aiPrompt: field.aiPrompt,
    aiAdapt: field.aiAdapt === true,
    aiSeesDocument: field.aiSeesDocument === true,
  };
  if (field.hint !== undefined) {
    patch.hint = field.hint;
  }
  if (field.dateFormat !== undefined) {
    patch.dateFormat = field.dateFormat;
  }
  if (field.optionsFrom !== undefined) {
    patch.optionsFrom = remapReference(field.optionsFrom);
  }
  if (field.lookup !== undefined) {
    patch.lookup = field.lookup;
  }
  if (field.parts !== undefined && field.format !== undefined) {
    patch.parts = field.parts.map((part) => ({
      key: part.key,
      label: part.label,
      inputType: part.inputType,
      options: optionalArray(part.options),
      pattern: part.pattern,
    }));
    patch.format = field.format;
  }
  return patch;
};
