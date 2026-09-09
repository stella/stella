/**
 * What a file dropped on a document row should be offered as.
 *
 * A DOCX that left stella carries its reference, so the file itself can say
 * which document it belongs to. That evidence outranks the filename heuristic:
 * matching extensions only ever meant "this could plausibly be a version of
 * that", while a reference means "this is version 3 of that". The extension
 * comparison stays as the answer for everything that carries no reference.
 *
 * How strong that evidence is decides which offer leads: a file that kept only
 * the hidden property is offered as a new document first.
 */
import type { DocumentReferenceMatch } from "@stll/api-contract";

import type { ReferenceUploadAction } from "@/lib/files/document-reference";
import { defaultReferenceUploadAction } from "@/lib/files/document-reference";
import type { ResolvedDocumentReference } from "@/lib/files/document-reference-queries";
import { extensionMatches, getExtension } from "@/lib/files/file-extension";

/** A reference such as `2026/001/015.v3` with the version suffix removed. */
const VERSION_SUFFIX_RE = /\.v\d+$/u;

/** What the person dropping the file chose to do with it. */
export const VERSION_OR_NEW_FILE_CHOICE = {
  /** Next version of the document it was dropped on. */
  versionHere: "version-here",
  /** Next version of the document its reference names. */
  versionElsewhere: "version-elsewhere",
  /** A new document in the matter it was dropped into. */
  newDocument: "new-document",
} as const;

export type VersionOrNewFileChoice =
  (typeof VERSION_OR_NEW_FILE_CHOICE)[keyof typeof VERSION_OR_NEW_FILE_CHOICE];

type ReferencedDocument = {
  entityId: string;
  workspaceId: string;
  /** Null when the document has no name of its own to show. */
  documentName: string | null;
  matterName: string;
  /** The reference without its version suffix (`2026/001/015`). */
  documentReference: string;
  /** Version the dropped file was taken from. */
  versionNumber: number;
  /** Version number the upload would become. */
  nextVersionNumber: number;
};

/**
 * Set when the dropped file was taken from a version the document has since
 * moved past — the one thing the person dropping it cannot see for themselves.
 */
type SupersededBase = {
  basedOnVersionNumber: number;
  currentVersionNumber: number;
};

export type VersionOrNewFileDecision =
  | {
      /** The file is a version of the very document it was dropped on. */
      type: "reference-here";
      document: ReferencedDocument;
      supersededBase: SupersededBase | null;
      defaultAction: ReferenceUploadAction;
    }
  | {
      /** The file belongs to another document, possibly in another matter. */
      type: "reference-elsewhere";
      document: ReferencedDocument;
      supersededBase: SupersededBase | null;
      defaultAction: ReferenceUploadAction;
    }
  | {
      /** No reference: fall back to comparing file extensions. */
      type: "extension";
      canReplace: boolean;
      entityExtension: string | null;
      uploadExtension: string | null;
    };

type ResolveVersionOrNewFileDecisionOptions = {
  /** Resolved reference the dropped file carries, or null when it has none. */
  reference: ResolvedDocumentReference | null;
  /** The document the file was dropped on. */
  droppedOnEntityId: string;
  /** Filename of that document's current file. */
  entityFileName: string | null | undefined;
  droppedFileName: string;
};

export const resolveVersionOrNewFileDecision = ({
  reference,
  droppedOnEntityId,
  entityFileName,
  droppedFileName,
}: ResolveVersionOrNewFileDecisionOptions): VersionOrNewFileDecision => {
  if (reference === null) {
    return {
      type: "extension",
      canReplace: extensionMatches({
        entityFileName,
        uploadFileName: droppedFileName,
      }),
      entityExtension: entityFileName ? getExtension(entityFileName) : null,
      uploadExtension: getExtension(droppedFileName),
    };
  }

  const { match, evidence } = reference;
  return {
    type:
      match.entityId === droppedOnEntityId
        ? "reference-here"
        : "reference-elsewhere",
    document: toReferencedDocument(match),
    supersededBase: toSupersededBase(match),
    defaultAction: defaultReferenceUploadAction(evidence),
  };
};

const toReferencedDocument = (
  match: DocumentReferenceMatch,
): ReferencedDocument => ({
  entityId: match.entityId,
  workspaceId: match.workspaceId,
  documentName: match.entityName,
  matterName: match.workspaceName,
  documentReference: match.stamp.replace(VERSION_SUFFIX_RE, ""),
  versionNumber: match.versionNumber,
  nextVersionNumber: match.currentVersionNumber + 1,
});

const toSupersededBase = (
  match: DocumentReferenceMatch,
): SupersededBase | null =>
  match.versionNumber < match.currentVersionNumber
    ? {
        basedOnVersionNumber: match.versionNumber,
        currentVersionNumber: match.currentVersionNumber,
      }
    : null;
