import { corpusSearchGroupToken } from "@/api/lib/legal-search/corpus-search-cursor";
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
 * The Work the page cursor names is left out entirely; the displayed version
 * may differ from the version that gave the Work its score. So is every Work an earlier scan window showed: when a capped scan
 * moves on to the next window of the engine's order, the cursor carries the
 * tokens of the Works the finished window held (`corpusSearchGroupToken`),
 * because a deeper version of one of them would otherwise bring it back.
 */

/** How a Work's hit is shown. */
export type LegislationWorkRepresentative = {
  id: string;
  /** In force today, and the current version of its Work. */
  isCurrent: boolean;
};

/**
 * The id a Work's hit shows: its current version when it has one, else the
 * version it matched by. The one rule both search paths display by.
 */
export const shownLegislationVersionId = (
  matchedId: string,
  representative: LegislationWorkRepresentative | undefined,
): string =>
  representative?.isCurrent === true ? representative.id : matchedId;

/**
 * The named Works placed first: those in force today when the query names
 * any, else every named Work that has a version to show. Order is kept.
 */
export const pinnedLegislationWorks = (
  namedWorks: readonly string[],
  representatives: ReadonlyMap<string, LegislationWorkRepresentative>,
): string[] => {
  const shown = namedWorks.filter((work) => representatives.has(work));
  const inForce = shown.filter(
    (work) => representatives.get(work)?.isCurrent === true,
  );
  return inForce.length > 0 ? inForce : shown;
};

/**
 * Score of the named Work at `index` of `count`: above `floor`, which is
 * above every score the ranking can give a scanned hit, first highest.
 */
export const pinnedLegislationWorkScore = (
  floor: number,
  index: number,
  count: number,
): number => floor + (count - index);

type CollapseLegislationHitsByWorkOptions = {
  /** Blended version hits carrying their hydrated Work key, any order. */
  ranked: readonly (RankedHit & { work: string })[];
  /** Per Work key, the version its present-day reads show. */
  representatives: ReadonlyMap<string, LegislationWorkRepresentative>;
  /** Works placed first, best first (`pinnedLegislationWorks`). */
  namedWorks: readonly string[];
  /** Above every score a scanned hit can reach. */
  namedScoreFloor: number;
  /** The Work the page cursor names, left out. */
  excludedWork: string | null;
  /** Tokens of Works an earlier scan window showed, left out. */
  excludedWorkTokens?: ReadonlySet<string> | undefined;
};

type CollapsedLegislationHits = {
  ranked: RankedHit[];
  /** The Work key of each emitted hit id. */
  workOfHit: Map<string, string>;
  /** Tokens of emitted Works and the cursor Work, for a window move. */
  workTokens: string[];
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
  representatives,
  namedWorks,
  namedScoreFloor,
  excludedWork,
  excludedWorkTokens,
}: CollapseLegislationHitsByWorkOptions): CollapsedLegislationHits => {
  const isExcluded = (work: string): boolean =>
    work === excludedWork ||
    (excludedWorkTokens?.has(corpusSearchGroupToken(work)) ?? false);

  const bestByWork = new Map<string, RankedHit>();
  for (const { work, ...hit } of ranked) {
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

  // The pin order and scores are fixed by the query, so a named Work already
  // shown keeps its slot out of the list rather than moving the others.
  const named = namedWorks.filter((work) => representatives.has(work));
  const namedSet = new Set(named);
  for (const [index, work] of named.entries()) {
    const representative = representatives.get(work);
    if (representative === undefined || isExcluded(work)) {
      continue;
    }
    const best = bestByWork.get(work);
    emit(work, {
      id: representative.id,
      score: pinnedLegislationWorkScore(namedScoreFloor, index, named.length),
      lexicalScore: best?.lexicalScore ?? 0,
      citationAuthority: best?.citationAuthority ?? 0,
    });
  }

  for (const [work, best] of bestByWork) {
    if (isExcluded(work) || namedSet.has(work)) {
      continue;
    }
    emit(work, {
      ...best,
      id: shownLegislationVersionId(best.id, representatives.get(work)),
    });
  }

  out.sort(byScoreThenIdDesc);
  return {
    ranked: out,
    workOfHit,
    workTokens: [
      ...new Set([
        ...workOfHit.values(),
        ...(excludedWork === null ? [] : [excludedWork]),
      ]),
    ].map((work) => corpusSearchGroupToken(work)),
  };
};
