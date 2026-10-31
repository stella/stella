import { toSafeId } from "@/api/lib/branded-types";
import { CORPUS_INDEX_MANIFESTS } from "@/api/lib/legal-search/corpus-index-manifest";
import {
  corpusAppliedProjection,
  type CorpusProjectionRevision,
} from "@/api/lib/legal-search/corpus-index-revision-clause";

const assigned = new Map<string, CorpusProjectionRevision>();

/** One stable applied revision per id, as a ranker's rehydration reports it. */
export const testRevisionOf = (id: string): CorpusProjectionRevision => {
  const existing = assigned.get(id);
  if (existing !== undefined) {
    return existing;
  }
  const revision = toSafeId<"corpusIndexProjectionIntent">(Bun.randomUUIDv7());
  assigned.set(id, revision);
  return revision;
};

/** The `revisionById` a ranker returns for these candidates. */
export const testRevisionsFor = (
  candidates: readonly { id: string }[],
): ReadonlyMap<string, CorpusProjectionRevision> =>
  new Map(candidates.map(({ id }) => [id, testRevisionOf(id)]));

/** The applied manifest and revision a ranker reports for these candidates. */
export const testAppliedProjectionsFor = (
  candidates: readonly { id: string }[],
) =>
  new Map(
    candidates.map(({ id }) => [
      id,
      corpusAppliedProjection(
        CORPUS_INDEX_MANIFESTS.case_law_v9,
        testRevisionOf(id),
      ),
    ]),
  );
