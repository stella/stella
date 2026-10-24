// Assemble an organisation data export: plan parts at matter boundaries,
// stream each part as a ZIP to its sink, and return the export manifest.
//
// The run is low-priority background work and must never crowd out
// interactive use, so it is built to be cheap to hold and cheap to stop:
// - memory: files stream from storage into the ZIP chunk by chunk; only
//   small compressible files and per-matter records are held whole;
// - pace: `pace()` is awaited after every file and matter, so the caller
//   decides how much room the run takes;
// - checkpoints: the plan is fixed up front and every finished part is
//   reported through `onPartComplete`; a resumed run skips the parts it
//   already has and rebuilds only the part it was in.
//
// Storage and database access come in through `ExportSource` and
// `ExportSink`, so the archive layout, manifest and integrity rules are
// tested without either.

import { panic, Result, TaggedError } from "better-result";

import { compareCodeUnit } from "@stll/collation";
import { createSha256 } from "@stll/sha256/bun";
import type { Sha256Hasher } from "@stll/sha256/types";
import { normalizeUnicode } from "@stll/text-normalize";

import {
  ArchivePathAllocator,
  compressionForMimeType,
  sanitizeArchiveSegment,
  SEGMENT_SUFFIX_RESERVE,
  withSegmentSuffix,
} from "@/api/handlers/data-exports/archive-paths";
import {
  DATA_EXPORT_FORMAT,
  DATA_EXPORT_FORMAT_VERSION,
  DATA_EXPORT_SCHEMA_ID,
} from "@/api/handlers/data-exports/manifest-schema";
import type {
  DataExportVersionScope,
  ExportManifest,
  ManifestDocument,
  ManifestMatter,
  ManifestProblem,
  ManifestRecordFile,
  ManifestTemplateFile,
  OrganizationRecords,
  PartManifest,
} from "@/api/handlers/data-exports/manifest-schema";
import { planParts } from "@/api/handlers/data-exports/part-plan";
import { toCsv } from "@/api/handlers/data-exports/records";
import {
  writeZip,
  ZIP_COMPRESSION,
} from "@/api/handlers/data-exports/zip-writer";
import type {
  ZipCompression,
  ZipEntryInput,
} from "@/api/handlers/data-exports/zip-writer";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";

type RecordRow = Record<string, unknown>;

/** Rows of one record table plus its CSV column order. */
export type RecordTable = {
  columns: readonly string[];
  rows: readonly RecordRow[];
};

export type ExportFileRef =
  | {
      type: "document";
      workspaceId: string;
      fileId: string;
      mimeType: string;
    }
  | { type: "template"; templateVersionId: string };

export type FileRead =
  | { type: "found"; sizeBytes: number; chunks: AsyncIterable<Uint8Array> }
  | { type: "missing" }
  | { type: "failed" };

export type SourceDocumentFile = {
  fieldId: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
};

type SourceDocumentVersion = {
  id: string;
  versionNumber: number;
  stamp: string | null;
  label: string | null;
  description: string | null;
  createdAt: Date;
  createdBy: string | null;
  files: readonly SourceDocumentFile[];
};

export type SourceDocument = Omit<
  ManifestDocument,
  "createdAt" | "updatedAt" | "versions"
> & {
  createdAt: Date;
  updatedAt: Date | null;
  versions: readonly SourceDocumentVersion[];
};

type SourceFolder = {
  id: string;
  parentId: string | null;
  name: string;
};

export type SourceMatterSummary = {
  id: string;
  name: string;
  reference: string;
  status: string;
  createdAt: Date;
  /** Stored size of every file the export will carry for this matter. */
  estimatedBytes: number;
};

export type SourceMatter = {
  summary: SourceMatterSummary;
  record: RecordRow;
  folders: readonly SourceFolder[];
  documents: readonly SourceDocument[];
  tasks: RecordTable;
  timeEntries: RecordTable;
  invoices: RecordTable;
};

export type SourceTemplateFile = {
  templateId: string;
  templateName: string;
  templateVersionId: string;
  version: number;
  fileName: string;
  sizeBytes: number;
};

export type SourceOrganizationRecords = {
  contacts: RecordTable;
  contactRelationships: RecordTable;
  clauses: RecordTable;
  templates: RecordTable;
  unassignedTimeEntries: RecordTable;
  templateFiles: readonly SourceTemplateFile[];
};

export type ExportSource = {
  /**
   * Every matter in the export, in any order, sized for `scope`. Personal
   * matters are never part of an organisation export.
   */
  listMatters: (
    scope: DataExportVersionScope,
  ) => Promise<readonly SourceMatterSummary[]>;
  /** `null` when the matter is gone since the export was planned. */
  loadMatter: (
    matterId: string,
    scope: DataExportVersionScope,
  ) => Promise<SourceMatter | null>;
  loadOrganizationRecords: () => Promise<SourceOrganizationRecords>;
  /**
   * Expanded text size of the records an export reads into memory: the
   * organisation's records, and each listed matter's. Measured in the
   * database, without reading the rows.
   */
  measureRecords: (matterIds: readonly string[]) => Promise<RecordBytes>;
  readFile: (ref: ExportFileRef) => Promise<FileRead>;
};

export type RecordBytes = {
  organizationBytes: number;
  matterBytes: ReadonlyMap<string, number>;
};

/**
 * The most record text, expanded (uncompressed), one export may carry.
 * Records are read whole and serialised to JSON and CSV in memory, and a
 * part keeps its matters' metadata until it is written; bounding the
 * export's total bounds both. Above this an export is refused before any
 * record is loaded.
 */
export const DATA_EXPORT_RECORD_BYTES_CAP = 256 * 1024 ** 2;

/** The export's records exceed the cap. */
export class DataExportRecordsTooLargeError extends TaggedError(
  "DataExportRecordsTooLargeError",
)<{ message: string; bytes: number }> {}

/** Receives one part's bytes, in order. */
type PartSink = {
  write: (chunk: Uint8Array) => Promise<void>;
  /** Commit the part; called once after the last write. */
  close: () => Promise<void>;
};

export type ExportSink = {
  /** `estimatedBytes` is the plan's size for the part, for upload sizing. */
  openPart: (fileName: string, estimatedBytes: number) => PartSink;
};

/** The fixed split of an export into parts, stored before packing starts. */
export type ExportPlan = {
  parts: { index: number; matterIds: string[]; estimatedBytes: number }[];
  mattersTotal: number;
  bytesTotal: number;
};

/** A finished part: its manifest entry plus what the export manifest sums. */
export type CompletedPart = ExportManifest["parts"][number] & {
  totals: ExportManifest["totals"];
  problems: ManifestProblem[];
};

export type ExportProgress = {
  mattersDone: number;
  bytesDone: number;
  problemCount: number;
};

/**
 * Compressible files up to this size are read whole and deflated; anything
 * larger, or already compressed, streams through STORED.
 */
const DEFLATE_IN_MEMORY_MAX_BYTES = 8 * 1024 * 1024;

const MANIFEST_NAME = "manifest.json";
const README_NAME = "README.txt";
const ORGANIZATION_DIR = "organization";
const MATTERS_DIR = "matters";

const encoder = new TextEncoder();

const jsonBytes = (value: unknown): Uint8Array =>
  encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

const byName = (
  a: { name: string; id: string },
  b: { name: string; id: string },
): number =>
  compareCodeUnit(
    normalizeUnicode(a.name, "NFC"),
    normalizeUnicode(b.name, "NFC"),
  ) || compareCodeUnit(a.id, b.id);

/**
 * `Draft.docx` version 3 becomes `Draft (v3).docx`, shortened by UTF-8
 * bytes where needed so the segment, with room for a collision suffix,
 * stays inside the 255-byte file-name limit.
 */
const versionedFileName = (fileName: string, versionNumber: number): string =>
  withSegmentSuffix(
    sanitizeArchiveSegment(fileName),
    ` (v${versionNumber})`,
    SEGMENT_SUFFIX_RESERVE.open,
  );

const partFileName = ({
  exportId,
  index,
  count,
}: {
  exportId: string;
  index: number;
  count: number;
}): string => {
  const width = Math.max(2, String(count).length);
  const pad = (value: number) => String(value).padStart(width, "0");
  return `stella-export-${exportId.slice(0, 8)}-part-${pad(index)}-of-${pad(count)}.zip`;
};

const readme = ({
  exportId,
  index,
  count,
}: {
  exportId: string;
  index: number;
  count: number;
}): string =>
  [
    `stella data export ${exportId}, part ${index} of ${count}.`,
    "",
    `${MANIFEST_NAME} lists everything in this part: every matter, document and`,
    "document version, with ids, authors, timestamps, sizes, MIME types and",
    "SHA-256 checksums, and the path of each file in this archive. Its format",
    `("${DATA_EXPORT_FORMAT}", version ${DATA_EXPORT_FORMAT_VERSION}) is described by the JSON Schema at`,
    DATA_EXPORT_SCHEMA_ID,
    "",
    "matters/<matter>/documents   current version of every document",
    'matters/<matter>/versions    earlier versions, named "<name> (v<n>)"',
    "matters/<matter>/*.json      matter, tasks, time entries and invoices",
    "organization/                contacts, clauses and templates (part 1)",
    "",
    "JSON files are the canonical records. CSV files are for spreadsheets:",
    "cells that begin with =, +, - or @ are prefixed so they are not run as",
    "formulas. A matter is never split across parts, so each part can be",
    "used on its own. Files listed under `problems` in the manifest need",
    "attention: missing ones are not in the archive.",
    "",
  ].join("\n");

type PartContext = {
  allocator: ArchivePathAllocator;
  problems: ManifestProblem[];
  fileCount: number;
  createdAt: Date;
  source: ExportSource;
  pace: () => Promise<void>;
  signal: AbortSignal;
};

const bytesEntry = (
  name: string,
  data: Uint8Array,
  modifiedAt: Date,
  compression: ZipCompression = ZIP_COMPRESSION.DEFLATE,
): ZipEntryInput => ({
  name,
  modifiedAt,
  source: { type: "bytes", data, compression },
});

type WriteRecordArgs = {
  context: PartContext;
  directory: string;
  baseName: string;
  table: RecordTable;
};

/** JSON (canonical) and CSV entries for one record table. */
const recordEntries = ({
  context,
  directory,
  baseName,
  table,
}: WriteRecordArgs): { ref: ManifestRecordFile; entries: ZipEntryInput[] } => {
  const json = context.allocator.reserve(`${directory}/${baseName}.json`);
  const csv = context.allocator.reserve(`${directory}/${baseName}.csv`);
  return {
    ref: { json, csv, count: table.rows.length },
    entries: [
      bytesEntry(json, jsonBytes(table.rows), context.createdAt),
      bytesEntry(
        csv,
        encoder.encode(toCsv(table.columns, table.rows)),
        context.createdAt,
      ),
    ],
  };
};

const hashing = async function* (
  chunks: AsyncIterable<Uint8Array>,
  hasher: Sha256Hasher,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    signal.throwIfAborted();
    hasher.update(chunk);
    yield chunk;
  }
};

const collect = async (
  chunks: AsyncIterable<Uint8Array>,
): Promise<Uint8Array> => {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) {
    parts.push(chunk);
  }
  return Buffer.concat(parts);
};

type FileEntryArgs = {
  context: PartContext;
  ref: ExportFileRef;
  path: string;
  fileId: string;
  mimeType: string;
  modifiedAt: Date;
  recordedSha256: string | null;
};

type WrittenFile = { sha256: string; sizeBytes: number };

// Yield one stored file as a ZIP entry and return what was written, or
// `null` when the file could not be read (recorded as a problem). Large or
// already-compressed files stream through; small compressible ones are read
// whole so they can be deflated.
const fileEntry = async function* ({
  context,
  ref,
  path,
  fileId,
  mimeType,
  modifiedAt,
  recordedSha256,
}: FileEntryArgs): AsyncGenerator<ZipEntryInput, WrittenFile | null> {
  context.signal.throwIfAborted();
  const read = await context.source.readFile(ref);
  switch (read.type) {
    case "missing":
    case "failed":
      context.problems.push({
        reason: read.type === "missing" ? "missing" : "fetch_failed",
        path,
        fileId,
      });
      return null;
    case "found":
      break;
    default:
      read satisfies never;
      return panic("Unhandled file read");
  }
  const hasher = createSha256();
  let sizeBytes = read.sizeBytes;
  const compression = compressionForMimeType(mimeType);
  if (
    compression === ZIP_COMPRESSION.DEFLATE &&
    read.sizeBytes <= DEFLATE_IN_MEMORY_MAX_BYTES
  ) {
    const data = await collect(hashing(read.chunks, hasher, context.signal));
    sizeBytes = data.byteLength;
    yield bytesEntry(path, data, modifiedAt, compression);
  } else {
    // The writer drains the stream before asking for the next entry, so
    // the hash is complete once this yield resumes.
    yield {
      name: path,
      modifiedAt,
      source: {
        type: "stream",
        chunks: hashing(read.chunks, hasher, context.signal),
        sizeBytes: read.sizeBytes,
      },
    };
  }
  const sha256 = hasher.digest("hex");
  if (recordedSha256 !== null && sha256 !== recordedSha256.toLowerCase()) {
    context.problems.push({
      reason: "checksum_mismatch",
      path,
      fileId,
      recordedSha256: recordedSha256.toLowerCase(),
    });
  }
  context.fileCount += 1;
  await context.pace();
  return { sha256, sizeBytes };
};

type FolderDirectoriesArgs = {
  folders: readonly SourceFolder[];
  rootDir: string;
  allocator: ArchivePathAllocator;
};

/**
 * Map each folder id to its archive directory below `rootDir`. Folders
 * draw their paths from the part's allocator, so a file allocated later can
 * never take a name a folder already holds.
 */
const folderDirectories = ({
  folders,
  rootDir,
  allocator,
}: FolderDirectoriesArgs): Map<string, string> => {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const directories = new Map<string, string>();
  const resolving = new Set<string>();
  const resolve = (id: string | null): string => {
    if (id === null) {
      return rootDir;
    }
    const cached = directories.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const folder = byId.get(id);
    // A parent outside the folder set (a task, a missing row) or a cycle
    // falls back to the root rather than recursing without end.
    if (folder === undefined || resolving.has(id)) {
      return rootDir;
    }
    resolving.add(id);
    const directory = allocator.allocate(resolve(folder.parentId), folder.name);
    resolving.delete(id);
    directories.set(id, directory);
    return directory;
  };
  for (const folder of folders.toSorted(byName)) {
    resolve(folder.id);
  }
  return directories;
};

type MatterEntriesArgs = {
  context: PartContext;
  matter: SourceMatter;
  matterDir: string;
};

// Yield one matter's entries and return its manifest record.
const matterEntries = async function* ({
  context,
  matter,
  matterDir,
}: MatterEntriesArgs): AsyncGenerator<ZipEntryInput, ManifestMatter> {
  const { summary } = matter;
  const matterJson = context.allocator.reserve(`${matterDir}/matter.json`);
  yield bytesEntry(matterJson, jsonBytes(matter.record), context.createdAt);
  const tasks = recordEntries({
    context,
    directory: matterDir,
    baseName: "tasks",
    table: matter.tasks,
  });
  const timeEntries = recordEntries({
    context,
    directory: matterDir,
    baseName: "time-entries",
    table: matter.timeEntries,
  });
  const invoices = recordEntries({
    context,
    directory: matterDir,
    baseName: "invoices",
    table: matter.invoices,
  });
  yield* tasks.entries;
  yield* timeEntries.entries;
  yield* invoices.entries;

  const documentsDir = `${matterDir}/documents`;
  const versionsDir = `${matterDir}/versions`;
  const directories = folderDirectories({
    folders: matter.folders,
    rootDir: documentsDir,
    allocator: context.allocator,
  });
  // Earlier versions mirror the folder tree under versions/. Its directories
  // are allocated before any file, like the current ones, so a historical
  // file's name never takes a directory's path.
  const historyDirectories = folderDirectories({
    folders: matter.folders,
    rootDir: versionsDir,
    allocator: context.allocator,
  });
  const documents: ManifestDocument[] = [];
  for (const document of matter.documents.toSorted(byName)) {
    const currentDir =
      document.parentId === null
        ? documentsDir
        : (directories.get(document.parentId) ?? documentsDir);
    const historyDir =
      document.parentId === null
        ? versionsDir
        : (historyDirectories.get(document.parentId) ?? versionsDir);
    const versions: ManifestDocument["versions"] = [];
    const orderedVersions = document.versions.toSorted(
      (a, b) =>
        a.versionNumber - b.versionNumber || compareCodeUnit(a.id, b.id),
    );
    for (const version of orderedVersions) {
      const isCurrent = version.id === document.currentVersionId;
      const files: ManifestDocument["versions"][number]["files"] = [];
      for (const file of version.files) {
        const path = isCurrent
          ? context.allocator.allocate(currentDir, file.fileName)
          : context.allocator.allocate(
              historyDir,
              versionedFileName(file.fileName, version.versionNumber),
            );
        const written = yield* fileEntry({
          context,
          ref: {
            type: "document",
            workspaceId: summary.id,
            fileId: file.fileId,
            mimeType: file.mimeType,
          },
          path,
          fileId: file.fileId,
          mimeType: file.mimeType,
          modifiedAt: version.createdAt,
          recordedSha256: file.sha256,
        });
        if (written !== null) {
          files.push({
            ...file,
            sha256: written.sha256,
            sizeBytes: written.sizeBytes,
            path,
          });
        }
      }
      versions.push({
        id: version.id,
        versionNumber: version.versionNumber,
        stamp: version.stamp,
        label: version.label,
        description: version.description,
        createdAt: version.createdAt.toISOString(),
        createdBy: version.createdBy,
        files,
      });
    }
    documents.push({
      id: document.id,
      kind: document.kind,
      parentId: document.parentId,
      name: document.name,
      docSequence: document.docSequence,
      currentVersionId: document.currentVersionId,
      createdAt: document.createdAt.toISOString(),
      createdBy: document.createdBy,
      updatedAt: document.updatedAt?.toISOString() ?? null,
      lastEditedBy: document.lastEditedBy,
      versions,
    });
  }

  return {
    id: summary.id,
    name: summary.name,
    reference: summary.reference,
    status: summary.status,
    createdAt: summary.createdAt.toISOString(),
    path: matterDir,
    records: {
      matter: matterJson,
      tasks: tasks.ref,
      timeEntries: timeEntries.ref,
      invoices: invoices.ref,
    },
    folders: matter.folders.map((folder) => ({
      id: folder.id,
      parentId: folder.parentId,
      name: folder.name,
      path: directories.get(folder.id) ?? documentsDir,
    })),
    documents,
  };
};

type OrganizationEntriesArgs = {
  context: PartContext;
  records: SourceOrganizationRecords;
};

// Yield the organisation-wide records and template files (part 1 only).
const organizationEntries = async function* ({
  context,
  records,
}: OrganizationEntriesArgs): AsyncGenerator<
  ZipEntryInput,
  OrganizationRecords
> {
  const table = (baseName: string, rows: RecordTable) =>
    recordEntries({
      context,
      directory: ORGANIZATION_DIR,
      baseName,
      table: rows,
    });
  const tables = {
    contacts: table("contacts", records.contacts),
    contactRelationships: table(
      "contact-relationships",
      records.contactRelationships,
    ),
    clauses: table("clauses", records.clauses),
    templates: table("templates", records.templates),
    unassignedTimeEntries: table(
      "time-entries-without-matter",
      records.unassignedTimeEntries,
    ),
  };
  for (const recordFile of Object.values(tables)) {
    yield* recordFile.entries;
  }

  const templateFiles: ManifestTemplateFile[] = [];
  const templateDirs = new ArchivePathAllocator();
  const templateDirById = new Map<string, string>();
  const orderedFiles = records.templateFiles.toSorted(
    (a, b) =>
      compareCodeUnit(a.templateName, b.templateName) ||
      compareCodeUnit(a.templateId, b.templateId) ||
      a.version - b.version,
  );
  for (const file of orderedFiles) {
    const directory =
      templateDirById.get(file.templateId) ??
      templateDirs.allocate(`${ORGANIZATION_DIR}/templates`, file.templateName);
    templateDirById.set(file.templateId, directory);
    const path = context.allocator.allocate(
      directory,
      versionedFileName(file.fileName, file.version),
    );
    const written = yield* fileEntry({
      context,
      ref: { type: "template", templateVersionId: file.templateVersionId },
      path,
      fileId: file.templateVersionId,
      mimeType: "application/octet-stream",
      modifiedAt: context.createdAt,
      recordedSha256: null,
    });
    if (written === null) {
      continue;
    }
    templateFiles.push({
      templateId: file.templateId,
      templateVersionId: file.templateVersionId,
      version: file.version,
      // Stored template names were sanitised on upload; this is idempotent.
      fileName: sanitizeFilename(file.fileName),
      sizeBytes: written.sizeBytes,
      sha256: written.sha256,
      path,
    });
  }

  return {
    contacts: tables.contacts.ref,
    contactRelationships: tables.contactRelationships.ref,
    clauses: tables.clauses.ref,
    templates: tables.templates.ref,
    unassignedTimeEntries: tables.unassignedTimeEntries.ref,
    templateFiles,
  };
};

const sumTotals = (matters: readonly ManifestMatter[]) => {
  const totals = {
    matters: 0,
    documents: 0,
    versions: 0,
    files: 0,
    fileBytes: 0,
  };
  for (const matter of matters) {
    totals.matters += 1;
    totals.documents += matter.documents.length;
    for (const document of matter.documents) {
      totals.versions += document.versions.length;
      for (const version of document.versions) {
        totals.files += version.files.length;
        for (const file of version.files) {
          totals.fileBytes += file.sizeBytes;
        }
      }
    }
  }
  return totals;
};

type PlanDataExportArgs = {
  source: ExportSource;
  partTargetBytes: number;
  recordBytesCap: number;
  scope: { versions: DataExportVersionScope };
};

/**
 * Measure the records the export will read and refuse it when they exceed
 * the cap. Every attempt runs it before loading a record: records added
 * after the plan was stored count against a resumed attempt too.
 */
type AdmitDataExportRecordsOptions = {
  source: ExportSource;
  matterIds: readonly string[];
  /** `DATA_EXPORT_RECORD_BYTES_CAP` in production. */
  recordBytesCap: number;
};

export const admitDataExportRecords = async ({
  source,
  matterIds,
  recordBytesCap,
}: AdmitDataExportRecordsOptions): Promise<
  Result<RecordBytes, DataExportRecordsTooLargeError>
> => {
  const records = await source.measureRecords(matterIds);
  const recordBytes = [...records.matterBytes.values()].reduce(
    (sum, bytes) => sum + bytes,
    records.organizationBytes,
  );
  return recordBytes > recordBytesCap
    ? Result.err(
        new DataExportRecordsTooLargeError({
          message: "The export's records exceed the export record limit",
          bytes: recordBytes,
        }),
      )
    : Result.ok(records);
};

/** Fix the split into parts. Stored, so a resumed run packs the same parts. */
export const planDataExport = async ({
  source,
  partTargetBytes,
  recordBytesCap,
  scope,
}: PlanDataExportArgs): Promise<
  Result<ExportPlan, DataExportRecordsTooLargeError>
> => {
  const listed = (await source.listMatters(scope.versions)).toSorted(byName);
  // Admission comes first: an export whose records cannot be held in memory
  // is refused before any of them is loaded.
  const admitted = await admitDataExportRecords({
    source,
    matterIds: listed.map((m) => m.id),
    recordBytesCap,
  });
  if (admitted.isErr()) {
    return Result.err(admitted.error);
  }
  const records = admitted.value;
  // Parts are sized by everything they carry, records included.
  const matters = listed.map((matter) => ({
    id: matter.id,
    estimatedBytes:
      matter.estimatedBytes + (records.matterBytes.get(matter.id) ?? 0),
  }));
  const organization = await source.loadOrganizationRecords();
  const organizationBytes =
    records.organizationBytes +
    organization.templateFiles.reduce((sum, file) => sum + file.sizeBytes, 0);
  const bytesById = new Map(matters.map((m) => [m.id, m.estimatedBytes]));
  const parts = planParts({
    matters: matters.map((matter) => ({
      matterId: matter.id,
      estimatedBytes: matter.estimatedBytes,
    })),
    targetBytes: partTargetBytes,
    organizationBytes,
  });
  return Result.ok({
    parts: parts.map((part) => ({
      index: part.index,
      matterIds: part.matterIds,
      estimatedBytes: part.estimatedBytes,
    })),
    mattersTotal: matters.length,
    bytesTotal:
      organizationBytes +
      [...bytesById.values()].reduce((sum, bytes) => sum + bytes, 0),
  });
};

type BuildDataExportArgs = {
  exportId: string;
  organization: { id: string; name: string };
  requestedBy: string | null;
  createdAt: Date;
  scope: { versions: DataExportVersionScope };
  plan: ExportPlan;
  /** Parts a previous attempt finished; they are not rebuilt. */
  completedParts: readonly CompletedPart[];
  source: ExportSource;
  sink: ExportSink;
  /** Awaited after every file and matter: the run's share of the system. */
  pace: () => Promise<void>;
  /** Stops the run between chunks; the current part is abandoned. */
  signal: AbortSignal;
  /** Awaited after each part is committed: the checkpoint. */
  onPartComplete: (part: CompletedPart) => Promise<void>;
  /**
   * Awaited before each part; throws to stop the run (for instance when the
   * requester no longer holds the export permission).
   */
  beforePart: () => Promise<void>;
  /** Awaited after each matter. */
  onProgress?: (progress: ExportProgress) => Promise<void>;
  now?: () => Date;
};

/**
 * Build every part not yet completed and return the export manifest, which
 * covers all parts. A thrown error (including an abort) leaves completed
 * parts checkpointed and the current part unwritten.
 */
export const buildDataExport = async ({
  exportId,
  organization,
  requestedBy,
  createdAt,
  scope,
  plan,
  completedParts,
  source,
  sink,
  pace,
  signal,
  onPartComplete,
  beforePart,
  onProgress,
  now = () => new Date(),
}: BuildDataExportArgs): Promise<ExportManifest> => {
  const common = {
    $schema: DATA_EXPORT_SCHEMA_ID,
    format: DATA_EXPORT_FORMAT,
    formatVersion: DATA_EXPORT_FORMAT_VERSION,
    exportId,
    organization,
    createdAt: createdAt.toISOString(),
    scope,
  } as const;
  const count = plan.parts.length;
  const done = new Map(completedParts.map((part) => [part.index, part]));
  const progress: ExportProgress = {
    mattersDone: 0,
    bytesDone: 0,
    problemCount: 0,
  };
  for (const part of done.values()) {
    progress.mattersDone += part.matterIds.length;
    progress.problemCount += part.problems.length;
  }
  for (const planned of plan.parts) {
    if (done.has(planned.index)) {
      progress.bytesDone += planned.estimatedBytes;
    }
  }

  for (const planned of plan.parts) {
    if (done.has(planned.index)) {
      continue;
    }
    signal.throwIfAborted();
    await beforePart();
    const context: PartContext = {
      allocator: new ArchivePathAllocator(),
      problems: [],
      fileCount: 0,
      createdAt,
      source,
      pace,
      signal,
    };
    context.allocator.reserve(MANIFEST_NAME);
    context.allocator.reserve(README_NAME);
    const matterDirs = new ArchivePathAllocator();
    const manifestMatters: ManifestMatter[] = [];
    let manifestOrganization: OrganizationRecords | null = null;
    let partBytesDone = 0;

    const entries = async function* (): AsyncGenerator<ZipEntryInput> {
      yield bytesEntry(
        README_NAME,
        encoder.encode(readme({ exportId, index: planned.index, count })),
        createdAt,
      );
      if (planned.index === 1) {
        manifestOrganization = yield* organizationEntries({
          context,
          records: await source.loadOrganizationRecords(),
        });
      }
      for (const matterId of planned.matterIds) {
        signal.throwIfAborted();
        const matter = await source.loadMatter(matterId, scope.versions);
        await pace();
        // Planned but no longer readable: deleted since the plan was made, or
        // out of the requester's reach. Recorded, never dropped silently.
        if (matter === null) {
          context.problems.push({ reason: "matter_unavailable", matterId });
        } else {
          const label =
            matter.summary.reference.length > 0
              ? `${matter.summary.name} [${matter.summary.reference}]`
              : matter.summary.name;
          manifestMatters.push(
            yield* matterEntries({
              context,
              matter,
              matterDir: matterDirs.allocate(MATTERS_DIR, label),
            }),
          );
          partBytesDone += matter.summary.estimatedBytes;
        }
        await onProgress?.({
          mattersDone: progress.mattersDone + manifestMatters.length,
          bytesDone: progress.bytesDone + partBytesDone,
          problemCount: progress.problemCount + context.problems.length,
        });
      }
      const partManifest: PartManifest = {
        ...common,
        kind: "part",
        part: { index: planned.index, count },
        organizationRecords: manifestOrganization,
        matters: manifestMatters,
        problems: context.problems,
      };
      yield bytesEntry(MANIFEST_NAME, jsonBytes(partManifest), createdAt);
    };

    const fileName = partFileName({ exportId, index: planned.index, count });
    const partSink = sink.openPart(fileName, planned.estimatedBytes);
    const hasher = createSha256();
    let sizeBytes = 0;
    for await (const chunk of writeZip(entries())) {
      hasher.update(chunk);
      sizeBytes += chunk.byteLength;
      await partSink.write(chunk);
    }
    await partSink.close();

    const completed: CompletedPart = {
      index: planned.index,
      fileName,
      sizeBytes,
      sha256: hasher.digest("hex"),
      matterIds: manifestMatters.map((matter) => matter.id),
      fileCount: context.fileCount,
      totals: sumTotals(manifestMatters),
      problems: context.problems,
    };
    await onPartComplete(completed);
    done.set(completed.index, completed);
    progress.mattersDone += planned.matterIds.length;
    progress.bytesDone += planned.estimatedBytes;
    progress.problemCount += context.problems.length;
  }

  const parts = plan.parts.map(
    (planned) =>
      done.get(planned.index) ??
      panic(`Part ${planned.index} finished without a checkpoint`),
  );
  const totals = {
    matters: 0,
    documents: 0,
    versions: 0,
    files: 0,
    fileBytes: 0,
  };
  const problems: ManifestProblem[] = [];
  for (const part of parts) {
    totals.matters += part.totals.matters;
    totals.documents += part.totals.documents;
    totals.versions += part.totals.versions;
    totals.files += part.totals.files;
    totals.fileBytes += part.totals.fileBytes;
    problems.push(...part.problems);
  }
  return {
    ...common,
    kind: "export",
    completedAt: now().toISOString(),
    requestedBy,
    // The manifest entry is the checkpoint without what it sums up.
    parts: parts.map(
      ({ totals: _partTotals, problems: _partProblems, ...entry }) => entry,
    ),
    totals,
    problems,
  };
};
