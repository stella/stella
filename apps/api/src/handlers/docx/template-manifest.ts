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

import JSZip from "jszip";
import * as slimdom from "slimdom";

import { isFieldPath } from "@stll/template-conditions";

import { WorkflowValidationError } from "@/api/lib/errors/tagged-errors";

import { isElement } from "./ooxml";
import type {
  DiscoveredField,
  DiscoveredTemplate,
  FieldDateFormat,
  FieldLookup,
  FieldLookupFormat,
  FieldMeta,
  FieldPart,
  FieldValidation,
  InputType,
  LookupRegistry,
  PartInputType,
  ResolvedField,
  TemplateManifest,
} from "./types";
import {
  isFieldDateFormat,
  isLookupFormatKey,
  LOOKUP_FORMAT_TEMPLATE_MAX_LENGTH,
  LOOKUP_FORMATS_MAX,
  LOOKUP_REGISTRIES,
} from "./types";

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

  // A condition field is a boolean derived by rule; like a formula it cannot
  // coexist with another value source. A hand-edited condition on a field that
  // already has one is dropped so the isFieldMeta invariant holds downstream.
  const condition = el.getAttribute("condition");
  if (
    condition !== null &&
    field.formula === undefined &&
    field.aiPrompt === undefined &&
    field.aiAdapt === undefined &&
    field.lookup === undefined &&
    field.parts === undefined
  ) {
    field.condition = condition;
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

  const fieldsEl = getFirstElementChild(root, "fields");
  if (fieldsEl) {
    const fieldEls = getElementChildren(fieldsEl, "field");
    for (const f of fieldEls) {
      fields.push(parseFieldMeta(f));
    }
  }

  return { version, fields };
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
  // Markers a lookup field's named formats own (`company.full`, …). These are
  // rendered outputs of the one resolved hit, not separate fillable inputs, so
  // discovery may surface them as dotted fields; the final filter drops them.
  const lookupFormatMarkers = new Set<string>();
  if (manifest) {
    for (const f of manifest.fields) {
      metaByPath.set(f.path, f);
      for (const format of f.lookup?.formats ?? []) {
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
        parts: f.parts,
        format: f.format,
        optionsFrom: f.optionsFrom,
        lookup: f.lookup,
        formula: f.formula,
        condition: f.condition,
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
    if (meta.formula !== undefined) {
      resolved.formula = meta.formula;
    }
    if (meta.condition !== undefined) {
      resolved.condition = meta.condition;
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
    case "textarea":
      return "string";
    default:
      return "string";
  }
};
