export type CanonicalDocumentDestination = {
  entityId: string;
  fieldId: string;
};

type CurrentEntityField = {
  content: { type: string };
  id: string;
};

type ResolveCanonicalDocumentDestinationOptions = {
  entityId: unknown;
  fieldId: unknown;
  loadCurrentFields: (args: {
    entityId: string;
    workspaceId: string;
  }) => Promise<readonly CurrentEntityField[]>;
  workspaceId: string;
};

/**
 * Resolve an authorized canonical document destination at the client/API
 * boundary. A complete pair stays request-free. If an independently deployed
 * API omits the additive field id, the existing entity read supplies its
 * current file without reviving the deleted entity route.
 */
export const resolveCanonicalDocumentDestination = async ({
  entityId,
  fieldId,
  loadCurrentFields,
  workspaceId,
}: ResolveCanonicalDocumentDestinationOptions): Promise<CanonicalDocumentDestination | null> => {
  if (typeof entityId !== "string") {
    return null;
  }
  if (typeof fieldId === "string") {
    return { entityId, fieldId };
  }

  const currentFields = await loadCurrentFields({ entityId, workspaceId });
  const currentFile = currentFields.find(
    ({ content }) => content.type === "file",
  );
  if (!currentFile) {
    return null;
  }

  return { entityId, fieldId: currentFile.id };
};
