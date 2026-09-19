/**
 * A document converted into a house style, end to end.
 *
 * Reads the style set's package and the document's, builds the catalogue,
 * decides a style per paragraph, and writes the result into the style set's
 * own package. The caller supplies bytes and gets bytes plus the mapping it
 * can show a person: what each paragraph was, what it became, which tier
 * decided it, and what the run cost.
 *
 * The output package is scrubbed of what belonged to the style-set document
 * rather than to the style: its comments, its notes, the text of its headers
 * and footers, and the authorship in its document properties.
 */

import { Result, TaggedError } from "better-result";

import { repackZip } from "@stll/docx-utils";

import type { OrgAIConfig } from "@/api/lib/ai-config";
import { loadDocxArchive } from "@/api/lib/docx-archive";
import type { DocxArchive } from "@/api/lib/docx-archive";
import { MAIN_DOCUMENT_PART_PATH } from "@/api/lib/docx/ooxml";
import { assignHouseStyles, planRuleTier } from "@/api/lib/house-style/assign";
import type { AssignmentTier } from "@/api/lib/house-style/assign";
import {
  extractStyleCatalogue,
  readStyleDefinitions,
  renameStyleReferences,
} from "@/api/lib/house-style/catalogue";
import type {
  RenameRule,
  StyleCatalogue,
} from "@/api/lib/house-style/catalogue";
import type { StyleGuide } from "@/api/lib/house-style/guide";
import {
  extractParagraphFeatures,
  readBodyParagraphs,
} from "@/api/lib/house-style/paragraphs";
import {
  buildConvertedBody,
  collectDefinedStyleIds,
  collectReferencedStyleIds,
  emptyRootChildren,
  emptyXmlElements,
  stripNotes,
  stripPartText,
} from "@/api/lib/house-style/rewrite";
import type { DecisionModel } from "@/api/lib/workflow/decisions/decision-model";
import { SYSTEM_ONE_USD_PER_INPUT_TOKEN } from "@/api/lib/workflow/decisions/system-one";

export class HouseStyleError extends TaggedError("HouseStyleError")<{
  message: string;
  cause?: unknown;
}> {}

const STYLES_PART_PATH = "word/styles.xml";
const NUMBERING_PART_PATH = "word/numbering.xml";
const CORE_PROPERTIES_PART_PATH = "docProps/core.xml";
const APP_PROPERTIES_PART_PATH = "docProps/app.xml";
const HEADER_FOOTER_PART = /^word\/(?:header|footer)\d*\.xml$/u;
const COMMENT_PARTS = new Set([
  "word/comments.xml",
  "word/commentsExtended.xml",
  "word/commentsIds.xml",
  "word/commentsExtensible.xml",
]);

/** Authorship the style-set file carries and a converted copy must not. */
const AUTHORSHIP_ELEMENTS = [
  "dc:creator",
  "cp:lastModifiedBy",
  "Company",
  "Manager",
] as const;

type DocumentParts = {
  documentXml: string;
  stylesXml: string;
  numberingXml: string | null;
};

/**
 * A style set is an uploaded file: its parts are parsed at this boundary and
 * a malformed one is an error the caller reports, never a throw out of a
 * conversion.
 */
const notWellFormed = (cause: unknown): HouseStyleError =>
  new HouseStyleError({
    message: "The DOCX carries a part that is not well-formed XML",
    cause,
  });

const openArchive = async (
  bytes: ArrayBuffer | Uint8Array | Buffer,
): Promise<Result<DocxArchive, HouseStyleError>> =>
  await Result.tryPromise({
    try: async () => await loadDocxArchive(bytes),
    catch: (cause) =>
      new HouseStyleError({
        message: "The file is not a readable DOCX",
        cause,
      }),
  });

const readParts = async (
  archive: DocxArchive,
): Promise<Result<DocumentParts, HouseStyleError>> => {
  const documentXml = await archive.readEntryString(MAIN_DOCUMENT_PART_PATH);
  const stylesXml = await archive.readEntryString(STYLES_PART_PATH);
  if (documentXml === null || stylesXml === null) {
    return Result.err(
      new HouseStyleError({
        message: "The DOCX carries no document or style part",
      }),
    );
  }
  return Result.ok({
    documentXml,
    stylesXml,
    numberingXml: await archive.readEntryString(NUMBERING_PART_PATH),
  });
};

export type ReadStyleCatalogueOptions = {
  bytes: ArrayBuffer | Uint8Array | Buffer;
  rename?: readonly RenameRule[] | undefined;
};

/** The catalogue a style guide is written against. */
export const readStyleCatalogue = async ({
  bytes,
  rename = [],
}: ReadStyleCatalogueOptions): Promise<
  Result<StyleCatalogue, HouseStyleError>
> => {
  const archive = await openArchive(bytes);
  if (Result.isError(archive)) {
    return archive;
  }
  const parts = await readParts(archive.value);
  if (Result.isError(parts)) {
    return parts;
  }
  return Result.try({
    try: () => extractStyleCatalogue({ ...parts.value, rename }),
    catch: notWellFormed,
  });
};

/** One converted paragraph, as a report and the endpoint's response carry it. */
export type ConversionRow = {
  index: number;
  snippet: string;
  originalStyleId: string;
  originalStyleName: string;
  styleId: string;
  probability: number | null;
  tier: AssignmentTier;
};

export type StyleCount = { styleId: string; name: string; count: number };

export type ConversionSummary = {
  paragraphs: number;
  byTier: Record<AssignmentTier, number>;
  byStyle: StyleCount[];
  droppedEmptyParagraphs: number;
  strippedManualMarkers: number;
  requests: number;
  inputTokens: number;
  usd: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  model: string | null;
};

export type ConversionResult = {
  bytes: ArrayBuffer;
  catalogue: StyleCatalogue;
  rows: ConversionRow[];
  summary: ConversionSummary;
};

/**
 * Nearest-rank percentile: the smallest measured value at or above `share`
 * of the sample, so every reported latency is one a call actually took.
 */
export const percentileOf = (
  values: readonly number[],
  share: number,
): number | null => {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.min(
    sorted.length,
    Math.max(1, Math.ceil(share * sorted.length)),
  );
  return sorted.at(rank - 1) ?? null;
};

const SNIPPET_MAX_CHARS = 120;

const snippetOf = (text: string): string => {
  const points = Array.from(text);
  return points.length <= SNIPPET_MAX_CHARS
    ? text
    : `${points.slice(0, SNIPPET_MAX_CHARS - 1).join("")}…`;
};

export type SummariseConversionOptions = {
  rows: readonly ConversionRow[];
  catalogue: StyleCatalogue;
  usage: {
    requests: number;
    inputTokens: number;
    latenciesMs: number[];
    model: string | null;
  };
  droppedEmptyParagraphs: number;
  strippedManualMarkers: number;
};

export const summariseConversion = ({
  rows,
  catalogue,
  usage,
  droppedEmptyParagraphs,
  strippedManualMarkers,
}: SummariseConversionOptions): ConversionSummary => {
  const byTier: Record<AssignmentTier, number> = {
    "decision-model": 0,
    rule: 0,
  };
  const counts = new Map<string, number>();
  for (const row of rows) {
    byTier[row.tier] += 1;
    counts.set(row.styleId, (counts.get(row.styleId) ?? 0) + 1);
  }
  const names = new Map(catalogue.styles.map(({ id, name }) => [id, name]));
  return {
    paragraphs: rows.length,
    byTier,
    byStyle: [...counts.entries()]
      .map(([styleId, count]) => ({
        styleId,
        name: names.get(styleId) ?? styleId,
        count,
      }))
      .sort((left, right) => right.count - left.count),
    droppedEmptyParagraphs,
    strippedManualMarkers,
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    usd: usage.inputTokens * SYSTEM_ONE_USD_PER_INPUT_TOKEN,
    latencyP50Ms: percentileOf(usage.latenciesMs, 0.5),
    latencyP95Ms: percentileOf(usage.latenciesMs, 0.95),
    model: usage.model,
  };
};

export type ConvertToHouseStyleOptions = {
  /** The style set's DOCX: the container the result is written into. */
  styleSetBytes: ArrayBuffer | Uint8Array | Buffer;
  sourceBytes: ArrayBuffer | Uint8Array | Buffer;
  guide: StyleGuide;
  orgAIConfig: OrgAIConfig | null;
  rename?: readonly RenameRule[] | undefined;
  limit?: number | null | undefined;
  batchSize?: number | undefined;
  concurrency?: number | undefined;
  abortSignal?: AbortSignal | undefined;
  /** A test seam and the script's pinned model; the org's otherwise. */
  client?: DecisionModel | null | undefined;
};

export const convertToHouseStyle = async ({
  styleSetBytes,
  sourceBytes,
  guide,
  orgAIConfig,
  rename = [],
  limit = null,
  batchSize,
  concurrency,
  abortSignal,
  client,
}: ConvertToHouseStyleOptions): Promise<
  Result<ConversionResult, HouseStyleError>
> => {
  const houseArchive = await openArchive(styleSetBytes);
  if (Result.isError(houseArchive)) {
    return houseArchive;
  }
  const sourceArchive = await openArchive(sourceBytes);
  if (Result.isError(sourceArchive)) {
    return sourceArchive;
  }
  const houseParts = await readParts(houseArchive.value);
  if (Result.isError(houseParts)) {
    return houseParts;
  }
  const sourceParts = await readParts(sourceArchive.value);
  if (Result.isError(sourceParts)) {
    return sourceParts;
  }

  const read = Result.try({
    try: () => ({
      catalogue: extractStyleCatalogue({ ...houseParts.value, rename }),
      features: extractParagraphFeatures({
        paragraphs: readBodyParagraphs(sourceParts.value.documentXml),
        definitions: readStyleDefinitions({
          stylesXml: sourceParts.value.stylesXml,
          numberingXml: sourceParts.value.numberingXml,
        }),
      }),
    }),
    catch: notWellFormed,
  });
  if (Result.isError(read)) {
    return read;
  }
  const { catalogue, features } = read.value;
  const plan = planRuleTier(catalogue, guide);
  if (plan === null) {
    return Result.err(
      new HouseStyleError({
        message: "The style set's document uses no paragraph style",
      }),
    );
  }

  const { assignments, usage } = await assignHouseStyles({
    features,
    guide,
    catalogue,
    orgAIConfig,
    limit,
    ...(batchSize === undefined ? {} : { batchSize }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(abortSignal ? { abortSignal } : {}),
    ...(client === undefined ? {} : { client }),
  });

  const styleByIndex = new Map(
    assignments.map(({ index, styleId }) => [index, styleId]),
  );
  const renamedStyles = renameStyleReferences(
    houseParts.value.stylesXml,
    rename,
  );
  const written = Result.try({
    try: () =>
      buildConvertedBody({
        houseDocumentXml: renameStyleReferences(
          houseParts.value.documentXml,
          rename,
        ),
        sourceDocumentXml: sourceParts.value.documentXml,
        styleByIndex,
        fallbackStyleId: plan.bodyStyleId,
        numberedStyleIds: new Set(
          catalogue.styles
            .filter(
              ({ formatting }) =>
                formatting.numbering !== null &&
                formatting.numbering.format !== "none",
            )
            .map(({ id }) => id),
        ),
        knownStyleIds: collectDefinedStyleIds(renamedStyles),
      }),
    catch: notWellFormed,
  });
  if (Result.isError(written)) {
    return written;
  }
  const converted = written.value;

  const zip = houseArchive.value.zip;
  zip.file(MAIN_DOCUMENT_PART_PATH, converted.xml);
  zip.file(STYLES_PART_PATH, renamedStyles);
  if (houseParts.value.numberingXml !== null) {
    zip.file(
      NUMBERING_PART_PATH,
      renameStyleReferences(houseParts.value.numberingXml, rename),
    );
  }
  const scrubbed = await scrubPackageContent(houseArchive.value);
  if (Result.isError(scrubbed)) {
    return scrubbed;
  }

  const bytes = await Result.tryPromise({
    try: async () => await repackZip(zip),
    catch: (cause) =>
      new HouseStyleError({
        message: "The converted package could not be written",
        cause,
      }),
  });
  if (Result.isError(bytes)) {
    return bytes;
  }

  const byIndex = new Map(features.map((feature) => [feature.index, feature]));
  const rows = assignments.map(
    ({ index, styleId, probability, tier }): ConversionRow => {
      const feature = byIndex.get(index);
      return {
        index,
        snippet: snippetOf(feature?.text ?? ""),
        originalStyleId: feature?.originalStyleId ?? "",
        originalStyleName: feature?.originalStyleName ?? "",
        styleId,
        probability,
        tier,
      };
    },
  );

  return Result.ok({
    bytes: bytes.value,
    catalogue,
    rows,
    summary: summariseConversion({
      rows,
      catalogue,
      usage,
      droppedEmptyParagraphs: converted.droppedEmptyParagraphs,
      strippedManualMarkers: converted.strippedManualMarkers,
    }),
  });
};

const scrubPackageContent = async (
  archive: DocxArchive,
): Promise<Result<void, HouseStyleError>> => {
  const rewrite = async (
    path: string,
    transform: (xml: string) => string,
  ): Promise<void> => {
    const xml = await archive.readEntryString(path);
    if (xml !== null) {
      archive.zip.file(path, transform(xml));
    }
  };
  const scrub = Result.tryPromise({
    try: async () => {
      for (const path of Object.keys(archive.zip.files)) {
        if (HEADER_FOOTER_PART.test(path)) {
          await rewrite(path, stripPartText);
          continue;
        }
        if (COMMENT_PARTS.has(path)) {
          await rewrite(path, emptyRootChildren);
        }
      }
      await rewrite("word/footnotes.xml", (xml) => stripNotes(xml, "footnote"));
      await rewrite("word/endnotes.xml", (xml) => stripNotes(xml, "endnote"));
      for (const path of [
        CORE_PROPERTIES_PART_PATH,
        APP_PROPERTIES_PART_PATH,
      ]) {
        await rewrite(path, (xml) =>
          emptyXmlElements(xml, AUTHORSHIP_ELEMENTS),
        );
      }
    },
    catch: (cause) =>
      new HouseStyleError({
        message: "The converted package could not be scrubbed",
        cause,
      }),
  });
  const done = await scrub;
  return Result.isError(done) ? done : Result.ok(undefined);
};

/** Styles referenced by a converted document that its package does not define. */
export const danglingStyleReferences = ({
  documentXml,
  stylesXml,
}: {
  documentXml: string;
  stylesXml: string;
}): string[] => {
  const defined = collectDefinedStyleIds(stylesXml);
  return [...collectReferencedStyleIds(documentXml)].filter(
    (id) => !defined.has(id),
  );
};
