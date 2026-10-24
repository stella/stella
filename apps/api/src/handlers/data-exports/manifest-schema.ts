// The data export format contract. This Valibot schema is the source of
// truth; `docs/data-export/stella-data-export.v1.schema.json` is generated
// from it (`bun apps/api/scripts/generate-data-export-schema.ts`) and a test
// fails when the two drift. An importer reads the JSON Schema; stella's own
// tests parse every manifest it builds through this schema.

import * as v from "valibot";

import { DATA_EXPORT_VERSION_SCOPE_VALUES } from "@/api/lib/data-export/version-scope";

export const DATA_EXPORT_FORMAT = "stella-data-export";
export const DATA_EXPORT_FORMAT_VERSION = 1;
export const DATA_EXPORT_SCHEMA_ID =
  "https://stll.app/schemas/stella-data-export.v1.schema.json";

export type DataExportVersionScope =
  (typeof DATA_EXPORT_VERSION_SCOPE_VALUES)[number];

/** Entity kinds the manifest lists as documents: both carry files. Matter
 *  tasks are exported as records; `link` entities are not exported. */
const EXPORTED_DOCUMENT_KINDS = ["document", "message"] as const;

/** Why a stored file could not be put in the archive. */
const ABSENT_FILE_REASONS = ["missing", "fetch_failed"] as const;

const idSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(255));
const timestampSchema = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.description("ISO 8601 timestamp in UTC."),
);
const sha256Schema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{64}$/u),
  v.description("Lowercase hex SHA-256 of the file bytes."),
);
const archivePathSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(4096),
  v.description(
    "Path inside the part's ZIP archive, `/`-separated, NFC-normalised.",
  ),
);
const byteCountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const countSchema = byteCountSchema;

const organizationSchema = v.strictObject({
  id: idSchema,
  name: v.string(),
});

const scopeSchema = v.strictObject({
  versions: v.pipe(
    v.picklist(DATA_EXPORT_VERSION_SCOPE_VALUES),
    v.description(
      "`all`: every document version; `current`: only each document's current version.",
    ),
  ),
});

/** One record table written as JSON (canonical) and CSV (for people). */
const recordFileSchema = v.strictObject({
  json: archivePathSchema,
  csv: v.nullable(archivePathSchema),
  count: countSchema,
});

const documentFileSchema = v.strictObject({
  fieldId: idSchema,
  fileId: idSchema,
  fileName: v.string(),
  mimeType: v.string(),
  sizeBytes: byteCountSchema,
  sha256: sha256Schema,
  path: archivePathSchema,
});

const documentVersionSchema = v.strictObject({
  id: idSchema,
  versionNumber: v.pipe(v.number(), v.integer(), v.minValue(0)),
  stamp: v.nullable(v.string()),
  label: v.nullable(v.string()),
  description: v.nullable(v.string()),
  createdAt: timestampSchema,
  createdBy: v.nullable(idSchema),
  files: v.array(documentFileSchema),
});

const documentSchema = v.strictObject({
  id: idSchema,
  kind: v.picklist(EXPORTED_DOCUMENT_KINDS),
  parentId: v.nullable(idSchema),
  name: v.string(),
  docSequence: v.nullable(v.pipe(v.number(), v.integer())),
  currentVersionId: v.nullable(idSchema),
  createdAt: timestampSchema,
  createdBy: v.nullable(idSchema),
  updatedAt: v.nullable(timestampSchema),
  lastEditedBy: v.nullable(idSchema),
  versions: v.array(documentVersionSchema),
});

const folderSchema = v.strictObject({
  id: idSchema,
  parentId: v.nullable(idSchema),
  name: v.string(),
  path: archivePathSchema,
});

const matterSchema = v.strictObject({
  id: idSchema,
  name: v.string(),
  reference: v.string(),
  status: v.string(),
  createdAt: timestampSchema,
  path: archivePathSchema,
  records: v.strictObject({
    matter: archivePathSchema,
    tasks: recordFileSchema,
    timeEntries: recordFileSchema,
    invoices: recordFileSchema,
  }),
  folders: v.array(folderSchema),
  documents: v.array(documentSchema),
});

const templateFileSchema = v.strictObject({
  templateId: idSchema,
  templateVersionId: idSchema,
  version: v.pipe(v.number(), v.integer(), v.minValue(0)),
  fileName: v.string(),
  sizeBytes: byteCountSchema,
  sha256: sha256Schema,
  path: archivePathSchema,
});

const organizationRecordsSchema = v.strictObject({
  contacts: recordFileSchema,
  contactRelationships: recordFileSchema,
  clauses: recordFileSchema,
  templates: recordFileSchema,
  unassignedTimeEntries: recordFileSchema,
  templateFiles: v.array(templateFileSchema),
});

/**
 * Something that needs attention. `missing` and `fetch_failed` files are
 * not in the archive. A `checksum_mismatch` file is in the archive as
 * stored; its file record carries the SHA-256 of those bytes, and
 * `recordedSha256` is the checksum recorded when it was uploaded. A
 * `matter_unavailable` matter was planned for this part but could no
 * longer be read (deleted, or no longer visible to the requester), so none
 * of it is in the archive.
 */
const problemSchema = v.variant("reason", [
  v.strictObject({
    reason: v.picklist(ABSENT_FILE_REASONS),
    path: archivePathSchema,
    fileId: idSchema,
  }),
  v.strictObject({
    reason: v.literal("checksum_mismatch"),
    path: archivePathSchema,
    fileId: idSchema,
    recordedSha256: sha256Schema,
  }),
  v.strictObject({
    reason: v.literal("matter_unavailable"),
    matterId: idSchema,
  }),
]);

const commonFields = {
  $schema: v.literal(DATA_EXPORT_SCHEMA_ID),
  format: v.literal(DATA_EXPORT_FORMAT),
  formatVersion: v.literal(DATA_EXPORT_FORMAT_VERSION),
  exportId: idSchema,
  organization: organizationSchema,
  createdAt: timestampSchema,
  scope: scopeSchema,
};

export const partManifestSchema = v.strictObject({
  ...commonFields,
  kind: v.literal("part"),
  part: v.strictObject({
    index: v.pipe(v.number(), v.integer(), v.minValue(1)),
    count: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  organizationRecords: v.pipe(
    v.nullable(organizationRecordsSchema),
    v.description("Organisation-wide records; present in part 1 only."),
  ),
  matters: v.array(matterSchema),
  problems: v.array(problemSchema),
});

const exportManifestSchema = v.strictObject({
  ...commonFields,
  kind: v.literal("export"),
  completedAt: timestampSchema,
  requestedBy: v.nullable(idSchema),
  parts: v.array(
    v.strictObject({
      index: v.pipe(v.number(), v.integer(), v.minValue(1)),
      fileName: v.string(),
      sizeBytes: byteCountSchema,
      sha256: sha256Schema,
      matterIds: v.array(idSchema),
      fileCount: countSchema,
    }),
  ),
  totals: v.strictObject({
    matters: countSchema,
    documents: countSchema,
    versions: countSchema,
    files: countSchema,
    fileBytes: byteCountSchema,
  }),
  problems: v.array(problemSchema),
});

export const dataExportManifestSchema = v.pipe(
  v.variant("kind", [partManifestSchema, exportManifestSchema]),
  v.title("stella data export manifest"),
  v.description(
    "A `part` manifest is `manifest.json` at the root of every part ZIP; " +
      "the `export` manifest (`export-manifest.json`) lists every part.",
  ),
);

export type PartManifest = v.InferOutput<typeof partManifestSchema>;
export type ExportManifest = v.InferOutput<typeof exportManifestSchema>;
export type ManifestMatter = PartManifest["matters"][number];
export type ManifestDocument = ManifestMatter["documents"][number];
export type ManifestRecordFile = ManifestMatter["records"]["tasks"];
export type ManifestProblem = PartManifest["problems"][number];
export type OrganizationRecords = NonNullable<
  PartManifest["organizationRecords"]
>;
export type ManifestTemplateFile = OrganizationRecords["templateFiles"][number];
