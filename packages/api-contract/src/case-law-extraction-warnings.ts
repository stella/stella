// parser-output-unchanged: defines warning wire metadata and shared detector IDs; does not transform source text or parser AST
import * as v from "valibot";

export const MARKUP_RESIDUE_RULE_IDS = [
  "rtf-control",
  "html-tag",
  "xml-marker",
  "pdf-object",
  "entity",
  "digit-run",
  "hex-run",
] as const;
export const EXTRACTION_WARNING_RULES = [
  ...MARKUP_RESIDUE_RULE_IDS,
  "document-empty",
  "ast-missing",
  "replacement-character",
  "c1-control",
  "utf8-read-as-single-byte",
  "misdecoded",
  "encoding-incomplete",
] as const;
export const EXTRACTION_WARNING_FIRST_OFFSETS_MAX = 3;
export const extractionWarningsSchema = v.pipe(
  v.array(
    v.strictObject({
      rule: v.picklist(EXTRACTION_WARNING_RULES),
      count: v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.description(
          "Occurrences reported by the detector; encoding checks retain their existing work bounds.",
        ),
      ),
      // UTF-16 code-unit offsets in the stored fulltext; no source text is exposed.
      firstOffsets: v.pipe(
        v.array(v.pipe(v.number(), v.integer(), v.minValue(0))),
        v.maxLength(EXTRACTION_WARNING_FIRST_OFFSETS_MAX),
        v.description(
          `Up to ${String(EXTRACTION_WARNING_FIRST_OFFSETS_MAX)} detected locations as zero-based UTF-16 code-unit offsets in stored fulltext; encoding locations identify sample word spans. Served AST text or passage excerpts may differ. Empty for document-wide signals.`,
        ),
      ),
    }),
  ),
  v.maxLength(EXTRACTION_WARNING_RULES.length),
);
export type ExtractionWarning = v.InferOutput<
  typeof extractionWarningsSchema
>[number];
export type ExtractionWarnings = ExtractionWarning[];
