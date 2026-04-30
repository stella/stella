import { getCaseLawIngestionMetadata } from "@/api/handlers/case-law/metadata";

type RefreshPolicyInput = {
  existingMetadata: Record<string, unknown> | null;
  existingSourceHash: string | null;
  incomingMetadata: Record<string, unknown>;
  incomingRawHash: string;
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
  existingSourceHash,
  incomingMetadata,
  incomingRawHash,
}: RefreshPolicyInput): boolean => {
  if (existingSourceHash === null) {
    return false;
  }

  if (existingSourceHash !== incomingRawHash) {
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
