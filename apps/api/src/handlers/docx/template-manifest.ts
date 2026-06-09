/**
 * Custom XML Manifest for DOCX templates.
 *
 * Stores field metadata (labels, input types, validation) and
 * named conditions inside the DOCX as a Custom XML Part
 * (`customXml/item1.xml`) — standard OOXML mechanism, ignored
 * by Word, self-contained in one file.
 *
 * Filled documents must NOT contain this metadata (information
 * leak risk). The manifest is stripped during `fillTemplate()`.
 */

import JSZip from "jszip";
import * as slimdom from "slimdom";

import { isFieldPath } from "@stll/template-conditions";

import { WorkflowValidationError } from "@/api/lib/errors/tagged-errors";

import { isElement } from "./ooxml";
import type {
  ComputedField,
  DiscoveredField,
  DiscoveredTemplate,
  FieldLookup,
  FieldMeta,
  FieldPart,
  FieldValidation,
  InputType,
  LookupRegistry,
  NamedCondition,
  PartInputType,
  ResolvedField,
  TemplateManifest,
} from "./types";
import { LOOKUP_REGISTRIES } from "./types";

// ── Constants ────────────────────────────────────────────

export const MANIFEST_NS = "urn:stella:template:v1";

const CUSTOM_XML_ITEM_PATH = "customXml/item1.xml";
const CUSTOM_XML_PROPS_PATH = "customXml/itemProps1.xml";
const CUSTOM_XML_RELS_PATH = "customXml/_rels/item1.xml.rels";
const CONTENT_TYPES_PATH = "[Content_Types].xml";

// prettier-ignore
const CUSTOM_XML_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.customXmlProperties+xml";

// prettier-ignore
const CUSTOM_XML_PROPS_REL_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps";

// ── Current manifest version ─────────────────────────────

const CURRENT_VERSION = 1;

// ── Input type validation ────────────────────────────────

const INPUT_TYPES: ReadonlySet<string> = new Set([
  "text",
  "textarea",
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
  const attrs: string[] = [`registry="${escapeXml(lookup.registry)}"`];
  if (lookup.aiFormat !== undefined) {
    attrs.push(`aiFormat="${escapeXml(lookup.aiFormat)}"`);
  }
  return `<st:lookup ${attrs.join(" ")}/>`;
};

const buildFieldXml = (field: FieldMeta): string => {
  const attrs: string[] = [`path="${escapeXml(field.path)}"`];
  if (field.label !== undefined) {
    attrs.push(`label="${escapeXml(field.label)}"`);
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
  if (field.format !== undefined) {
    attrs.push(`format="${escapeXml(field.format)}"`);
  }
  if (field.optionsFrom !== undefined) {
    attrs.push(`optionsFrom="${escapeXml(field.optionsFrom)}"`);
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
    if (vAttrs.length > 0) {
      children.push(`<st:validation ${vAttrs.join(" ")}/>`);
    }
  }

  if (children.length === 0) {
    return `<st:field ${attrs.join(" ")}/>`;
  }
  return `<st:field ${attrs.join(" ")}>${children.join("")}</st:field>`;
};

const buildConditionXml = (condition: NamedCondition): string => {
  const attrs: string[] = [
    `name="${escapeXml(condition.name)}"`,
    `expression="${escapeXml(condition.expression)}"`,
  ];
  if (condition.label !== undefined) {
    attrs.push(`label="${escapeXml(condition.label)}"`);
  }
  return `<st:condition ${attrs.join(" ")}/>`;
};

const buildComputedXml = (computed: ComputedField): string => {
  const attrs: string[] = [
    `name="${escapeXml(computed.name)}"`,
    `expression="${escapeXml(computed.expression)}"`,
  ];
  if (computed.label !== undefined) {
    attrs.push(`label="${escapeXml(computed.label)}"`);
  }
  return `<st:computed ${attrs.join(" ")}/>`;
};

const buildManifestXml = (manifest: TemplateManifest): string => {
  const fields = manifest.fields.map(buildFieldXml).join("");
  const conditions = manifest.conditions.map(buildConditionXml).join("");
  const computed = (manifest.computed ?? []).map(buildComputedXml).join("");

  return [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<st:template xmlns:st="${MANIFEST_NS}"`,
    ` version="${manifest.version}">`,
    fields ? `<st:fields>${fields}</st:fields>` : "",
    conditions ? `<st:conditions>${conditions}</st:conditions>` : "",
    computed ? `<st:computed-fields>${computed}</st:computed-fields>` : "",
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

const buildItemRelsXml = (): string =>
  [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org',
    '/package/2006/relationships">',
    `<Relationship Id="rId1"`,
    ` Type="${CUSTOM_XML_PROPS_REL_TYPE}"`,
    ` Target="itemProps1.xml"/>`,
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
      const lookup: FieldLookup = { registry };
      const aiFormat = lookupEl.getAttribute("aiFormat");
      if (aiFormat !== null) {
        lookup.aiFormat = aiFormat;
      }
      field.lookup = lookup;
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

  return field;
};

const parseCondition = (el: slimdom.Element): NamedCondition => {
  const name = el.getAttribute("name") ?? "";
  const expression = el.getAttribute("expression") ?? "";
  const label = el.getAttribute("label") ?? undefined;

  const condition: NamedCondition = { name, expression };
  if (label !== undefined) {
    condition.label = label;
  }
  return condition;
};

const parseComputed = (el: slimdom.Element): ComputedField => {
  const name = el.getAttribute("name") ?? "";
  const expression = el.getAttribute("expression") ?? "";
  const label = el.getAttribute("label") ?? undefined;

  const computed: ComputedField = { name, expression };
  if (label !== undefined) {
    computed.label = label;
  }
  return computed;
};

const parseManifestXml = (xml: string): TemplateManifest | null => {
  let doc: slimdom.Document;
  try {
    doc = slimdom.parseXmlDocument(xml);
  } catch {
    return null;
  }

  const root = doc.documentElement;
  if (!root || root.localName !== "template") {
    return null;
  }

  // Check namespace (attribute or default)
  const ns = root.namespaceURI ?? root.getAttribute("xmlns:st");
  if (ns !== MANIFEST_NS) {
    return null;
  }

  const versionAttr = root.getAttribute("version");
  const parsed = versionAttr
    ? Number.parseInt(versionAttr, 10)
    : CURRENT_VERSION;
  const version = Number.isFinite(parsed) ? parsed : CURRENT_VERSION;

  const fields: FieldMeta[] = [];
  const conditions: NamedCondition[] = [];
  const computed: ComputedField[] = [];

  const fieldsEl = getFirstElementChild(root, "fields");
  if (fieldsEl) {
    const fieldEls = getElementChildren(fieldsEl, "field");
    for (const f of fieldEls) {
      fields.push(parseFieldMeta(f));
    }
  }

  const conditionsEl = getFirstElementChild(root, "conditions");
  if (conditionsEl) {
    const condEls = getElementChildren(conditionsEl, "condition");
    for (const c of condEls) {
      conditions.push(parseCondition(c));
    }
  }

  const computedEl = getFirstElementChild(root, "computed-fields");
  if (computedEl) {
    const computedEls = getElementChildren(computedEl, "computed");
    for (const c of computedEls) {
      computed.push(parseComputed(c));
    }
  }

  return { version, fields, conditions, computed };
};

// ── Public API ───────────────────────────────────────────

/**
 * Read the Stella template manifest from an already-opened
 * JSZip instance. Use this when the caller already has the
 * ZIP open to avoid redundant decompression.
 */
export const readManifestFromZip = async (
  zip: JSZip,
): Promise<TemplateManifest | null> => {
  const entry = zip.file(CUSTOM_XML_ITEM_PATH);
  if (!entry) {
    return null;
  }

  const xml = await entry.async("string");
  return parseManifestXml(xml);
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

  // Guard: refuse to overwrite non-Stella custom XML
  const existing = zip.file(CUSTOM_XML_ITEM_PATH);
  if (existing) {
    const xml = await existing.async("string");
    if (!xml.includes(MANIFEST_NS)) {
      throw new WorkflowValidationError({
        message:
          "Cannot write manifest: " +
          `${CUSTOM_XML_ITEM_PATH} contains ` +
          "non-stella custom XML",
      });
    }
  }

  // Write the manifest XML
  zip.file(CUSTOM_XML_ITEM_PATH, buildManifestXml(manifest));

  // Write item properties
  zip.file(CUSTOM_XML_PROPS_PATH, buildItemPropsXml());

  // Write relationships for the custom XML part
  zip.file(CUSTOM_XML_RELS_PATH, buildItemRelsXml());

  // Ensure [Content_Types].xml includes the custom XML part
  const ctEntry = zip.file(CONTENT_TYPES_PATH);
  if (ctEntry) {
    let ctXml = await ctEntry.async("string");
    if (!ctXml.includes("customXmlProperties")) {
      ctXml = ctXml.replace(
        "</Types>",
        `<Override PartName="/${CUSTOM_XML_PROPS_PATH}"` +
          ` ContentType="${CUSTOM_XML_CONTENT_TYPE}"/>` +
          "</Types>",
      );
      zip.file(CONTENT_TYPES_PATH, ctXml);
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

  const hasManifest = zip.file(CUSTOM_XML_ITEM_PATH);
  if (!hasManifest) {
    return docxBuffer;
  }

  // Check that this is actually a Stella manifest
  const xml = await hasManifest.async("string");
  if (!xml.includes(MANIFEST_NS)) {
    return docxBuffer;
  }

  // Remove the custom XML part files
  zip.remove(CUSTOM_XML_ITEM_PATH);
  zip.remove(CUSTOM_XML_PROPS_PATH);
  zip.remove(CUSTOM_XML_RELS_PATH);

  // Clean up empty customXml directory entries
  const customXmlDir = "customXml/";
  const remaining = zip.file(new RegExp(`^${customXmlDir}`, "u"));
  if (remaining.length === 0) {
    zip.remove("customXml/_rels/");
    zip.remove(customXmlDir);
  }

  // Remove from [Content_Types].xml
  const ctEntry = zip.file(CONTENT_TYPES_PATH);
  if (ctEntry) {
    let ctXml = await ctEntry.async("string");
    // Remove the Override for itemProps1.xml
    ctXml = ctXml.replace(
      new RegExp(
        `<Override[^>]*PartName="/${CUSTOM_XML_PROPS_PATH}"[^>]*/>`,
        "u",
      ),
      "",
    );
    zip.file(CONTENT_TYPES_PATH, ctXml);
  }

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
  if (manifest) {
    for (const f of manifest.fields) {
      metaByPath.set(f.path, f);
    }
  }

  // Computed fields ({{rent_annual}} = rent * 12) are resolved at fill time,
  // never user-entered, so they must not surface as input fields.
  const computedNames = new Set((manifest?.computed ?? []).map((c) => c.name));

  // Start with discovered fields, enriching with manifest
  const resolved: ResolvedField[] = [];
  const seen = new Set<string>();

  for (const df of discovered.fields) {
    if (computedNames.has(df.path)) {
      continue;
    }
    seen.add(df.path);
    const meta = metaByPath.get(df.path);
    resolved.push(mergeField(df, meta));
  }

  // Add manifest-only fields (not discovered)
  if (manifest) {
    for (const f of manifest.fields) {
      if (seen.has(f.path) || computedNames.has(f.path)) {
        continue;
      }
      resolved.push({
        path: f.path,
        kind: inputTypeToFieldKind(f.inputType),
        count: 0,
        label: f.label,
        inputType: f.inputType,
        options: f.options,
        validation: f.validation,
        required: f.required,
        aiAdapt: f.aiAdapt,
        parts: f.parts,
        format: f.format,
        optionsFrom: f.optionsFrom,
        lookup: f.lookup,
      });
    }
  }

  // Drop namespace parents: a path that is only a dotted prefix of others
  // (e.g. "tenant" when "tenant.name"/"tenant.krs" exist) is structural, not a
  // fillable field. Discovery registers such roots to infer object/array kinds.
  const paths = resolved.map((f) => f.path);
  return resolved.filter(
    (f) => !paths.some((p) => p !== f.path && p.startsWith(`${f.path}.`)),
  );
};

// ── Helpers ──────────────────────────────────────────────

const mergeField = (
  discovered: DiscoveredField,
  meta?: FieldMeta,
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
  }

  // Preserve visibleWhen from discovery
  if (discovered.visibleWhen !== undefined) {
    resolved.visibleWhen = discovered.visibleWhen;
  }

  if (discovered.itemFields) {
    // Item-level metadata not yet supported
    resolved.itemFields = discovered.itemFields.map((item) => mergeField(item));
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
    case "textarea":
      return "string";
    default:
      return "string";
  }
};
