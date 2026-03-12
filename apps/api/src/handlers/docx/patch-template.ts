/**
 * Template filling: replaces {{placeholder}} tags in a DOCX
 * template using `patchDocument`. Returns diagnostics about
 * unmatched placeholders and unused values.
 *
 * When the template contains block directives ({{#if}},
 * {{#each}}), a pre-processing step manipulates the OOXML
 * DOM before `patchDocument()` runs.
 */

import { patchDocument } from "docx";
import type { IPatch } from "docx";
import JSZip from "jszip";
import * as slimdom from "slimdom";

import {
  flattenTemplateData,
  HAS_BLOCK_DIRECTIVES_RE,
  processBlockDirectives,
} from "./block-directives";
import { discoverPlaceholders } from "./discover-placeholders";
import { W_NS } from "./ooxml";
import { buildPatch } from "./rich-patch";
import { readManifestFromZip, stripManifest } from "./template-manifest";
import type {
  FillTemplateResult,
  NamedCondition,
  RichPatchValue,
  TemplateData,
  TemplateDataValue,
  TemplateStructureError,
} from "./types";

export type PatchValues = Record<string, RichPatchValue>;

/**
 * Check whether a value looks like a plain PatchValues map
 * (all values are string or RichPatchValue) or a richer
 * TemplateData object (contains booleans, numbers, arrays,
 * or nested objects).
 */
const isTemplateData = (
  values: PatchValues | TemplateData,
): values is TemplateData => {
  for (const value of Object.values(values)) {
    if (typeof value === "boolean") {
      return true;
    }
    if (typeof value === "number") {
      return true;
    }
    if (Array.isArray(value)) {
      return true;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      !("paragraphs" in value)
    ) {
      return true;
    }
  }
  return false;
};

/**
 * Fill values into a template buffer using `patchDocument`.
 * This is the value-only path (no block directives).
 */
const fillTemplateWithValues = async (
  data: Buffer,
  values: PatchValues,
): Promise<Buffer> => {
  const patches: Record<string, IPatch> = {};
  for (const [key, value] of Object.entries(values)) {
    patches[key] = buildPatch(value);
  }

  const result = await patchDocument({
    outputType: "uint8array",
    data,
    patches,
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

  // Serialize modified DOM back into the ZIP
  const serialized = slimdom.serializeToWellFormedString(doc);
  zip.file("word/document.xml", serialized);
  const modifiedBuf = await zip.generateAsync({
    type: "nodebuffer",
  });

  return {
    buffer: Buffer.from(modifiedBuf),
    expandedValues: patchValues,
    structureErrors: errors,
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
  const namedConditions =
    manifest && manifest.conditions.length > 0
      ? manifest.conditions
      : undefined;

  let effectiveValues: PatchValues;
  let structureErrors: TemplateStructureError[] = [];

  if (isTemplateData(values)) {
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
    effectiveValues = values;
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
    value !== null &&
    !Array.isArray(value) &&
    "paragraphs" in value
  ) {
    return true;
  }
  return false;
};
