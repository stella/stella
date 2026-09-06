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

import { compareCodeUnit } from "@stll/collation";
import type { ConditionNode } from "@stll/conditions";
import { conditionNodeSchema } from "@stll/conditions";
import { isFieldPath } from "@stll/template-conditions";

import { arrayOrEmpty } from "@/api/lib/array";

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

const parseFieldSourceCandidate = (candidate: unknown): FieldSource | null =>
  isFieldSource(candidate) ? candidate : null;

const parseFieldSource = (el: slimdom.Element): FieldSource | null => {
  const kind = el.getAttribute("kind");
  const field = el.getAttribute("field");

  switch (kind) {
    case "party":
      return parseFieldSourceCandidate({
        kind,
        role: el.getAttribute("role"),
        field,
      });
    case "attorney":
      return parseFieldSourceCandidate({
        kind,
        ref: el.getAttribute("ref"),
        field,
      });
    case "contact":
    case "matter":
    case "firm":
      return parseFieldSourceCandidate({ kind, field });
    case null:
      return null;
    default:
      return null;
  }
};

const applyStandardFieldAttributes = (
  field: FieldMeta,
  el: slimdom.Element,
): void => {
  const label = el.getAttribute("label");
  if (label !== null) {
    field.label = label;
  }
  const hint = el.getAttribute("hint");
  if (hint !== null) {
    field.hint = hint;
  }
  const inputType = el.getAttribute("inputType");
  if (inputType !== null && isInputType(inputType)) {
    field.inputType = inputType;
  }
  const required = el.getAttribute("required");
  if (required !== null) {
    field.required = required === "true";
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
  const optionsFrom = el.getAttribute("optionsFrom");
  if (optionsFrom !== null && isFieldPath(optionsFrom)) {
    field.optionsFrom = optionsFrom;
  }

  const optionsEl = getFirstElementChild(el, "options");
  if (!optionsEl) {
    return;
  }
  const options = getElementChildren(optionsEl, "option")
    .map((option) => option.getAttribute("value"))
    .filter((value): value is string => value !== null);
  if (options.length > 0) {
    field.options = options;
  }
};

const parseFieldValidation = (
  validationEl: slimdom.Element | null,
): FieldValidation | undefined => {
  if (!validationEl) {
    return undefined;
  }
  const validation: FieldValidation = {};
  const required = validationEl.getAttribute("required");
  if (required !== null) {
    validation.required = required === "true";
  }
  const numberAttributes = [
    ["minLength", "minLength"],
    ["maxLength", "maxLength"],
    ["minItems", "minItems"],
    ["maxItems", "maxItems"],
  ] as const;
  for (const [attribute, property] of numberAttributes) {
    const value = validationEl.getAttribute(attribute);
    if (value === null) {
      continue;
    }
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      validation[property] = parsed;
    }
  }
  const pattern = validationEl.getAttribute("pattern");
  if (pattern !== null) {
    validation.pattern = pattern;
  }
  return Object.keys(validation).length > 0 ? validation : undefined;
};

const parseFieldLookup = (
  lookupEl: slimdom.Element | null,
): FieldMeta["lookup"] | undefined => {
  if (!lookupEl) {
    return undefined;
  }
  const registry = lookupEl.getAttribute("registry");
  if (registry === null || !isLookupRegistry(registry)) {
    return undefined;
  }
  const formatsEl = getFirstElementChild(lookupEl, "lookupFormats");
  if (!formatsEl) {
    return undefined;
  }
  const formats: FieldLookupFormat[] = [];
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
  return formats.length > 0
    ? { registry, formats: formats.slice(0, LOOKUP_FORMATS_MAX) }
    : undefined;
};

const hasDerivedValueSource = (field: FieldMeta): boolean =>
  field.formula !== undefined ||
  field.condition !== undefined ||
  field.conditionAst !== undefined ||
  field.aiPrompt !== undefined ||
  field.aiAdapt !== undefined ||
  field.lookup !== undefined ||
  field.parts !== undefined;

const applyDerivedFieldAttributes = (
  field: FieldMeta,
  el: slimdom.Element,
): void => {
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

  const format = el.getAttribute("format");
  const partsEl = getFirstElementChild(el, "parts");
  const parts = partsEl
    ? getElementChildren(partsEl, "part")
        .map(parseFieldPart)
        .filter((part): part is FieldPart => part !== null)
    : [];
  if (format !== null && parts.length > 0) {
    field.parts = parts;
    field.format = format;
  }

  const formula = el.getAttribute("formula");
  if (formula !== null && !hasDerivedValueSource(field)) {
    field.formula = formula;
  }
  const conditionAst = parseConditionAst({
    version: el.getAttribute("conditionAstVersion"),
    value: el.getAttribute("conditionAst"),
  });
  if (conditionAst !== undefined && !hasDerivedValueSource(field)) {
    field.conditionAst = conditionAst;
  }
  const condition = el.getAttribute("condition");
  if (condition !== null && !hasDerivedValueSource(field)) {
    field.condition = condition;
  }
  const sourceEl = getFirstElementChild(el, "source");
  if (!sourceEl || hasDerivedValueSource(field)) {
    return;
  }
  const source = parseFieldSource(sourceEl);
  if (source !== null) {
    field.source = source;
  }
};

const parseFieldMeta = (el: slimdom.Element): FieldMeta => {
  const path = el.getAttribute("path") ?? "";
  const field: FieldMeta = { path };
  applyStandardFieldAttributes(field, el);
  const validation = parseFieldValidation(
    getFirstElementChild(el, "validation"),
  );
  if (validation !== undefined) {
    field.validation = validation;
  }

  // A hand-edited registry outside the supported set is dropped so the
  // isFieldMeta invariant holds downstream.
  const lookup = parseFieldLookup(getFirstElementChild(el, "lookup"));
  if (lookup !== undefined) {
    field.lookup = lookup;
  }
  applyDerivedFieldAttributes(field, el);

  return field;
};

const parseManifestXml = (xml: string): TemplateManifest | null => {
  const document = Result.try(() => slimdom.parseXmlDocument(xml));
  if (Result.isError(document)) {
    return null;
  }
  const doc = document.value;

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
  return compareCodeUnit(left.index, right.index);
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
  parts: field.parts,
  format: field.format,
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
