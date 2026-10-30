import { panic } from "better-result";

import type { CaseLawCanary } from "@/api/lib/observability/data-invariants/config-schema";
import {
  DATA_INVARIANT_ID,
  type DataInvariant,
  type DataInvariantFinding,
  judgeDataInvariant,
} from "@/api/lib/observability/data-invariants/invariant";

/** What one canary search answered, reduced to what the invariant judges. */
export type CaseLawCanaryAnswer =
  | { type: "hits"; count: number }
  | { type: "index-unavailable" }
  | { type: "unknown-country" }
  | { type: "refused" };

type CanaryReason = "no-results" | Exclude<CaseLawCanaryAnswer["type"], "hits">;

type CaseLawSearchCanariesOptions = {
  canaries: readonly CaseLawCanary[];
  search: (canary: CaseLawCanary) => Promise<CaseLawCanaryAnswer>;
};

const canaryFinding = (
  target: string,
  answer: CaseLawCanaryAnswer,
): DataInvariantFinding<CanaryReason> | null => {
  switch (answer.type) {
    case "hits":
      return answer.count > 0
        ? null
        : { target, reason: "no-results", observed: 0, expected: ">= 1 hit" };
    case "index-unavailable":
    case "unknown-country":
    case "refused":
      return { target, reason: answer.type, observed: null, expected: "hits" };
    default:
      answer satisfies never;
      return panic(`Unhandled canary answer: ${String(answer)}`);
  }
};

/**
 * Every configured canary query returns at least one decision through the
 * public search path. Canaries are queries the deployment's corpus is known
 * to answer, so an empty page means search, the index or the corpus is
 * answering normally with nothing in it.
 *
 * Findings name the canary by country and position, never by its text.
 */
export const caseLawSearchCanariesInvariant = ({
  canaries,
  search,
}: CaseLawSearchCanariesOptions): DataInvariant<
  CanaryReason,
  typeof DATA_INVARIANT_ID.caseLawSearchCanaries
> => ({
  id: DATA_INVARIANT_ID.caseLawSearchCanaries,
  owner: "legal-search",
  severity: "critical",
  check: async ({ signal }) => {
    if (canaries.length === 0) {
      return { status: "skipped", reason: "not-configured" };
    }
    const findings: DataInvariantFinding<CanaryReason>[] = [];
    // One at a time: canaries are a probe, not load.
    for (const [index, canary] of canaries.entries()) {
      signal.throwIfAborted();
      const finding = canaryFinding(
        `${canary.country}#${index}`,
        await search(canary),
      );
      if (finding !== null) {
        findings.push(finding);
      }
    }
    return judgeDataInvariant(canaries.length, findings);
  },
});
