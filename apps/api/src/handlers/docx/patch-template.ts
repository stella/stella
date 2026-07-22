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
  readConditionRawValues,
} from "./block-directives";
import { discoverPlaceholders } from "./discover-placeholders";
import { processInlineConditions } from "./inline-conditions";
import { manifestNamedConditions } from "./manifest-conditions";
import {
  assignNumbersInDoc,
  mightContainNumberingMarkers,
  resolveRefsInDoc,
} from "./numbering";
import {
  MAIN_DOCUMENT_PART_PATH,
  templateContentPartPaths,
  W_NS,
} from "./ooxml";
import { patchXmlPart } from "./rich-patch";
import { readManifestFromZip, stripManifest } from "./template-manifest";
import type {
  FillTemplateResult,
  ParagraphSource,
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
  const partNames = templateContentPartPaths(Object.keys(zip.files));

  // Each part is read, patched, and written back independently — `values` is
  // read-only and `patchXmlPart` carries no cross-part counter (unlike the
  // occurrence-indexed patcher), so the parts can be processed concurrently.
  await Promise.all(
    partNames.map(async (partName) => {
      const entry = zip.file(partName);
      if (!entry) {
        return;
      }
      const xml = await entry.async("string");
      const patched = patchXmlPart(xml, values);
      if (patched.changed) {
        zip.file(partName, patched.xml);
      }
    }),
  );

  const result = await zip.generateAsync({
    type: "nodebuffer",
  });

  return Buffer.from(result);
};

/**
 * Pre-process block and inline directives in every authored content part.
 * Returns `null` when no part has directives so callers retain the flatten-only
 * fast path. Discovery and rendering share templateContentPartPaths, making
 * supported document-part coverage a single invariant.
 */
const templatePartSource = (path: string): ParagraphSource => {
  if (path === MAIN_DOCUMENT_PART_PATH) {
    return "body";
  }
  if (path.startsWith("word/header")) {
    return "header";
  }
  return "footer";
};

const templatePartContainer = (
  doc: slimdom.Document,
  source: ParagraphSource,
): slimdom.Element | undefined => {
  if (source === "body") {
    return doc.getElementsByTagNameNS(W_NS, "body").at(0);
  }
  const localName = source === "header" ? "hdr" : "ftr";
  return doc.getElementsByTagNameNS(W_NS, localName).at(0);
};

const preProcessTemplateDirectives = async (
  zip: JSZip,
  templateData: TemplateData,
  namedConditions?: NamedCondition[],
  conditionValues?: Record<string, string>,
): Promise<{
  buffer: Buffer;
  expandedValues: Record<string, RichPatchValue>;
  structureErrors: TemplateStructureError[];
} | null> => {
  const parts = (
    await Promise.all(
      templateContentPartPaths(Object.keys(zip.files)).map(async (path) => {
        const entry = zip.file(path);
        if (!entry) {
          return undefined;
        }
        return { path, xml: await entry.async("string") };
      }),
    )
  ).filter((part): part is { path: string; xml: string } => part !== undefined);
  if (!parts.some(({ xml }) => HAS_BLOCK_DIRECTIVES_RE.test(xml))) {
    return null;
  }

  const expandedValues = flattenTemplateData(templateData);
  const structureErrors: TemplateStructureError[] = [];
  const inlineData =
    conditionValues && Object.keys(conditionValues).length > 0
      ? { ...templateData, ...conditionValues }
      : templateData;
  const paragraphOffsets: Record<ParagraphSource, number> = {
    body: 0,
    footer: 0,
    header: 0,
  };
  const numberingXml =
    (await zip.file("word/numbering.xml")?.async("string")) ?? null;
  const validNumIds = collectValidNumIds(numberingXml);

  for (const { path, xml } of parts) {
    const doc = slimdom.parseXmlDocument(xml);
    const source = templatePartSource(path);
    const container = templatePartContainer(doc, source);
    if (!container) {
      continue;
    }

    const paragraphCount = container.getElementsByTagNameNS(W_NS, "p").length;
    const paragraphOffset = paragraphOffsets[source];
    paragraphOffsets[source] += paragraphCount;
    if (!HAS_BLOCK_DIRECTIVES_RE.test(xml)) {
      continue;
    }

    const { patchValues, errors } = processBlockDirectives(
      container,
      templateData,
      namedConditions,
      conditionValues,
    );
    Object.assign(expandedValues, patchValues);
    const inlineErrors = processInlineConditions(
      container,
      inlineData,
      namedConditions,
    );
    for (const error of [...errors, ...inlineErrors]) {
      structureErrors.push({
        ...error,
        paragraphIndex: error.paragraphIndex + paragraphOffset,
        source,
      });
    }

    if (container.getElementsByTagNameNS(W_NS, "numPr").length > 0) {
      pruneDanglingNumPr(container, validNumIds);
    }
    zip.file(path, slimdom.serializeToWellFormedString(doc));
  }

  const modifiedBuf = await zip.generateAsync({
    type: "nodebuffer",
  });

  return {
    buffer: Buffer.from(modifiedBuf),
    expandedValues,
    structureErrors,
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
    // Raw (pre-format) values stashed by the fill pipeline so a date field that
    // is both display-formatted and referenced by a `{{#if}}` compares against
    // its ISO value, not the localized string (see CONDITION_RAW_VALUES). On a
    // plain map (no overlay) this is undefined and evaluation uses `values` as
    // before.
    const conditionValues = readConditionRawValues(values);
    // Checks for block directives internally; returns null
    // when none are found
    const result = await preProcessTemplateDirectives(
      zip,
      values,
      namedConditions,
      conditionValues,
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

  // Resolve clause cross-references / numbering across the body and every
  // header/footer part — the same shared template-content parts used by value
  // replacement and placeholder discovery — after
  // conditional removal, so clauses dropped by a {{#if}} are not numbered and
  // references to them stay unresolved. Numbering shares one counter space and
  // `@ref` must resolve across parts, so this is two-phase over a parsed DOM
  // (split-run aware): assignNumbersInDoc over each part threading one shared
  // `numbers` map (body first so document order drives the count), then
  // resolveRefsInDoc over each part with the full map. Operating on the DOM
  // (paragraph span text) rather than the raw string lets a `{{@num}}`/`{{@ref}}`
  // that Word split across runs be seen and rewritten, the same way the
  // placeholder pipeline handles split markers.
  const numberingZip = await JSZip.loadAsync(data);
  const numberingParts = templateContentPartPaths(
    Object.keys(numberingZip.files),
  );
  const numberingDocs = new Map<string, slimdom.Document>();
  const numbers = new Map<string, number>();

  for (const partName of numberingParts) {
    const entry = numberingZip.file(partName);
    if (!entry) {
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- sequential: numbering shares one counter across parts and body must be read first to drive document-order counts
    const partXml = await entry.async("string");
    // Split-safe pre-filter: skip DOM parsing only for parts that cannot hold a
    // numbering marker even across runs (a contiguous test would miss a marker
    // Word split between runs — the exact case this pass exists to handle).
    if (!mightContainNumberingMarkers(partXml)) {
      continue;
    }
    numberingDocs.set(partName, slimdom.parseXmlDocument(partXml));
  }

  if (numberingDocs.size > 0) {
    for (const doc of numberingDocs.values()) {
      assignNumbersInDoc(doc, numbers);
    }
    for (const [partName, doc] of numberingDocs) {
      resolveRefsInDoc(doc, numbers);
      numberingZip.file(partName, slimdom.serializeToWellFormedString(doc));
    }
    data = Buffer.from(
      await numberingZip.generateAsync({ type: "nodebuffer" }),
    );
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
