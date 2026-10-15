import type { SampleFact } from "@/features/avt/sample-case.data";

type ExistingItem = { id: string; name: string; factDetails: object | null };

/**
 * Whether a load left nothing out. Only then does the view switch to the
 * sample list; until then it keeps offering the load, which completes it.
 */
export const isSampleCaseComplete = (load: {
  factsIncomplete: boolean;
  documentMissing: boolean;
}): boolean => !load.factsIncomplete && !load.documentMissing;

/**
 * What loading the sample case still has to write, matched by statement:
 * facts the list lacks are created, and facts whose item exists without any
 * detail (an earlier run stopped between the two writes) get their detail.
 */
export const sampleFactWrites = (
  facts: readonly SampleFact[],
  items: readonly ExistingItem[],
): {
  create: SampleFact[];
  completeDetails: { fact: SampleFact; itemEntityId: string }[];
} => {
  const byName = new Map(items.map((item) => [item.name, item]));
  const create: SampleFact[] = [];
  const completeDetails: { fact: SampleFact; itemEntityId: string }[] = [];
  for (const fact of facts) {
    const item = byName.get(fact.statement);
    if (item === undefined) {
      create.push(fact);
    } else if (item.factDetails === null) {
      completeDetails.push({ fact, itemEntityId: item.id });
    }
  }
  return { create, completeDetails };
};
