import { panic } from "better-result";

import { compareCodeUnit } from "@stll/collation";

import {
  ArchivePathAllocator,
  compareArchiveNames,
  sanitizeArchiveSegment,
  SEGMENT_SUFFIX_RESERVE,
  withSegmentSuffix,
} from "@/api/handlers/data-exports/archive-paths";
import type {
  ExportSource,
  SourceMatter,
  SourceMatterSummary,
  SourceOrganizationRecords,
  SourceTemplateFile,
} from "@/api/handlers/data-exports/build-export";
import type { DataExportVersionScope } from "@/api/handlers/data-exports/manifest-schema";
import type { PlannedPart } from "@/api/handlers/data-exports/part-plan";
import {
  DATA_EXPORT_MATTER_RECORD_NAMES,
  DATA_EXPORT_ORGANIZATION_RECORD_NAMES,
} from "@/api/lib/data-export/archive-plan";
import type {
  DataExportDocumentPaths,
  DataExportMatterPaths,
  DataExportOrganizationPaths,
  DataExportPlanRecord,
  DataExportRecordPaths,
} from "@/api/lib/data-export/archive-plan";

const versionedFileName = (name: string, version: number) =>
  withSegmentSuffix(
    sanitizeArchiveSegment(name),
    ` (v${version})`,
    SEGMENT_SUFFIX_RESERVE.open,
  );

const recordPaths = (
  allocator: ArchivePathAllocator,
  path: string,
): DataExportRecordPaths => ({
  json: allocator.reserve(`${path}.json`),
  csv: allocator.reserve(`${path}.csv`),
});

type PlanOrganizationPathsArgs = {
  allocator: ArchivePathAllocator;
  templateFiles: readonly SourceTemplateFile[];
};

/** The same allocator owns every directory and entry in the entire export. */
export const planOrganizationPaths = ({
  allocator,
  templateFiles,
}: PlanOrganizationPathsArgs): DataExportOrganizationPaths => {
  const record = (key: keyof typeof DATA_EXPORT_ORGANIZATION_RECORD_NAMES) =>
    recordPaths(
      allocator,
      `organization/${DATA_EXPORT_ORGANIZATION_RECORD_NAMES[key]}`,
    );
  const records = {
    sellerProfiles: record("sellerProfiles"),
    clauseCategories: record("clauseCategories"),
    templateCategories: record("templateCategories"),
    contacts: record("contacts"),
    contactRelationships: record("contactRelationships"),
    clauses: record("clauses"),
    templates: record("templates"),
    unassignedTimeEntries: record("unassignedTimeEntries"),
    invoices: record("invoices"),
  };
  const paths = new Map<string, string>();
  const directories = new Map<string, string>();
  const ordered = templateFiles.toSorted(
    (a, b) =>
      compareArchiveNames(
        { name: a.templateName, id: a.templateId },
        { name: b.templateName, id: b.templateId },
      ) || a.version - b.version,
  );
  for (const file of ordered) {
    const directory =
      directories.get(file.templateId) ??
      allocator.allocate("organization/templates", file.templateName);
    directories.set(file.templateId, directory);
    paths.set(
      file.templateVersionId,
      allocator.allocate(
        directory,
        versionedFileName(file.fileName, file.version),
      ),
    );
  }
  return { records, templateFiles: Object.fromEntries(paths) };
};

type FolderPathsArgs = {
  folders: SourceMatter["folders"];
  root: string;
  allocator: ArchivePathAllocator;
};

const folderPaths = ({ folders, root, allocator }: FolderPathsArgs) => {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map<string, string>();
  const resolving = new Set<string>();
  const resolve = (id: string | null): string => {
    if (id === null) {
      return root;
    }
    const existing = paths.get(id);
    if (existing !== undefined) {
      return existing;
    }
    const folder = byId.get(id);
    // Missing/non-folder parents and cycles retain the established root fallback.
    if (folder === undefined || resolving.has(id)) {
      return root;
    }
    resolving.add(id);
    const path = allocator.allocate(resolve(folder.parentId), folder.name);
    resolving.delete(id);
    paths.set(id, path);
    return path;
  };
  for (const folder of folders.toSorted(compareArchiveNames)) {
    resolve(folder.id);
  }
  return paths;
};

type PlanMatterPathsArgs = {
  allocator: ArchivePathAllocator;
  directory: string;
  matter: SourceMatter | null;
};

const planMatterPaths = ({
  allocator,
  directory,
  matter,
}: PlanMatterPathsArgs): DataExportMatterPaths => {
  const record = allocator.reserve(`${directory}/matter.json`);
  const table = (key: keyof typeof DATA_EXPORT_MATTER_RECORD_NAMES) =>
    recordPaths(
      allocator,
      `${directory}/${DATA_EXPORT_MATTER_RECORD_NAMES[key]}`,
    );
  const records = {
    tasks: table("tasks"),
    timeEntries: table("timeEntries"),
    expenses: table("expenses"),
    invoices: table("invoices"),
  };
  const folders = new Map<string, { current: string; history: string }>();
  const documents = new Map<string, DataExportDocumentPaths>();
  if (matter === null) {
    return {
      directory,
      record,
      records,
      folders: Object.fromEntries(folders),
      documents: Object.fromEntries(documents),
    };
  }
  const currentRoot = allocator.reserve(`${directory}/documents`);
  const historyRoot = allocator.reserve(`${directory}/versions`);
  const current = folderPaths({
    folders: matter.folders,
    root: currentRoot,
    allocator,
  });
  const history = folderPaths({
    folders: matter.folders,
    root: historyRoot,
    allocator,
  });
  for (const folder of matter.folders) {
    folders.set(folder.id, {
      current:
        current.get(folder.id) ??
        panic("Planned current folder path is missing"),
      history:
        history.get(folder.id) ??
        panic("Planned historical folder path is missing"),
    });
  }
  for (const document of matter.documents.toSorted(compareArchiveNames)) {
    const currentDirectory =
      document.parentId === null
        ? currentRoot
        : (current.get(document.parentId) ?? currentRoot);
    const historyDirectory =
      document.parentId === null
        ? historyRoot
        : (history.get(document.parentId) ?? historyRoot);
    const versions = new Map<
      string,
      DataExportDocumentPaths["versions"][string]
    >();
    for (const version of document.versions.toSorted(
      (a, b) =>
        a.versionNumber - b.versionNumber || compareCodeUnit(a.id, b.id),
    )) {
      const files = new Map<
        string,
        DataExportDocumentPaths["versions"][string]["files"][string]
      >();
      for (const file of version.files) {
        files.set(file.fieldId, {
          fileId: file.fileId,
          mimeType: file.mimeType,
          path:
            version.id === document.currentVersionId
              ? allocator.allocate(currentDirectory, file.fileName)
              : allocator.allocate(
                  historyDirectory,
                  versionedFileName(file.fileName, version.versionNumber),
                ),
        });
      }
      versions.set(version.id, { files: Object.fromEntries(files) });
    }
    documents.set(document.id, {
      currentVersionId: document.currentVersionId,
      versions: Object.fromEntries(versions),
    });
  }
  return {
    directory,
    record,
    records,
    folders: Object.fromEntries(folders),
    documents: Object.fromEntries(documents),
  };
};

type PlanArchivePathsArgs = {
  source: ExportSource;
  parts: readonly PlannedPart[];
  matters: readonly SourceMatterSummary[];
  organization: SourceOrganizationRecords;
  scope: DataExportVersionScope;
  pace: () => Promise<void>;
};

export const planArchivePaths = async ({
  source,
  parts,
  matters,
  organization,
  scope,
  pace,
}: PlanArchivePathsArgs): Promise<
  Pick<DataExportPlanRecord, "parts" | "paths">
> => {
  const allocator = new ArchivePathAllocator();
  const width = Math.max(2, String(parts.length).length);
  const plannedParts = parts.map((part) => {
    const directory = allocator.allocate(
      "parts",
      `part-${String(part.index).padStart(width, "0")}`,
    );
    return {
      ...part,
      paths: {
        manifest: allocator.reserve(`${directory}/manifest.json`),
        readme: allocator.reserve(`${directory}/README.txt`),
      },
    };
  });
  const organizationPaths = planOrganizationPaths({
    allocator,
    templateFiles: organization.templateFiles,
  });
  const matterPaths = new Map<string, DataExportMatterPaths>();
  for (const summary of matters) {
    const label =
      summary.reference.length > 0
        ? `${summary.name} [${summary.reference}]`
        : summary.name;
    const directory = allocator.allocate("matters", label);
    // One matter's metadata at a time; file bytes are never read while planning.
    const matter = await source.loadMatter(summary.id, scope);
    matterPaths.set(
      summary.id,
      planMatterPaths({ allocator, directory, matter }),
    );
    await pace();
  }
  return {
    parts: plannedParts,
    paths: {
      organization: organizationPaths,
      matters: Object.fromEntries(matterPaths),
    },
  };
};
