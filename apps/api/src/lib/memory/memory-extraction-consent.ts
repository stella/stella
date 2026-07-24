export const isMemoryExtractionConsentValid = (
  settings: { enabled: boolean; enabledAt: Date | null } | undefined,
  compactionCreatedAt: Date,
): boolean =>
  settings?.enabled === true &&
  settings.enabledAt !== null &&
  settings.enabledAt.getTime() <= compactionCreatedAt.getTime();
