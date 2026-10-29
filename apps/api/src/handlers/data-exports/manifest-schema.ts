// The data export format contract. This Valibot schema is the source of
// truth; `docs/data-export/stella-data-export.v1.schema.json` is generated
// from it (`bun apps/api/scripts/generate-data-export-schema.ts`) and a test
// fails when the two drift. An importer reads the JSON Schema; stella's own
// tests parse every manifest it builds through this schema.

import * as v from "valibot";

import { API_STORABLE_INSTANT_CHECK } from "@stll/api-contract/api-date";

import {
  dataExportArchivePathSchema as archivePathSchema,
  dataExportIdSchema as idSchema,
  dataExportSha256Schema as sha256Schema,
} from "@/api/lib/data-export/manifest-values";
import { dataExportProblemSchema as problemSchema } from "@/api/lib/data-export/problem-schema";
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

const timestampSchema = v.pipe(
  v.string(),
  v.isoTimestamp(),
  API_STORABLE_INSTANT_CHECK,
  v.description("ISO 8601 timestamp in UTC."),
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
    expenses: recordFileSchema,
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
  sellerProfiles: recordFileSchema,
  clauseCategories: recordFileSchema,
  templateCategories: recordFileSchema,
  contacts: recordFileSchema,
  contactRelationships: recordFileSchema,
  clauses: recordFileSchema,
  templates: recordFileSchema,
  unassignedTimeEntries: recordFileSchema,
  invoices: recordFileSchema,
  templateFiles: v.array(templateFileSchema),
});

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
