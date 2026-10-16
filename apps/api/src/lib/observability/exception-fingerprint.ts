import { identityFields } from "@/api/lib/observability/failure";
import type { FailureEvidence } from "@/api/lib/observability/failure-evidence";

/** A source-owned function/path label, never an entity ID or stack symbol. */
export type StableExceptionKey = `${string}.${string}`;

/**
 * Grouping and suppression share one identity. The explicit owner survives
 * source moves and also identifies failures without a usable stack. Locations
 * remain diagnostic properties only; engine-inferred symbols can contain data.
 */
export const exceptionFingerprint = (
  evidence: FailureEvidence,
  key: StableExceptionKey,
): string => {
  const fields = identityFields(evidence);
  return JSON.stringify([
    evidence.nodes.at(0)?.tag ?? "UnknownError",
    key,
    fields["error.code"] ?? "",
    fields["error.cause.pg_code"] ?? "",
    evidence.nodes
      .flatMap((node) =>
        Object.entries(node.discriminators ?? {}).map(([field, value]) =>
          JSON.stringify([node.tag, field, value]),
        ),
      )
      .toSorted(),
  ]);
};
