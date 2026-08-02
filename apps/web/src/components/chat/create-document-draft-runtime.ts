type CreateDocumentDraftSaver = () => Promise<ArrayBuffer | null>;

const draftSavers = new Map<string, CreateDocumentDraftSaver>();

export const registerCreateDocumentDraftSaver = (
  toolCallId: string,
  saver: CreateDocumentDraftSaver,
): (() => void) => {
  draftSavers.set(toolCallId, saver);
  return () => {
    if (draftSavers.get(toolCallId) === saver) {
      draftSavers.delete(toolCallId);
    }
  };
};

export const saveCreateDocumentDraft = async (
  toolCallId: string,
): Promise<ArrayBuffer | null> =>
  (await draftSavers.get(toolCallId)?.()) ?? null;
