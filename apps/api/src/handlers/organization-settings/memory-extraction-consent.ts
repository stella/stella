type ResolveMemoryExtractionEnabledAtOptions = {
  currentEnabled: boolean;
  nextEnabled: boolean;
  now: Date;
};

export const resolveMemoryExtractionEnabledAt = ({
  currentEnabled,
  nextEnabled,
  now,
}: ResolveMemoryExtractionEnabledAtOptions): Date | null | undefined => {
  if (!nextEnabled) {
    return null;
  }
  if (!currentEnabled) {
    return now;
  }
  return undefined;
};
