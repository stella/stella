import type {
  legalListFactDetails,
  legalListItemSources,
} from "@/api/db/schema";

export const projectListFactDetails = <
  T extends Pick<typeof legalListFactDetails.$inferSelect, "scoring">,
>(
  details: T | null,
  accessStatus: "available" | "unavailable",
) => {
  if (details === null) {
    return null;
  }
  const { scoring, ...common } = details;
  return { ...common, ...(accessStatus === "available" ? { scoring } : {}) };
};

export const projectListItemSource = <
  T extends Pick<
    typeof legalListItemSources.$inferSelect,
    "verificationStatus" | "verifiedBy" | "verifiedAt"
  >,
>(
  source: T,
  accessStatus: "available" | "unavailable",
) => {
  const { verificationStatus, verifiedBy, verifiedAt, ...common } = source;
  return {
    ...common,
    ...(accessStatus === "available"
      ? { verificationStatus, verifiedBy, verifiedAt }
      : {}),
  };
};
