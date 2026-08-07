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
      setUploadEnabled(false);
      if (typeof entityId === "string") {
        setLabel(`Document ${entityId}`);
      }
    },
    handleToolResult(value: unknown): void {
      const next = parseTarget(value);
      if (next === undefined) {
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
