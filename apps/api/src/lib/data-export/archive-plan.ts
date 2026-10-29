/** Record names are the shared contract for path planning and packing. */
export const DATA_EXPORT_MATTER_RECORD_NAMES = {
  tasks: "tasks",
  timeEntries: "time-entries",
  expenses: "expenses",
  invoices: "invoices",
} as const;

export const DATA_EXPORT_ORGANIZATION_RECORD_NAMES = {
  sellerProfiles: "seller-profiles",
  clauseCategories: "clause-categories",
  templateCategories: "template-categories",
  contacts: "contacts",
  contactRelationships: "contact-relationships",
  clauses: "clauses",
  templates: "templates",
  unassignedTimeEntries: "time-entries-without-matter",
  invoices: "invoices-without-matter",
} as const;

export type DataExportMatterRecordKind =
  keyof typeof DATA_EXPORT_MATTER_RECORD_NAMES;
export type DataExportOrganizationRecordKind =
  keyof typeof DATA_EXPORT_ORGANIZATION_RECORD_NAMES;
export type DataExportRecordPaths = { json: string; csv: string };
export type DataExportDocumentPaths = {
  versions: Record<string, { files: Record<string, string> }>;
};
export type DataExportMatterPaths = {
  directory: string;
  record: string;
  records: Record<DataExportMatterRecordKind, DataExportRecordPaths>;
  folders: Record<string, { current: string; history: string }>;
  documents: Record<string, DataExportDocumentPaths>;
};
export type DataExportOrganizationPaths = {
  records: Record<DataExportOrganizationRecordKind, DataExportRecordPaths>;
  templateFiles: Record<string, string>;
};
export type DataExportPlanRecord = {
  parts: {
    index: number;
    matterIds: string[];
    estimatedBytes: number;
    paths: { manifest: string; readme: string };
  }[];
  mattersTotal: number;
  bytesTotal: number;
  paths: {
    organization: DataExportOrganizationPaths;
    matters: Record<string, DataExportMatterPaths>;
  };
};
