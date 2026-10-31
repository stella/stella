import { panic } from "better-result";

import type { caseLawDecisions } from "@/api/db/schema";

type NssPublisherColumns = Record<
  Extract<keyof typeof caseLawDecisions.$inferInsert, `nss${string}`>,
  string | null
>;

/** The ingestion and refresh paths project the same publisher fields. */
export const nssPublisherColumns = (metadata: Record<string, unknown>) => {
  const read = (key: string) => {
    const value = metadata[key];
    if (value === undefined || value === null) {
      return null;
    }
    if (typeof value !== "string") {
      return panic(`NSS publisher metadata ${key} must be text`);
    }
    return value;
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
  } satisfies NssPublisherColumns;
};
