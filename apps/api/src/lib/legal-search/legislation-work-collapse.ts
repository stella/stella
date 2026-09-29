import type { RankedHit } from "@/api/lib/legal-search/rerank";

/**
 * One search hit per legislation Work.
 *
 * The corpus index holds every stored version of an act, so a query an act
 * answers well returns its consolidations one after another. A reader wants
 * the act once, in the version that applies today, so the ranked versions are
 * folded per Work here. This is display only: which versions exist, and which
 * one is current, is read from the stored rows and never changed.
 *
 * Each Work is placed at its best-scoring version's score. It is shown as its
 * current version when it has one (`isCurrentVersionOfWork` and in force
 * today), and as that best-scoring version otherwise. A Work the query names
 * is placed above every scored hit, in the order given, shown as its current
 * version, or its default version when nothing of it applies today.
 *
 * Page stability: the scan behind a page replays the same window of the
 * engine's order on every request and ranks it again, so a Work's hit must
 * come out with the same `(score, id)` each time.
 * - the score is the maximum over the Work's scanned versions. A version the
 *   scan reaches later cannot raise it past a page already emitted: that is
 *   the scan's own early-stop bound, which holds for every candidate;
 * - the id is the current version's, which the stored rows decide rather
 *   than the scan, or else the best version's, which only an out-scoring
 *   version could change, and none can once the Work is emitted;
 * - a named Work's score depends on the query alone.
 * The Work the page cursor names is left out entirely, because the scan skips
 * the cursor's own document, which can be the version that gave the Work its
 * score.
 */

/** How a Work's hit is shown. */
export type LegislationWorkRepresentative = {
  id: string;
  /** In force today, and the current version of its Work. */
  isCurrent: boolean;
};

type CollapseLegislationHitsByWorkOptions = {
  /** Blended version hits, any order. */
  ranked: readonly RankedHit[];
  /** The Work key of each ranked version; a version with none is dropped. */
  workOf: ReadonlyMap<string, string>;
  /** Per Work key, the version its present-day reads show. */
  representatives: ReadonlyMap<string, LegislationWorkRepresentative>;
  /** Works the query names, best first; each needs a representative. */
  namedWorks: readonly string[];
  /** Above every score a scanned hit can reach. */
  namedScoreFloor: number;
  /** The Work the page cursor names, left out. */
  excludedWork: string | null;
};

type CollapsedLegislationHits = {
  ranked: RankedHit[];
  /** The Work key of each emitted hit id. */
  workOfHit: Map<string, string>;
};

const byScoreThenIdDesc = (a: RankedHit, b: RankedHit): number => {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  if (a.id === b.id) {
    return 0;
  }
  return a.id < b.id ? 1 : -1;
};

export const collapseLegislationHitsByWork = ({
  ranked,
  workOf,
  representatives,
  namedWorks,
  namedScoreFloor,
  excludedWork,
}: CollapseLegislationHitsByWorkOptions): CollapsedLegislationHits => {
  const bestByWork = new Map<string, RankedHit>();
  for (const hit of ranked) {
    const work = workOf.get(hit.id);
    if (work === undefined) {
      continue;
    }
    const best = bestByWork.get(work);
    if (best === undefined || byScoreThenIdDesc(hit, best) < 0) {
      bestByWork.set(work, hit);
    }
  }

  const out: RankedHit[] = [];
  const workOfHit = new Map<string, string>();
  const emit = (work: string, hit: RankedHit) => {
    out.push(hit);
    workOfHit.set(hit.id, work);
  };

  const named = namedWorks.filter(
    (work) => work !== excludedWork && representatives.has(work),
  );
  const namedSet = new Set(named);
  for (const [index, work] of named.entries()) {
    const representative = representatives.get(work);
    if (representative === undefined) {
      continue;
    }
    const best = bestByWork.get(work);
    emit(work, {
      id: representative.id,
      score: namedScoreFloor + (named.length - index),
      lexicalScore: best?.lexicalScore ?? 0,
      citationAuthority: best?.citationAuthority ?? 0,
    });
  }

  for (const [work, best] of bestByWork) {
    if (work === excludedWork || namedSet.has(work)) {
      continue;
    }
    const representative = representatives.get(work);
    emit(
      work,
      representative?.isCurrent === true
        ? { ...best, id: representative.id }
        : best,
    );
  }

  out.sort(byScoreThenIdDesc);
  return { ranked: out, workOfHit };
};
