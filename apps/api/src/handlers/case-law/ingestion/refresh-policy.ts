import { isRecord } from "@/api/lib/type-guards";

type SourceTier = "dump" | "detail";

type IngestionMarker = {
  dumpHash?: string;
  sourceTier?: SourceTier;
};

type RefreshPolicyInput = {
  existingMetadata: Record<string, unknown> | null;
  existingSourceHash: string | null;
  incomingMetadata: Record<string, unknown>;
  incomingRawHash: string;
};

const isSourceTier = (value: unknown): value is SourceTier =>
  value === "dump" || value === "detail";

const getIngestionMarker = (
  metadata: Record<string, unknown> | null,
): IngestionMarker | null => {
  if (metadata === null) {
    return null;
  }

  const ingestion = metadata["ingestion"];
  if (!isRecord(ingestion)) {
    return null;
  }

  const dumpHash =
    typeof ingestion["dumpHash"] === "string"
      ? ingestion["dumpHash"]
      : undefined;
  const sourceTier = isSourceTier(ingestion["sourceTier"])
    ? ingestion["sourceTier"]
    : undefined;

  if (!dumpHash && !sourceTier) {
    return null;
  }

  return {
    ...(dumpHash && { dumpHash }),
    ...(sourceTier && { sourceTier }),
  };
};

const shouldUpgradeFromDumpToDetail = ({
  existingMetadata,
  incomingMetadata,
}: Omit<
  RefreshPolicyInput,
  "existingSourceHash" | "incomingRawHash"
>): boolean => {
  const existingMarker = getIngestionMarker(existingMetadata);
  const incomingMarker = getIngestionMarker(incomingMetadata);

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
  const existingMarker = getIngestionMarker(existingMetadata);
  const incomingMarker = getIngestionMarker(incomingMetadata);

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
