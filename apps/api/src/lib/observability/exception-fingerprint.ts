import { exceptionScopeIdentity, type ExceptionScope } from "@stll/errors";
import { exceptionCauseChainIdentity } from "@stll/errors/exception-cause-chain";

import { identityFields } from "@/api/lib/observability/failure";
import type { FailureEvidence } from "@/api/lib/observability/failure-evidence";

/** A source-owned function/path label, never an entity ID or stack symbol. */
export type StableExceptionKey = `${string}.${string}`;

/**
 * Grouping and suppression share one identity. The explicit owner survives
 * source moves and also identifies failures without a usable stack. Locations
 * remain diagnostic properties only; engine-inferred symbols can contain data.
 */
type ExceptionFingerprintOptions = {
  fingerprintKey: StableExceptionKey;
  scope: ExceptionScope;
  inheritedScopes?: readonly ExceptionScope[];
};

export const exceptionFingerprint = (
  evidence: FailureEvidence,
  { fingerprintKey, scope, inheritedScopes = [] }: ExceptionFingerprintOptions,
): string => {
  const fields = identityFields(evidence);
  return JSON.stringify([
    exceptionCauseChainIdentity({
      root: 0,
      readNode: (index) => ({
        type: evidence.nodes.at(index)?.tag ?? "UnknownError",
        cause: index + 1 < evidence.nodes.length ? index + 1 : undefined,
      }),
    }),
    fingerprintKey,
    [
      ...new Set([scope, ...inheritedScopes].map(exceptionScopeIdentity)),
    ].toSorted(),
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
