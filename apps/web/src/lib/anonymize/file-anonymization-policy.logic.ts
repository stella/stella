import type { ChatAnonPair } from "@stll/anonymize-chat";
import { normalizeForExclusion } from "@stll/anonymize-chat/normalization";

type CollectFileAnonymizationTermsOptions = {
  detected: readonly Pick<ChatAnonPair, "original" | "label">[];
  vocabulary: readonly {
    enabled: boolean;
    canonical: string;
    label: string;
    variants: readonly string[];
  }[];
  excludedCanonicals: readonly string[];
};

export const collectFileAnonymizationTerms = ({
  detected,
  vocabulary,
  excludedCanonicals,
}: CollectFileAnonymizationTermsOptions) => {
  const excluded = new Set(excludedCanonicals.map(normalizeForExclusion));
  const terms = new Map<string, { text: string; label: string }>();
  for (const { original, label } of detected) {
    const key = normalizeForExclusion(original);
    if (!excluded.has(key)) {
      terms.set(key, { text: original, label });
    }
  }
  for (const entry of vocabulary) {
    if (!entry.enabled) {
      continue;
    }
    for (const value of [entry.canonical, ...entry.variants]) {
      const key = normalizeForExclusion(value);
      if (!excluded.has(key)) {
        terms.set(key, { text: value, label: entry.label });
      }
    }
  }
  return [...terms.values()];
};
