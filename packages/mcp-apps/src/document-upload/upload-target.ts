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

export const createUploadTargetController = ({
  hasSelectedFile,
  setLabel,
  setUploadEnabled,
}: {
  hasSelectedFile: () => boolean;
  setLabel: (label: string) => void;
  setUploadEnabled: (enabled: boolean) => void;
}) => {
  let activeEntityId: string | undefined;
  let target: UploadTarget | undefined;
  const refreshUploadEnabled = (): void => {
    setUploadEnabled(target !== undefined && hasSelectedFile());
  };

  return {
    handleFileChange(): void {
      refreshUploadEnabled();
    },
    handleToolInput(entityId: unknown): void {
      target = undefined;
      activeEntityId = typeof entityId === "string" ? entityId : undefined;
      setUploadEnabled(false);
      if (activeEntityId !== undefined) {
        setLabel(`Document ${activeEntityId}`);
      }
    },
    handleToolResult(value: unknown): void {
      const next = parseTarget(value);
      if (next === undefined || next.entityId !== activeEntityId) {
        return;
      }
      target = next;
      setLabel(`Document ${next.entityId}`);
      refreshUploadEnabled();
    },
    snapshot(): UploadTarget | undefined {
      return target === undefined ? undefined : { ...target };
    },
  };
};
