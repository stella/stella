import { panic } from "better-result";

import type { ExpansionDictionaryProbe } from "@/api/lib/legal-search/expansion";
import type { MorphologyLanguage } from "@/api/lib/legal-search/morphology/stem";
import type { QueryExpansionMode } from "@/api/lib/legal-search/query-expansion-mode";
import {
  DATA_INVARIANT_ID,
  type DataInvariant,
  type DataInvariantFinding,
  judgeDataInvariant,
} from "@/api/lib/observability/data-invariants/invariant";

type DictionaryReason = "unavailable" | "stale" | "empty";

type QueryExpansionDictionariesOptions = {
  mode: QueryExpansionMode;
  languages: readonly MorphologyLanguage[];
  probe: (language: MorphologyLanguage) => Promise<ExpansionDictionaryProbe>;
};

const dictionaryFinding = (
  language: MorphologyLanguage,
  probe: ExpansionDictionaryProbe,
): DataInvariantFinding<DictionaryReason> | null => {
  switch (probe.status) {
    case "unavailable":
      return {
        target: language,
        reason: "unavailable",
        observed: null,
        expected: "a loadable dictionary",
      };
    case "stale":
      return {
        target: language,
        reason: "stale",
        observed: probe.entries,
        expected: "the published dictionary readable",
      };
    case "loaded":
      return probe.entries > 0
        ? null
        : {
            target: language,
            reason: "empty",
            observed: 0,
            expected: ">= 1 entry",
          };
    default:
      probe satisfies never;
      return panic(`Unhandled dictionary probe: ${String(probe)}`);
  }
};

/**
 * While expansion is `shadow` or `on`, every published language's dictionary
 * loads and holds entries. In shadow mode the comparison against a missing
 * dictionary is recorded as `no_dictionary` for every query, which is a
 * well-formed event stream that measures nothing; in `on` it silently serves
 * unexpanded queries.
 */
export const queryExpansionDictionariesInvariant = ({
  mode,
  languages,
  probe,
}: QueryExpansionDictionariesOptions): DataInvariant<
  DictionaryReason,
  typeof DATA_INVARIANT_ID.queryExpansionDictionaries
> => ({
  id: DATA_INVARIANT_ID.queryExpansionDictionaries,
  owner: "legal-search",
  severity: "warning",
  check: async ({ signal }) => {
    if (mode === "off") {
      return { status: "skipped", reason: "feature-off" };
    }
    const findings: DataInvariantFinding<DictionaryReason>[] = [];
    for (const language of languages) {
      signal.throwIfAborted();
      const finding = dictionaryFinding(language, await probe(language));
      if (finding !== null) {
        findings.push(finding);
      }
    }
    return judgeDataInvariant(languages.length, findings);
  },
});
