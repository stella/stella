import { PDFPageOrganizer } from "@/components/pdf/page-organizer";
import { useCreateFileEntities } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-create-file-entities";

type PDFPageOrganizerContainerProps = {
  canCreateDocument: boolean;
  canSaveVersion: boolean;
  entityId: string;
  fieldId: string;
  fileName: string;
  onClose: () => void;
  workspaceId: string;
};

export const PDFPageOrganizerContainer = ({
  canCreateDocument,
  canSaveVersion,
  entityId,
  fieldId,
  fileName,
  onClose,
  workspaceId,
}: PDFPageOrganizerContainerProps) => {
  const [isCreatingDocuments, createFileEntities] =
    useCreateFileEntities(workspaceId);

  return (
    <PDFPageOrganizer
      canSaveVersion={canSaveVersion}
      entityId={entityId}
      fieldId={fieldId}
      fileName={fileName}
      isCreatingDocuments={isCreatingDocuments}
      onClose={onClose}
      onCreateDocuments={
        canCreateDocument
          ? (files) => {
              createFileEntities({ files });
            }
          : undefined
      }
      workspaceId={workspaceId}
    />
  );
};
