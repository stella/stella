import type { SampleFact } from "@/features/avt/sample-case.data";

/** The sample facts the list does not hold yet, matched by statement. */
export const missingSampleFacts = (
  facts: readonly SampleFact[],
  items: readonly { name: string }[],
): SampleFact[] => {
  const present = new Set(items.map((item) => item.name));
  return facts.filter((fact) => !present.has(fact.statement));
};
