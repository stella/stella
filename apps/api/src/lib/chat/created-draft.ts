const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export type SavedGeneratedDocumentDraft = {
  entityId: string;
  entityRef: string;
  fieldId: string;
  fileName: string;
  href: string;
  matterRef: string;
  mention: string;
  success: true;
  workspaceId: string;
};

export type GeneratedDocumentDraftState =
  | { status: "invalid" }
  | { output: SavedGeneratedDocumentDraft; status: "saved" }
  | {
      locator: { partIndex: number; persistenceVersion: 2 | 3 };
      status: "ready";
    };

const toSavedGeneratedDocumentDraft = (
  value: unknown,
): SavedGeneratedDocumentDraft | null => {
  if (
    !isRecord(value) ||
    value["success"] !== true ||
    typeof value["entityId"] !== "string" ||
    typeof value["entityRef"] !== "string" ||
    typeof value["fieldId"] !== "string" ||
    typeof value["fileName"] !== "string" ||
    typeof value["href"] !== "string" ||
    typeof value["matterRef"] !== "string" ||
    typeof value["mention"] !== "string" ||
    typeof value["workspaceId"] !== "string"
  ) {
    return null;
  }
  return {
    entityId: value["entityId"],
    entityRef: value["entityRef"],
    fieldId: value["fieldId"],
    fileName: value["fileName"],
    href: value["href"],
    matterRef: value["matterRef"],
    mention: value["mention"],
    success: true,
    workspaceId: value["workspaceId"],
  };
};

export const getGeneratedDocumentDraftState = ({
  persistedContent,
  fileName,
  toolCallId,
}: {
  persistedContent: unknown;
  fileName: string;
  toolCallId: string;
}): GeneratedDocumentDraftState => {
  if (
    !isRecord(persistedContent) ||
    (persistedContent["version"] !== 2 && persistedContent["version"] !== 3) ||
    !Array.isArray(persistedContent["data"])
  ) {
    return { status: "invalid" };
  }
  const persistenceVersion = persistedContent["version"];
  for (const [partIndex, part] of persistedContent["data"].entries()) {
    if (
      !isRecord(part) ||
      part["type"] !== "tool-call" ||
      part["name"] !== "create-document" ||
      part["id"] !== toolCallId ||
      part["state"] !== "complete"
    ) {
      continue;
    }
    const storedOutput = part["output"];
    const output =
      persistenceVersion === 3 && isRecord(storedOutput)
        ? storedOutput["value"]
        : storedOutput;
    const saved = toSavedGeneratedDocumentDraft(output);
    if (saved !== null) {
      return { output: saved, status: "saved" };
    }
    if (
      isRecord(output) &&
      output["success"] === true &&
      output["destination"] === "draft" &&
      output["fileName"] === fileName
    ) {
      return {
        locator: { partIndex, persistenceVersion },
        status: "ready",
      };
    }
  }
  return { status: "invalid" };
};

export const isReadyGeneratedDocumentDraft = ({
  persistedContent,
  fileName,
  toolCallId,
}: {
  persistedContent: unknown;
  fileName: string;
  toolCallId: string;
}): boolean =>
  getGeneratedDocumentDraftState({
    persistedContent,
    fileName,
    toolCallId,
  }).status === "ready";
