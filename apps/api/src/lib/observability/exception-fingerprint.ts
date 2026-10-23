import { type ExceptionScope, exceptionScopeIdentity } from "@stll/errors";
import {
  exceptionCauseChainIdentity,
  exceptionCauseFieldsIdentity,
} from "@stll/errors/exception-cause-chain";
import type { StableExceptionKey } from "@stll/errors/exception-context";

import { identityFields } from "@/api/lib/observability/failure";
import type { FailureEvidence } from "@/api/lib/observability/failure-evidence";

export type { StableExceptionKey } from "@stll/errors/exception-context";

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
    exceptionCauseFieldsIdentity(
      evidence.nodes.map((node) => ({
        type: node.tag,
        fields: node.discriminators,
      })),
    ),
  ]);
};
