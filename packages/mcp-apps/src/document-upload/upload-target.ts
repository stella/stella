export type UploadTarget = { entityId: string; workspaceId: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseTarget = (value: unknown): UploadTarget | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { entityId, workspaceId } = value;
  if (typeof entityId !== "string" || typeof workspaceId !== "string") {
    return undefined;
  }
  return { entityId, workspaceId };
};

type UploadTargetControllerOptions = {
  formatLabel: (documentId: string) => string;
  setLabel: (label: string) => void;
  setTarget: (target: UploadTarget | null) => void;
};

export const createUploadTargetController = ({
  formatLabel,
  setLabel,
  setTarget,
}: UploadTargetControllerOptions) => {
  let activeEntityId: string | undefined;
  let target: UploadTarget | undefined;
  return {
    handleToolInput(entityId: unknown): void {
      target = undefined;
      activeEntityId = typeof entityId === "string" ? entityId : undefined;
      setTarget(null);
      if (activeEntityId !== undefined) {
        setLabel(formatLabel(activeEntityId));
      }
    },
    handleToolResult(value: unknown): void {
      const next = parseTarget(value);
      if (next === undefined || next.entityId !== activeEntityId) {
        return;
      }
      target = next;
      setLabel(formatLabel(next.entityId));
      setTarget(next);
    },
    snapshot(): UploadTarget | undefined {
      return target === undefined ? undefined : { ...target };
    },
  };
};
