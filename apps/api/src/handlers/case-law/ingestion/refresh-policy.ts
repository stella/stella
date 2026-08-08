import { getCaseLawIngestionMetadata } from "@/api/handlers/case-law/metadata";

type RefreshPolicyInput = {
  existingMetadata: Record<string, unknown> | null;
  existingSourceRawContentType?: string | null;
  existingSourceHash: string | null;
  incomingMetadata: Record<string, unknown>;
  incomingRawHash: string;
  incomingSourceRawContentType?: string;
  incomingUsesSourceRawBytes?: boolean;
};

const shouldUpgradeFromDumpToDetail = ({
  existingMetadata,
  incomingMetadata,
}: Omit<
  RefreshPolicyInput,
  "existingSourceHash" | "incomingRawHash"
>): boolean => {
  const existingMarker = getCaseLawIngestionMetadata(existingMetadata);
  const incomingMarker = getCaseLawIngestionMetadata(incomingMetadata);

  return (
    existingMarker?.dumpHash !== undefined &&
    existingMarker.dumpHash === incomingMarker?.dumpHash &&
    existingMarker.sourceTier === "dump" &&
    incomingMarker.sourceTier === "detail"
  );
};

const shouldSkipDetailDowngrade = ({
  existingMetadata,
  incomingMetadata,
}: Omit<
  RefreshPolicyInput,
  "existingSourceHash" | "incomingRawHash"
>): boolean => {
  const existingMarker = getCaseLawIngestionMetadata(existingMetadata);
  const incomingMarker = getCaseLawIngestionMetadata(incomingMetadata);

  return (
    existingMarker?.dumpHash !== undefined &&
    existingMarker.dumpHash === incomingMarker?.dumpHash &&
    existingMarker.sourceTier === "detail" &&
    incomingMarker.sourceTier === "dump"
  );
};

export const shouldSkipRefresh = ({
  existingMetadata,
  existingSourceRawContentType,
  existingSourceHash,
  incomingMetadata,
  incomingRawHash,
  incomingSourceRawContentType,
  incomingUsesSourceRawBytes,
}: RefreshPolicyInput): boolean => {
  if (existingSourceHash === null) {
    return false;
  }

  if (existingSourceHash !== incomingRawHash) {
    return false;
  }

  if (
    incomingUsesSourceRawBytes === true &&
    existingSourceRawContentType !== incomingSourceRawContentType
  ) {
    return false;
  }

  if (shouldSkipDetailDowngrade({ existingMetadata, incomingMetadata })) {
    return true;
  }

  return !shouldUpgradeFromDumpToDetail({
    existingMetadata,
    incomingMetadata,
  });
};
