/** The ingestion and refresh paths project the same publisher fields. */
export const nssPublisherColumns = (metadata: Record<string, unknown>) => {
  const read = (key: string) => {
    const value = metadata[key];
    return typeof value === "string" ? value : null;
  };
  return {
    nssReporterNumber: read("nssReporterNumber"),
    nssReporterYear: read("nssReporterYear"),
    nssReporterIssue: read("nssReporterIssue"),
    nssKeywordSearchCode: read("nssKeywordSearchCode"),
    nssRegistryCaseNumber: read("nssRegistryCaseNumber"),
    nssRegistryReferral: read("nssRegistryReferral"),
    nssRegistryReferralDate: read("nssRegistryReferralDate"),
    nssRegistryAgainstCases: read("nssRegistryAgainstCases"),
    nssRegistryStatus: read("nssRegistryStatus"),
    nssRegistryAnnotation: read("nssRegistryAnnotation"),
  };
};
