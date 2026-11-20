/**
 * A decision the insolvency register (isir.justice.cz) publishes, as the
 * decision row keeps the register's coordinates of it.
 *
 * The `cz-isir` adapter writes this object under one metadata key; the step
 * that attaches a register copy to a decision another source already holds
 * reads it back, and so does the job that removes the decisions of a
 * proceeding the register struck off (§ 425 insolvenčního zákona), which
 * matches on the court code and the file mark. Nothing here names a person.
 */
import * as v from "valibot";

/** The metadata key the register's coordinates are stored under. */
export const CZ_ISIR_METADATA_KEY = "czIsir";

/** Which court decided: a high court on appeal, or the insolvency court. */
export const CZ_ISIR_INSTANCE = {
  APPELLATE: "appellate",
  INSOLVENCY_COURT: "insolvency-court",
} as const;

export type CzIsirInstance =
  (typeof CZ_ISIR_INSTANCE)[keyof typeof CZ_ISIR_INSTANCE];

const nullableString = v.nullable(v.string());

export const czIsirDecisionMetadataSchema = v.strictObject({
  /** The register's document id; the row's `sourceDocumentId` too. */
  documentId: v.pipe(v.string(), v.regex(/^\d{1,12}$/u)),
  /** The feed action that published the document. */
  actionId: v.pipe(v.number(), v.integer()),
  eventType: v.pipe(v.number(), v.integer()),
  eventDescription: nullableString,
  /** The register's court code for the file (`MSPHAAB`). */
  courtCode: nullableString,
  /** The insolvency file (`INS 10782/2023`): the proceeding a strike-off names. */
  fileMark: v.string(),
  section: nullableString,
  sectionNumber: v.nullable(v.pipe(v.number(), v.integer())),
  publishedAt: nullableString,
  /** Null on a listing kept while its document could not be read. */
  instance: v.nullable(
    v.picklist([CZ_ISIR_INSTANCE.APPELLATE, CZ_ISIR_INSTANCE.INSOLVENCY_COURT]),
  ),
  /** The insolvency file as the decision's header states it. */
  insolvencyFile: nullableString,
  /** The file position its docket's suffix names (`B-24`). */
  filePosition: nullableString,
});

export type CzIsirDecisionMetadata = v.InferOutput<
  typeof czIsirDecisionMetadataSchema
>;
