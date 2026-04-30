import { isRecord } from "@/api/lib/type-guards";

type CaseLawSourceTier = "dump" | "detail";

export type CaseLawIngestionMetadata = {
  dumpHash?: string;
  sourceTier?: CaseLawSourceTier;
};

const isSourceTier = (value: unknown): value is CaseLawSourceTier =>
  value === "dump" || value === "detail";

export const getCaseLawIngestionMetadata = (
  metadata: Record<string, unknown> | null,
): CaseLawIngestionMetadata | null => {
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
    ...(dumpHash ? { dumpHash } : {}),
    ...(sourceTier ? { sourceTier } : {}),
  };
};
