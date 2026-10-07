/**
 * Where an anchor fact comes from: its first source's document and page,
 * opening the document there.
 */

import { useQuery } from "@tanstack/react-query";

import { Button } from "@stll/ui/button";

import {
  SourceLocatorLabel,
  sourceLocatorPage,
  useOpenSourceDocument,
} from "@/components/workspaces/list-source";
import { evidenceSourceDocumentName } from "@/features/avt/fact-source.logic";
import type { EvidenceFact } from "@/features/avt/types";
import type { LegalListSourceLocator } from "@/lib/api-contract";
import { useQueryView } from "@/lib/use-query-view";
import { useQueryViewError } from "@/lib/use-query-view-error";
import { workspaceFilesOptions } from "@/lib/workspaces/queries/entities";

type FactSourceProps = {
  workspaceId: string;
  documentId: string;
  documentName: string;
  locator: LegalListSourceLocator;
};

export const FactSource = ({
  workspaceId,
  documentId,
  documentName,
  locator,
}: FactSourceProps) => {
  const openSourceDocument = useOpenSourceDocument(workspaceId);
  return (
    <Button
      className="min-w-0 justify-start"
      size="xs"
      onClick={() => openSourceDocument(documentId, sourceLocatorPage(locator))}
      variant="link"
    >
      <span className="truncate">
        <SourceLocatorLabel documentName={documentName} locator={locator} />
      </span>
    </Button>
  );
};

type EvidenceFactSourceProps = {
  workspaceId: string;
  source: EvidenceFact["sources"][number] | undefined;
};

/** The pinned source chosen alongside the fact's displayed quote. */
export const EvidenceFactSource = ({
  workspaceId,
  source,
}: EvidenceFactSourceProps) => {
  const filesQuery = useQuery(workspaceFilesOptions(workspaceId));
  const filesView = useQueryView(filesQuery);
  useQueryViewError(filesView);
  const files =
    (filesView.type === "items" ? filesView.items : undefined) ?? [];
  if (source === undefined) {
    return null;
  }
  const documentName = evidenceSourceDocumentName(source, files);
  if (documentName === null) {
    return null;
  }
  return (
    <FactSource
      documentId={source.sourceEntityId}
      documentName={documentName}
      locator={source.locator}
      workspaceId={workspaceId}
    />
  );
};
