/**
 * Custom XML Manifest for DOCX templates.
 *
 * Stores field metadata (labels, input types, validation)
 * inside the DOCX as a Custom XML Part
 * (`customXml/item1.xml`) — standard OOXML mechanism, ignored
 * by Word, self-contained in one file.
 *
 * Filled documents must NOT contain this metadata (information
 * leak risk). The manifest is stripped during `fillTemplate()`.
 */

import { Result } from "better-result";
import JSZip from "jszip";
import * as slimdom from "slimdom";
import * as valibot from "valibot";

import type { ConditionNode } from "@stll/conditions";
import { conditionNodeSchema } from "@stll/conditions";
import { isFieldPath } from "@stll/template-conditions";

import { arrayOrEmpty } from "@/api/lib/array";
import { compareCodepoint } from "@/api/lib/collation";

import { isElement } from "./ooxml";
import type {
  DiscoveredField,
  DiscoveredTemplate,
  FieldDateFormat,
  FieldLookup,
  FieldLookupFormat,
  FieldMeta,
  FieldPart,
  FieldSource,
  FieldValidation,
  InputType,
  LookupRegistry,
  PartInputType,
  ResolvedField,
  TemplateManifest,
} from "./types";
import {
  isFieldDateFormat,
  isFieldSource,
  isLookupFormatKey,
  LOOKUP_FORMAT_TEMPLATE_MAX_LENGTH,
  LOOKUP_FORMATS_MAX,
  LOOKUP_REGISTRIES,
} from "./types";

// ── Constants ────────────────────────────────────────────

export const MANIFEST_NS = "urn:stella:template:v1";

// Custom XML parts live in numbered slots (`customXml/item{N}.xml`). The slot
// is NOT fixed at 1: real Word documents commonly ship their own custom XML at
// item1 (bibliography sources, custom doc properties, content-control bindings,
// SharePoint metadata). The manifest is located by namespace and written to a
// free slot, never assuming item1 is ours.
const customXmlItemPathForIndex = (index: string): string =>
  `customXml/item${index}.xml`;
const customXmlPropsPathForIndex = (index: string): string =>
  `customXml/itemProps${index}.xml`;
const customXmlRelsPathForIndex = (index: string): string =>
  `customXml/_rels/item${index}.xml.rels`;
const customXmlItemPath = (slot: number): string =>
  customXmlItemPathForIndex(String(slot));
const customXmlPropsPath = (slot: number): string =>
  customXmlPropsPathForIndex(String(slot));
const customXmlRelsPath = (slot: number): string =>
  customXmlRelsPathForIndex(String(slot));

/** Matches any custom XML data or props part to read its slot index
 *  (used to find the next free slot). */
const CUSTOM_XML_INDEX_RE =
  /^customXml\/(?:item|itemProps)(?<index>\d+)\.xml$/u;

/** Matches only data parts (`item{N}.xml`), where a manifest can live. */
const CUSTOM_XML_DATA_RE = /^customXml\/item(?<index>\d+)\.xml$/u;

const parseCustomXmlSlotIndex = (index: string): number | null => {
  const slot = Number(index);
  return Number.isSafeInteger(slot) && slot > 0 ? slot : null;
};

/** Escape every regex meta-character (including `\`) for literal matching. */
const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

const CONTENT_TYPES_PATH = "[Content_Types].xml";

const CUSTOM_XML_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.customXmlProperties+xml";

const CUSTOM_XML_PROPS_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps";

// ── Current manifest version ─────────────────────────────

const CURRENT_VERSION = 1;
const CONDITION_AST_VERSION = "1";

// ── Input type validation ────────────────────────────────

const INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "number",
  "boolean",
  "date",
  "select",
]);

const isInputType = (value: string): value is InputType =>
  INPUT_TYPES.has(value);

const isPartInputType = (value: string): value is PartInputType =>
  value === "text" || value === "select";

const isLookupRegistry = (value: string): value is LookupRegistry =>
  LOOKUP_REGISTRIES.some((registry) => registry === value);

// ── XML builders ─────────────────────────────────────────

const escapeXml = (s: string): string =>
  s
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");

const buildConditionAstAttrs = (conditionAst: ConditionNode): string[] => [
  `conditionAstVersion="${CONDITION_AST_VERSION}"`,
  `conditionAst="${escapeXml(JSON.stringify(conditionAst))}"`,
];

const buildOptionsXml = (options: readonly string[]): string => {
  const optionElements = options
    .map((o) => `<st:option value="${escapeXml(o)}"/>`)
    .join("");
  return `<st:options>${optionElements}</st:options>`;
};

const buildPartXml = (part: FieldPart): string => {
  const attrs: string[] = [
    `key="${escapeXml(part.key)}"`,
    `inputType="${escapeXml(part.inputType)}"`,
  ];
  if (part.label !== undefined) {
    attrs.push(`label="${escapeXml(part.label)}"`);
  }
  if (part.pattern !== undefined) {
    attrs.push(`pattern="${escapeXml(part.pattern)}"`);
  }
  if (part.options && part.options.length > 0) {
    return `<st:part ${attrs.join(" ")}>${buildOptionsXml(part.options)}</st:part>`;
  }
  return `<st:part ${attrs.join(" ")}/>`;
};

const buildLookupXml = (lookup: FieldLookup): string => {
  const registryAttr = `registry="${escapeXml(lookup.registry)}"`;
  // The formats list is the sole carrier of renderings; the first child is the
  // default for the bare marker, the rest are keyed `{{path.key}}` renderings.
  const formatEls = lookup.formats
    .map(
      (f) =>
        `<st:lookupFormat key="${escapeXml(f.key)}"` +
        ` template="${escapeXml(f.template)}"/>`,
    )
    .join("");
  return (
    `<st:lookup ${registryAttr}>` +
    `<st:lookupFormats>${formatEls}</st:lookupFormats>` +
    "</st:lookup>"
  );
};

const buildDateFormatXml = (dateFormat: FieldDateFormat): string =>
  `<st:dateFormat locale="${escapeXml(dateFormat.locale)}"` +
  ` style="${escapeXml(dateFormat.style)}"/>`;

const buildSourceXml = (source: FieldSource): string => {
  const attrs: string[] = [`kind="${escapeXml(source.kind)}"`];
  if (source.kind === "party") {
    attrs.push(`role="${escapeXml(source.role)}"`);
  }
  if (source.kind === "attorney") {
    attrs.push(`ref="${escapeXml(source.ref)}"`);
  }
  attrs.push(`field="${escapeXml(source.field)}"`);
  return `<st:source ${attrs.join(" ")}/>`;
};

const buildFieldXml = (field: FieldMeta): string => {
  const attrs: string[] = [`path="${escapeXml(field.path)}"`];
  if (field.label !== undefined) {
    attrs.push(`label="${escapeXml(field.label)}"`);
  }
  if (field.hint !== undefined) {
    attrs.push(`hint="${escapeXml(field.hint)}"`);
  }
  if (field.inputType) {
    attrs.push(`inputType="${escapeXml(field.inputType)}"`);
  }
  if (field.required !== undefined) {
    attrs.push(`required="${field.required}"`);
  }
  if (field.aiPrompt !== undefined) {
    attrs.push(`aiPrompt="${escapeXml(field.aiPrompt)}"`);
  }
  if (field.aiAdapt !== undefined) {
    attrs.push(`aiAdapt="${field.aiAdapt}"`);
  }
  if (field.aiSeesDocument !== undefined) {
    attrs.push(`aiSeesDocument="${field.aiSeesDocument}"`);
  }
  if (field.format !== undefined) {
    attrs.push(`format="${escapeXml(field.format)}"`);
  }
  if (field.optionsFrom !== undefined) {
    attrs.push(`optionsFrom="${escapeXml(field.optionsFrom)}"`);
  }
  if (field.formula !== undefined) {
    attrs.push(`formula="${escapeXml(field.formula)}"`);
  }
  if (field.condition !== undefined) {
    attrs.push(`condition="${escapeXml(field.condition)}"`);
  }
  if (field.conditionAst !== undefined) {
    attrs.push(...buildConditionAstAttrs(field.conditionAst));
  }

  const children: string[] = [];

  if (field.options && field.options.length > 0) {
    children.push(buildOptionsXml(field.options));
  }

  if (field.parts && field.parts.length > 0) {
    children.push(
      `<st:parts>${field.parts.map(buildPartXml).join("")}</st:parts>`,
    );
  }

  if (field.lookup) {
    children.push(buildLookupXml(field.lookup));
  }

  if (field.dateFormat) {
    children.push(buildDateFormatXml(field.dateFormat));
  }

  if (field.source) {
    children.push(buildSourceXml(field.source));
  }

  if (field.validation) {
    const v = field.validation;
    const vAttrs: string[] = [];
    if (v.required !== undefined) {
      vAttrs.push(`required="${v.required}"`);
    }
    if (v.minLength !== undefined) {
      vAttrs.push(`minLength="${v.minLength}"`);
    }
    if (v.maxLength !== undefined) {
      vAttrs.push(`maxLength="${v.maxLength}"`);
    }
    if (v.pattern !== undefined) {
      vAttrs.push(`pattern="${escapeXml(v.pattern)}"`);
    }
    if (v.minItems !== undefined) {
      vAttrs.push(`minItems="${v.minItems}"`);
    }
    if (v.maxItems !== undefined) {
      vAttrs.push(`maxItems="${v.maxItems}"`);
    }
    if (vAttrs.length > 0) {
      children.push(`<st:validation ${vAttrs.join(" ")}/>`);
    }
  }

  if (children.length === 0) {
    return `<st:field ${attrs.join(" ")}/>`;
  }
  return `<st:field ${attrs.join(" ")}>${children.join("")}</st:field>`;
};

const buildManifestXml = (manifest: TemplateManifest): string => {
  const fields = manifest.fields.map(buildFieldXml).join("");

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<st:template xmlns:st="${MANIFEST_NS}"`,
    ` version="${manifest.version}">`,
    fields ? `<st:fields>${fields}</st:fields>` : "",
    "</st:template>",
  ].join("");
};

const buildItemPropsXml = (): string =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    "<ds:datastoreItem",
    ' xmlns:ds="http://schemas.openxmlformats.org',
    '/officeDocument/2006/customXml"',
    ` ds:itemID="{STELLA-TEMPLATE-MANIFEST}">`,
    "<ds:schemaRefs>",
    `<ds:schemaRef ds:uri="${MANIFEST_NS}"/>`,
    "</ds:schemaRefs>",
    "</ds:datastoreItem>",
  ].join("");

const buildItemRelsXml = (slot: number): string =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org',
    '/package/2006/relationships">',
    `<Relationship Id="rId1"`,
    ` Type="${CUSTOM_XML_PROPS_REL_TYPE}"`,
    ` Target="itemProps${String(slot)}.xml"/>`,
    "</Relationships>",
  ].join("");

// ── XML parsing ──────────────────────────────────────────

const getElementChildren = (
  parent: slimdom.Element,
  localName: string,
): slimdom.Element[] => {
  const result: slimdom.Element[] = [];
  for (const child of parent.childNodes) {
    if (isElement(child) && child.localName === localName) {
      result.push(child);
    }
  }
  return result;
};

const getFirstElementChild = (
  parent: slimdom.Element,
  localName: string,
): slimdom.Element | null => {
  for (const child of parent.childNodes) {
    if (isElement(child) && child.localName === localName) {
      return child;
    }
  }
  return null;
};

const parseConditionAst = ({
  version,
  value,
}: {
  version: string | null;
  value: string | null;
}): ConditionNode | undefined => {
  if (version !== CONDITION_AST_VERSION) {
    return undefined;
  }
  if (value === null) {
    return undefined;
  }

  const parsed = Result.try((): unknown => JSON.parse(value));
  if (Result.isError(parsed)) {
    return undefined;
  }

  return valibot.is(conditionNodeSchema, parsed.value)
    ? parsed.value
    : undefined;
};

const parseFieldPart = (el: slimdom.Element): FieldPart | null => {
  const key = el.getAttribute("key");
  if (key === null || !isFieldPath(key)) {
    return null;
  }

  const rawType = el.getAttribute("inputType");
  const part: FieldPart = {
    key,
    inputType: rawType !== null && isPartInputType(rawType) ? rawType : "text",
  };

  const label = el.getAttribute("label");
  if (label !== null) {
    part.label = label;
  }
  const pattern = el.getAttribute("pattern");
  if (pattern !== null) {
    part.pattern = pattern;
  }

  const optionsEl = getFirstElementChild(el, "options");
  if (optionsEl) {
    const options = getElementChildren(optionsEl, "option")
      .map((o) => o.getAttribute("value"))
      .filter((v): v is string => v !== null);
    if (options.length > 0) {
      part.options = options;
    }
  }

  return part;
};

const parseFieldSource = (el: slimdom.Element): FieldSource | null => {
  const candidate = {
    kind: el.getAttribute("kind"),
    role: el.getAttribute("role"),
    ref: el.getAttribute("ref"),
    field: el.getAttribute("field"),
  };
  if (!isFieldSource(candidate)) {
    return null;
  }
  // Reconstruct the exact per-kind shape: isFieldSource ignores irrelevant
  // attributes, but the stored binding must match its union member so a
  // contact/matter/firm source never carries a stray role/ref from hand-edited
  // XML, and a round-tripped source compares equal to its input.
  switch (candidate.kind) {
    case "party":
      return { kind: "party", role: candidate.role, field: candidate.field };
    case "attorney":
      return { kind: "attorney", ref: candidate.ref, field: candidate.field };
    case "contact":
      return { kind: "contact", field: candidate.field };
    case "matter":
      return { kind: "matter", field: candidate.field };
    case "firm":
      return { kind: "firm", field: candidate.field };
    default: {
      const exhaustive: never = candidate;
      return exhaustive;
    }
  }
};

const parseFieldMeta = (el: slimdom.Element): FieldMeta => {
  const path = el.getAttribute("path") ?? "";
  const label = el.getAttribute("label") ?? undefined;
  const rawInputType = el.getAttribute("inputType");
  const inputType =
    rawInputType && isInputType(rawInputType) ? rawInputType : undefined;
  const requiredAttr = el.getAttribute("required");
  const required = requiredAttr !== null ? requiredAttr === "true" : undefined;

  const field: FieldMeta = { path };
  if (label !== undefined) {
    field.label = label;
  }
  const hint = el.getAttribute("hint");
  if (hint !== null) {
    field.hint = hint;
  }
  if (inputType) {
    field.inputType = inputType;
  }
  if (required !== undefined) {
    field.required = required;
  }
  const aiPrompt = el.getAttribute("aiPrompt");
  if (aiPrompt !== null) {
    field.aiPrompt = aiPrompt;
  }
  const aiAdapt = el.getAttribute("aiAdapt");
  if (aiAdapt !== null) {
    field.aiAdapt = aiAdapt === "true";
  }
  const aiSeesDocument = el.getAttribute("aiSeesDocument");
  if (aiSeesDocument !== null) {
    field.aiSeesDocument = aiSeesDocument === "true";
  }
  // A hand-edited value outside the field-path grammar is dropped so the
  // isFieldMeta invariant holds downstream.
  const optionsFrom = el.getAttribute("optionsFrom");
  if (optionsFrom !== null && isFieldPath(optionsFrom)) {
    field.optionsFrom = optionsFrom;
  }

  // Parse options
  const optionsEl = getFirstElementChild(el, "options");
  if (optionsEl) {
    const optionEls = getElementChildren(optionsEl, "option");
    const options = optionEls
      .map((o) => o.getAttribute("value"))
      .filter((v): v is string => v !== null);
    if (options.length > 0) {
      field.options = options;
    }
  }

  // Parse validation
  const validationEl = getFirstElementChild(el, "validation");
  if (validationEl) {
    const validation: FieldValidation = {};
    const vRequired = validationEl.getAttribute("required");
    if (vRequired !== null) {
      validation.required = vRequired === "true";
    }
    const minLen = validationEl.getAttribute("minLength");
    if (minLen !== null) {
      const parsed = Number.parseInt(minLen, 10);
      if (Number.isFinite(parsed)) {
        validation.minLength = parsed;
      }
    }
    const maxLen = validationEl.getAttribute("maxLength");
    if (maxLen !== null) {
      const parsed = Number.parseInt(maxLen, 10);
      if (Number.isFinite(parsed)) {
        validation.maxLength = parsed;
      }
    }
    const pattern = validationEl.getAttribute("pattern");
    if (pattern !== null) {
      validation.pattern = pattern;
    }
    const minItems = validationEl.getAttribute("minItems");
    if (minItems !== null) {
      const parsed = Number.parseInt(minItems, 10);
      if (Number.isFinite(parsed)) {
        validation.minItems = parsed;
      }
    }
    const maxItems = validationEl.getAttribute("maxItems");
    if (maxItems !== null) {
      const parsed = Number.parseInt(maxItems, 10);
      if (Number.isFinite(parsed)) {
        validation.maxItems = parsed;
      }
    }
    if (Object.keys(validation).length > 0) {
      field.validation = validation;
    }
  }

  // A hand-edited registry outside the supported set is dropped so the
  // isFieldMeta invariant holds downstream.
  const lookupEl = getFirstElementChild(el, "lookup");
  if (lookupEl) {
    const registry = lookupEl.getAttribute("registry");
    if (registry !== null && isLookupRegistry(registry)) {
      // Output formats round-trip nested under the lookup element; the first
      // child is the default for the bare marker. A hand-edited key outside the
      // segment grammar or an over-long template is dropped, and a lookup with
      // no valid format is itself dropped so the isFieldLookup invariant holds.
      const formats: FieldLookupFormat[] = [];
      const formatsEl = getFirstElementChild(lookupEl, "lookupFormats");
      if (formatsEl) {
        for (const formatEl of getElementChildren(formatsEl, "lookupFormat")) {
          const key = formatEl.getAttribute("key");
          const template = formatEl.getAttribute("template");
          if (
            key !== null &&
            isLookupFormatKey(key) &&
            template !== null &&
            template.length <= LOOKUP_FORMAT_TEMPLATE_MAX_LENGTH
          ) {
            formats.push({ key, template });
          }
        }
      }
      if (formats.length > 0) {
        field.lookup = {
          registry,
          formats: formats.slice(0, LOOKUP_FORMATS_MAX),
        };
      }
    }
  }

  // A hand-edited locale that is not a plausible BCP-47 tag (or an unknown
  // style) is dropped so the isFieldMeta invariant holds downstream.
  const dateFormatEl = getFirstElementChild(el, "dateFormat");
  if (dateFormatEl) {
    const candidate = {
      locale: dateFormatEl.getAttribute("locale"),
      style: dateFormatEl.getAttribute("style"),
    };
    if (isFieldDateFormat(candidate)) {
      field.dateFormat = candidate;
    }
  }

  // parts + format round-trip together; a half-shape (hand-edited XML) is
  // dropped so the "both present or both absent" invariant holds downstream.
  const format = el.getAttribute("format");
  const partsEl = getFirstElementChild(el, "parts");
  const parts =
    partsEl === null
      ? []
      : getElementChildren(partsEl, "part")
          .map(parseFieldPart)
          .filter((part): part is FieldPart => part !== null);
  if (format !== null && parts.length > 0) {
    field.parts = parts;
    field.format = format;
  }

  // A formula field's value is derived, never user-entered; a hand-edited
  // formula on a field that already has another value source (AI prompt or
  // adapt, lookup, composite parts) is dropped so the isFieldMeta invariant
  // holds downstream.
  const formula = el.getAttribute("formula");
  if (
    formula !== null &&
    field.aiPrompt === undefined &&
    field.aiAdapt === undefined &&
    field.lookup === undefined &&
    field.parts === undefined
  ) {
    field.formula = formula;
  }

  const conditionAst = parseConditionAst({
    version: el.getAttribute("conditionAstVersion"),
    value: el.getAttribute("conditionAst"),
  });
  if (
    conditionAst !== undefined &&
    field.formula === undefined &&
    field.aiPrompt === undefined &&
    field.aiAdapt === undefined &&
    field.lookup === undefined &&
    field.parts === undefined
  ) {
    field.conditionAst = conditionAst;
  }

  // A condition field is a boolean derived by rule; like a formula it cannot
  // coexist with another value source. A hand-edited condition on a field that
  // already has one is dropped so the isFieldMeta invariant holds downstream.
  const condition = el.getAttribute("condition");
  if (
    condition !== null &&
    field.conditionAst === undefined &&
    field.formula === undefined &&
    field.aiPrompt === undefined &&
    field.aiAdapt === undefined &&
    field.lookup === undefined &&
    field.parts === undefined
  ) {
    field.condition = condition;
  }

  // A data binding is a derived value; a hand-edited source on a field that
  // already carries another value source is dropped so the isFieldMeta
  // invariant holds downstream.
  const sourceEl = getFirstElementChild(el, "source");
  if (
    sourceEl &&
    field.formula === undefined &&
    field.condition === undefined &&
    field.conditionAst === undefined &&
    field.aiPrompt === undefined &&
    field.aiAdapt === undefined &&
    field.lookup === undefined &&
    field.parts === undefined
  ) {
    const source = parseFieldSource(sourceEl);
    if (source !== null) {
      field.source = source;
    }
  }

  return field;
};

const parseManifestXml = (xml: string): TemplateManifest | null => {
  let doc: slimdom.Document;
  try {
    doc = slimdom.parseXmlDocument(xml);
  } catch {
    return null;
  }

  const root = doc.documentElement;
  // Require the root element to actually be `template` *in* our namespace.
  // Checking namespaceURI (not a declared-but-unused `xmlns:st` attribute)
  // ensures a foreign `<template xmlns:st="...">` whose element is not in the
  // namespace is never mistaken for a manifest.
  if (
    !root ||
    root.localName !== "template" ||
    root.namespaceURI !== MANIFEST_NS
  ) {
    return null;
  }

  const versionAttr = root.getAttribute("version");
  const parsed = versionAttr
    ? Number.parseInt(versionAttr, 10)
    : CURRENT_VERSION;
  const version = Number.isFinite(parsed) ? parsed : CURRENT_VERSION;

  const fields: FieldMeta[] = [];

  const fieldsEl = getFirstElementChild(root, "fields");
  if (fieldsEl) {
    const fieldEls = getElementChildren(fieldsEl, "field");
    for (const f of fieldEls) {
      fields.push(parseFieldMeta(f));
    }
  }

  // Migrate a pre-field-model `<st:conditions>` section (named conditions were
  // standalone before they became boolean condition-fields). Each legacy entry
  // becomes a synthetic boolean field { path: name, condition: expression },
  // skipped when a real field already owns that path, so the new field-based
  // model round-trips old manifests: manifestNamedConditions resurfaces them
  // and buildFieldXml re-persists them on the next save.
  const conditionsEl = getFirstElementChild(root, "conditions");
  if (conditionsEl) {
    const existingPaths = new Set(fields.map((f) => f.path));
    for (const c of getElementChildren(conditionsEl, "condition")) {
      const name = c.getAttribute("name");
      if (name === null || existingPaths.has(name)) {
        continue;
      }
      const field: FieldMeta = {
        path: name,
        inputType: "boolean",
        condition: c.getAttribute("expression") ?? "",
      };
      const label = c.getAttribute("label");
      if (label !== null) {
        field.label = label;
      }
      fields.push(field);
      existingPaths.add(name);
    }
  }

  return { version, fields };
};

// ── Public API ───────────────────────────────────────────

type CustomXmlSlot = { index: string; safeIndex: number | null };

/** The Stella manifest part: its slot index plus the parsed manifest. */
type ManifestSlot = CustomXmlSlot & { manifest: TemplateManifest };

const compareCustomXmlSlots = (
  left: CustomXmlSlot,
  right: CustomXmlSlot,
): number => {
  if (left.safeIndex !== null && right.safeIndex !== null) {
    return left.safeIndex - right.safeIndex;
  }

  if (left.safeIndex !== null) {
    return -1;
  }

  if (right.safeIndex !== null) {
    return 1;
  }

  if (left.index.length !== right.index.length) {
    return left.index.length - right.index.length;
  }

  // index is a DOCX custom-XML part slot index, not display text.
  return compareCodepoint(left.index, right.index);
};

/**
 * Locate the Stella manifest among the DOCX's custom XML parts.
 *
 * A part is "ours" only when it parses to a valid manifest whose root is
 * `<template>` in `MANIFEST_NS` (a URN we own) — not a loose substring match,
 * so a foreign part that merely mentions the URI is never selected. When more
 * than one qualifies (should not happen for documents we write), the lowest
 * slot index wins, so the choice is deterministic regardless of zip order.
 */
const findManifestSlot = async (zip: JSZip): Promise<ManifestSlot | null> => {
  const candidates = Object.entries(zip.files).flatMap(([path, entry]) => {
    const index = CUSTOM_XML_DATA_RE.exec(path)?.groups?.["index"];
    if (index === undefined) {
      return [];
    }

    return [{ index, safeIndex: parseCustomXmlSlotIndex(index), entry }];
  });

  const slots = await Promise.all(
    candidates.map(async (c) => ({
      index: c.index,
      safeIndex: c.safeIndex,
      manifest: parseManifestXml(await c.entry.async("string")),
    })),
  );

  return (
    slots
      .filter((slot): slot is ManifestSlot => slot.manifest !== null)
      .toSorted(compareCustomXmlSlots)
      .at(0) ?? null
  );
};

/**
 * Pick the next free safe custom XML slot among existing `item{N}` /
 * `itemProps{N}` indexes. Ignore non-safe numeric indexes from untrusted ZIP
 * entry names so they cannot coerce path generation to `Infinity` or
 * exponential notation, which would make the manifest unfindable later.
 */
const nextFreeSlot = (zip: JSZip): number => {
  const usedSlots = new Set<number>();
  let max = 0;
  for (const path of Object.keys(zip.files)) {
    const index = CUSTOM_XML_INDEX_RE.exec(path)?.groups?.["index"];
    if (index === undefined) {
      continue;
    }

    const slot = parseCustomXmlSlotIndex(index);
    if (slot === null) {
      continue;
    }

    usedSlots.add(slot);
    max = Math.max(max, slot);
  }

  const next = max + 1;
  if (Number.isSafeInteger(next)) {
    return next;
  }

  for (let slot = 1; slot <= usedSlots.size + 1; slot += 1) {
    if (!usedSlots.has(slot)) {
      return slot;
    }
  }

  return 1;
};

const removeManifestSlot = async (
  zip: JSZip,
  slot: CustomXmlSlot,
): Promise<void> => {
  const propsPath = customXmlPropsPathForIndex(slot.index);

  zip.remove(customXmlItemPathForIndex(slot.index));
  zip.remove(propsPath);
  zip.remove(customXmlRelsPathForIndex(slot.index));

  // Clean up empty customXml directory entries
  const customXmlDir = "customXml/";
  const remaining = zip.file(new RegExp(`^${customXmlDir}`, "u"));
  if (remaining.length === 0) {
    zip.remove("customXml/_rels/");
    zip.remove(customXmlDir);
  }

  const ctEntry = zip.file(CONTENT_TYPES_PATH);
  if (!ctEntry) {
    return;
  }

  const ctXml = await ctEntry.async("string");
  zip.file(
    CONTENT_TYPES_PATH,
    ctXml.replace(
      new RegExp(
        `<Override[^>]*PartName=["']/${escapeRegExp(propsPath)}["'][^>]*/>`,
        "u",
      ),
      "",
    ),
  );
};

/**
 * Read the Stella template manifest from an already-opened
 * JSZip instance. Use this when the caller already has the
 * ZIP open to avoid redundant decompression.
 */
export const readManifestFromZip = async (
  zip: JSZip,
): Promise<TemplateManifest | null> => {
  const found = await findManifestSlot(zip);
  return found?.manifest ?? null;
};

/**
 * Read the Stella template manifest from a DOCX buffer.
 * Returns `null` if the DOCX has no manifest.
 */
export const readManifest = async (
  docxBuffer: Buffer,
): Promise<TemplateManifest | null> => {
  const zip = await JSZip.loadAsync(docxBuffer);
  return readManifestFromZip(zip);
};

/**
 * Write a manifest into a DOCX buffer, creating or
 * replacing the Custom XML Part.
 */
export const writeManifest = async (
  docxBuffer: Buffer,
  manifest: TemplateManifest,
): Promise<Buffer> => {
  const zip = await JSZip.loadAsync(docxBuffer);

  // Reuse our own slot when re-saving a template that already carries a
  // manifest; otherwise claim a fresh slot so a foreign custom XML part
  // (Word bibliography, content-control bindings, SharePoint metadata) is
  // never overwritten.
  const existing = await findManifestSlot(zip);
  if (existing?.safeIndex === null) {
    await removeManifestSlot(zip, existing);
  }

  const slot = existing?.safeIndex ?? nextFreeSlot(zip);

  const propsPath = customXmlPropsPath(slot);

  zip.file(customXmlItemPath(slot), buildManifestXml(manifest));
  zip.file(propsPath, buildItemPropsXml());
  zip.file(customXmlRelsPath(slot), buildItemRelsXml(slot));

  // Add the per-part Override for our props part. Checking the specific
  // PartName (not a generic "customXmlProperties" substring) is required:
  // a foreign custom XML part already contributes its own props override.
  const ctEntry = zip.file(CONTENT_TYPES_PATH);
  if (ctEntry) {
    const ctXml = await ctEntry.async("string");
    // Tolerate quote style and attribute spacing/ordering so we never append a
    // duplicate Override (which would violate the OPC spec and corrupt the
    // package).
    const hasOverride = new RegExp(
      `<Override[^>]*PartName=["']/${escapeRegExp(propsPath)}["']`,
      "u",
    ).test(ctXml);
    if (!hasOverride) {
      zip.file(
        CONTENT_TYPES_PATH,
        ctXml.replace(
          "</Types>",
          () =>
            `<Override PartName="/${propsPath}"` +
            ` ContentType="${CUSTOM_XML_CONTENT_TYPE}"/>` +
            "</Types>",
        ),
      );
    }
  }

  const output = await zip.generateAsync({
    type: "nodebuffer",
  });
  return Buffer.from(output);
};

/**
 * Remove the Stella template manifest from a DOCX buffer.
 * Safe to call on buffers that don't have a manifest.
 */
export const stripManifest = async (docxBuffer: Buffer): Promise<Buffer> => {
  const zip = await JSZip.loadAsync(docxBuffer);

  const found = await findManifestSlot(zip);
  if (!found) {
    return docxBuffer;
  }

  // Remove only our slot's part files; foreign custom XML parts stay intact.
  await removeManifestSlot(zip, found);

  const output = await zip.generateAsync({
    type: "nodebuffer",
  });
  return Buffer.from(output);
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
  // Markers a lookup field's named formats own (`company.full`, …). These are
  // rendered outputs of the one resolved hit, not separate fillable inputs, so
  // discovery may surface them as dotted fields; the final filter drops them.
  const lookupFormatMarkers = new Set<string>();
  if (manifest) {
    for (const f of manifest.fields) {
      metaByPath.set(f.path, f);
      const formats = f.lookup?.formats;
      for (const format of arrayOrEmpty(formats)) {
        lookupFormatMarkers.add(`${f.path}.${format.key}`);
      }
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
      // {{#each lawyers}}) merges into the array's itemFields above; adding
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
        parts: f.parts,
        format: f.format,
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

  // Drop namespace parents: a path that is only a dotted prefix of others
  // (e.g. "tenant" when "tenant.name"/"tenant.krs" exist) is structural, not a
  // fillable field. Discovery registers such roots to infer object/array kinds.
  //
  // A lookup field is exempt: it is a real leaf input even when dotted format
  // markers ({{company.full}}) sit "under" it. Those markers are named
  // renderings of the one resolved hit, not separate fields, so the lookup
  // root must survive the prefix filter.
  const paths = resolved.map((f) => f.path);
  return resolved.filter((f) => {
    if (lookupFormatMarkers.has(f.path)) {
      return false;
    }
    if (f.lookup !== undefined) {
      return true;
    }
    // Arrays are value-bearing loop inputs, not structural namespace roots.
    // A nested array path must not make its parent loop disappear.
    if (f.kind === "array") {
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
    if (meta.parts !== undefined && meta.format !== undefined) {
      resolved.parts = meta.parts;
      resolved.format = meta.format;
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
