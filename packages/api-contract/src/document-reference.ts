/** The document version resolved from a frozen verification code. */
export type DocumentReferenceMatch = {
  entityId: string;
  entityName: string | null;
  workspaceId: string;
  workspaceName: string;
  /** The reference frozen onto the matched version. */
  stamp: string;
  /** The version the reference points at: what the holder of the file has. */
  versionNumber: number;
  /** Highest non-deleted version number the document currently has. */
  currentVersionNumber: number;
};
