/**
 * Template filling: replaces {{placeholder}} tags in a DOCX
 * template by mutating WordprocessingML directly. Returns
 * diagnostics about unmatched placeholders and unused values.
 *
 * When the template contains block directives ({{#if}},
 * {{#each}}), a pre-processing step manipulates the OOXML
 * DOM before value replacement runs.
 */

import { panic } from "better-result";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import type { NamedCondition } from "@stll/template-conditions";

import {
  collectValidNumIds,
  flattenTemplateData,
  HAS_BLOCK_DIRECTIVES_RE,
  processBlockDirectives,
  pruneDanglingNumPr,
} from "./block-directives";
import { discoverPlaceholders } from "./discover-placeholders";
import { processInlineConditions } from "./inline-conditions";
import { manifestNamedConditions } from "./manifest-conditions";
import { applyNumbering, hasNumberingMarkers } from "./numbering";
import { HEADER_FOOTER_RE, W_NS } from "./ooxml";
import { patchXmlPart } from "./rich-patch";
import { readManifestFromZip, stripManifest } from "./template-manifest";
import type {
  FillTemplateResult,
  RichPatchValue,
  TemplateData,
  TemplateDataValue,
  TemplateStructureError,
} from "./types";
import { isTemplateData } from "./types";

type PatchValues = Record<string, RichPatchValue>;

const isPatchValues = (
  value: PatchValues | TemplateData,
): value is PatchValues => Object.values(value).every(isPatchableValue);

const fillTemplateWithValues = async (
  data: Buffer,
  values: PatchValues,
): Promise<Buffer> => {
  const zip = await JSZip.loadAsync(data);
  const partNames = Object.keys(zip.files).filter(
    (name) => name === "word/document.xml" || HEADER_FOOTER_RE.test(name),
  );

  for (const partName of partNames) {
    const entry = zip.file(partName);
    if (!entry) {
      continue;
    }
    const xml = await entry.async("string");
    const patched = patchXmlPart(xml, values);
    if (patched.changed) {
      zip.file(partName, patched.xml);
    }
  }

  const result = await zip.generateAsync({
    type: "nodebuffer",
  });

  return Buffer.from(result);
};

/**
 * Pre-process block directives in a DOCX ZIP. Checks whether
 * block directives exist; if not, returns `null` (caller should
 * fall back to `flattenTemplateData`). Otherwise evaluates
 * conditionals and loops, serializes the modified XML back
 * into the ZIP, and returns the modified buffer plus expanded
 * patch values.
 */
const preProcessBlockDirectives = async (
  zip: JSZip,
  templateData: TemplateData,
  namedConditions?: NamedCondition[],
): Promise<{
  buffer: Buffer;
  expandedValues: Record<string, RichPatchValue>;
  structureErrors: TemplateStructureError[];
} | null> => {
  const docEntry = zip.file("word/document.xml");
  if (!docEntry) {
    return null;
  }

  const xml = await docEntry.async("string");

  // Fast-path: skip DOM parsing if no block directives
  if (!HAS_BLOCK_DIRECTIVES_RE.test(xml)) {
    return null;
  }

  const doc = slimdom.parseXmlDocument(xml);
  const body = doc.getElementsByTagNameNS(W_NS, "body").at(0);

  if (!body) {
    return null;
  }

  const { patchValues, errors } = processBlockDirectives(
    body,
    templateData,
    namedConditions,
  );

  // Inline conditional spans resolve after the block pass (whole-paragraph
  // directives and loop expansion are settled, so every surviving paragraph
  // is final) and before this DOM serializes — which places them before
  // numbering, placeholder discovery, and {{path}} substitution below. That
  // ordering keeps the downstream passes clean: markers and @num keys inside
  // a cut span are removed before they could be numbered, reported as
  // unmatched, or filled. AI per-occurrence adaptation (adaptAiFields) runs
  // even earlier, at the fill boundary on the raw template buffer: its
  // context extraction and per-occurrence patching must see the same buffer
  // so occurrence indices stay aligned, and a rendering patched into a
  // branch that this pass later cuts is simply removed with the branch.
  const inlineErrors = processInlineConditions(
    body,
    templateData,
    namedConditions,
  );

  // Loop expansion clones list paragraphs verbatim; prune numbering
  // references that do not resolve in word/numbering.xml so the
  // output renders identically in every consumer (Word ignores a
  // dangling numId, other processors may not).
  if (body.getElementsByTagNameNS(W_NS, "numPr").length > 0) {
    const numberingXml =
      (await zip.file("word/numbering.xml")?.async("string")) ?? null;
    pruneDanglingNumPr(body, collectValidNumIds(numberingXml));
  }

  // Serialize modified DOM back into the ZIP
  const serialized = slimdom.serializeToWellFormedString(doc);
  zip.file("word/document.xml", serialized);
  const modifiedBuf = await zip.generateAsync({
    type: "nodebuffer",
  });

  return {
    buffer: Buffer.from(modifiedBuf),
    expandedValues: patchValues,
    structureErrors: [...errors, ...inlineErrors],
  };
};

export const fillTemplate = async (
  template: string | Buffer,
  values: PatchValues | TemplateData,
): Promise<FillTemplateResult> => {
  let data =
    typeof template === "string"
      ? Buffer.from(await Bun.file(template).arrayBuffer())
      : template;

  // Open ZIP once for manifest + block-directive checks
  const zip = await JSZip.loadAsync(data);

  const manifest = await readManifestFromZip(zip);
  // A boolean condition-field IS a named condition (addressed by its path), so
  // synthesize both shapes into one list the evaluator resolves bare names
  // against — `{{#if field_path}}` then resolves the field's rule.
  const synthesized = manifest ? manifestNamedConditions(manifest) : [];
  const namedConditions = synthesized.length > 0 ? synthesized : undefined;

  let effectiveValues: PatchValues;
  let structureErrors: TemplateStructureError[] = [];

  if (isPatchValues(values)) {
    effectiveValues = values;
  } else if (isTemplateData(values)) {
    // Checks for block directives internally; returns null
    // when none are found
    const result = await preProcessBlockDirectives(
      zip,
      values,
      namedConditions,
    );

    if (result) {
      data = result.buffer;
      effectiveValues = result.expandedValues;
      structureErrors = result.structureErrors;
    } else {
      // No block directives; flatten nested objects into
      // dot-separated patch keys
      effectiveValues = flattenTemplateData(values);
    }
  } else {
    panic("fillTemplate received values outside the supported data model");
  }

  // Resolve clause cross-references / numbering on the assembled body — after
  // conditional removal, so clauses dropped by a {{#if}} are not numbered and
  // references to them stay unresolved.
  const numberingZip = await JSZip.loadAsync(data);
  const bodyEntry = numberingZip.file("word/document.xml");
  if (bodyEntry) {
    const bodyXml = await bodyEntry.async("string");
    if (hasNumberingMarkers(bodyXml)) {
      numberingZip.file("word/document.xml", applyNumbering(bodyXml));
      data = Buffer.from(
        await numberingZip.generateAsync({ type: "nodebuffer" }),
      );
    }
  }

  // Discover what the template actually contains
  const discovered = await discoverPlaceholders(data);
  const templateNames = new Set(discovered.map((p) => p.name));
  const providedNames = new Set(Object.keys(effectiveValues));

  const unmatchedPlaceholders = [...templateNames].filter(
    (name) => !providedNames.has(name),
  );

  // For unused-value detection, compare against the original
  // user-supplied keys (not the expanded __each_ keys)
  const originalKeys = new Set(Object.keys(values));
  const unusedValues = [...originalKeys].filter(
    (name) =>
      !templateNames.has(name) &&
      // Don't report array/object/boolean values as unused;
      // they're consumed by block directives
      isPatchableValue(values[name]),
  );

  let buffer = await fillTemplateWithValues(data, effectiveValues);

  // Strip manifest from output (prevent metadata leaking
  // into filled documents)
  if (manifest) {
    buffer = await stripManifest(buffer);
  }

  return {
    buffer,
    unmatchedPlaceholders,
    unusedValues,
    structureErrors,
  };
};

/** Check if a value is a simple patchable value (string or RichPatchValue). */
const isPatchableValue = (value: TemplateDataValue | undefined): boolean => {
  if (value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return true;
  }
  if (
    typeof value === "object" &&
    !Array.isArray(value) &&
    "paragraphs" in value
  ) {
    return true;
  }
  return false;
};
