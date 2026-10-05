import type { ProvisionPlacementFailureReason } from "@stll/api-contract/provision-placement";

import type { ResolvedCitedStatute } from "@/features/case-law/queries/provisions";
import {
  pickVersionAt,
  versionCoversDate,
} from "@/features/case-law/statute-version";

type ProvisionDocumentPlacement =
  | { status: "placed"; document: ResolvedCitedStatute }
  | { status: "pending" | "unplaced"; reason: ProvisionPlacementFailureReason };

type ProvisionDocumentPlacementOptions = {
  row: { workEli: string | null; versionValidFrom: string | null };
  statute: ResolvedCitedStatute | undefined;
  versions: readonly ResolvedCitedStatute[];
  statuteState: "loading" | "settled";
  versionsState: "loading" | "settled";
};

export const resolveProvisionDocument = ({
  row,
  statute,
  versions,
  statuteState,
  versionsState,
}: ProvisionDocumentPlacementOptions): ProvisionDocumentPlacement => {
  if (row.workEli === null) {
    return { status: "unplaced", reason: "work-unresolved" };
  }
  if (statute === undefined) {
    return {
      status: statuteState === "loading" ? "pending" : "unplaced",
      reason: "statute-not-loaded",
    };
  }
  if (
    row.versionValidFrom === null ||
    versionCoversDate(statute, row.versionValidFrom)
  ) {
    return { status: "placed", document: statute };
  }
  const document = pickVersionAt(versions, row.versionValidFrom);
  if (document !== null) {
    return { status: "placed", document };
  }
  return {
    status: versionsState === "loading" ? "pending" : "unplaced",
    reason: "no-version-in-force",
  };
};
