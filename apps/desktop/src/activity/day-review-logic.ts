import { panic } from "better-result";

import {
  type DesktopDayEntriesResponse,
  type DesktopMatterResolution,
  type DesktopTimeEntryMatterCandidate,
  isDesktopMatterId,
} from "@stll/api-contract/desktop-time-entries";
import { Temporal } from "@stll/time";

import {
  type AppTotal,
  appTotals,
  documentName,
  MINUTE_MS,
  recordedMinutes,
  type TimedSegment,
  totalDurationMs,
} from "./activity-logic";
import type { ActivityManualAssignment } from "./activity-types";
import {
  evidenceTokens,
  learnedMatter,
  matchingRule,
  matchTokens,
  type MatterLearning,
  type MatterRule,
  type SegmentEvidence,
} from "./matter-learning";

type ActivityRange = { start: string; end: string };
/** How a segment came to its matter, strongest first. */
const MATCH_CONFIDENCES = [
  "manual",
  "strong",
  "rule",
  "likely",
  "unmatched",
] as const;
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number];
/** Signals that only break a tie between matters the evidence names
 * equally; none assigns a matter alone. In order of precedence. */
const TIE_BREAK_SIGNALS = [
  "lastWorkedAt",
  "upcomingDeadline",
  "newlyAssignedAt",
] as const;
/** Why a segment has its matter, in one line. */
export type MatchReason =
  | { type: "assigned" }
  | { type: "session" }
  | { type: "rule"; rule: MatterRule }
  | { type: "reference"; reference: string }
  | { type: "name"; token: string }
  | { type: "learned"; token: string }
  | { type: "none" };
/**
 * What the day's own records (a stella document session, a manual
 * assignment) say about a segment's matter, as the member's own access
 * resolved it: `none` when no record names one, `open` when the member can
 * open it, `unresolved` while no read has answered for it, `unavailable`
 * when the member cannot open it. An unavailable matter is never named.
 */
type RecordedMatter = "none" | "open" | "unresolved" | "unavailable";
export type MatchedSegment = TimedSegment & {
  matter: DesktopTimeEntryMatterCandidate | null;
  confidence: MatchConfidence;
  reason: MatchReason;
  recordedMatter: RecordedMatter;
  evidence: string[];
  drafted: boolean;
};
/** What an app's windows showed and for how long, the longest-used title
 * first. */
export type AppEvidence = {
  identifier: string;
  name: string;
  details: {
    title: string;
    durationMs: number;
    /** The matter that holds most of the title's time; `null` when time no
     * matter claimed holds as much or more. */
    matter: DesktopTimeEntryMatterCandidate | null;
  }[];
};
export type DayReviewGroup = {
  id: string;
  matter: DesktopTimeEntryMatterCandidate | null;
  confidence: MatchConfidence;
  /** The reason of the group's strongest match that holds the most time. */
  reason: MatchReason;
  evidence: AppEvidence[];
  apps: AppTotal[];
  segments: MatchedSegment[];
  ranges: ActivityRange[];
  durationMs: number;
  /** The whole minutes the entry claims. A matter's suggestion rounds its
   * recorded time together with the day's other suggestions, so together
   * they never claim more than was recorded. */
  workedMinutes: number;
  /** Time no matter claimed that sits between two of this matter's own
   * stretches, each run under {@link BRIEF_MS}: offered on the suggestion,
   * never counted in it unasked. */
  slivers: MatchedSegment[];
};

/** A matter recorded for less than this in a day is a brief touch: listed,
 * not suggested. A run of unclaimed time this short between two stretches
 * of one matter is a sliver that matter's suggestion offers. */
export const BRIEF_MS = 2 * MINUTE_MS;

/** What a brief touch claims once the member adds it: the least an entry
 * can hold, unless an entry already holds part of the matter's time. */
const BRIEF_TOUCH_MINUTES = 1;

/** Idle gaps up to this long keep one suggestion's time in one stretch. */
export const SUGGESTION_RUN_GAP_MS = 5 * MINUTE_MS;

type MatchDayOptions = {
  segments: readonly TimedSegment[];
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  /** The day's recorded matters outside the shortlist, resolved by id in
   * the same read. */
  resolved: readonly DesktopMatterResolution[];
  captureDetails: boolean;
  manualAssignments: readonly ActivityManualAssignment[];
  draftedEntries: readonly (ActivityRange & { entryId: string })[];
  /** The member's rules and this computer's learned weights. */
  learning: MatterLearning;
  nowMs: number;
};
const hasPhrase = (haystack: readonly string[], phrase: readonly string[]) =>
  phrase.length > 0 &&
  haystack.some((_, index) =>
    phrase.every((token, offset) => haystack.at(index + offset) === token),
  );
const containsRange = (
  range: { startMs: number; endMs: number },
  segment: TimedSegment,
) => range.startMs <= segment.startMs && range.endMs >= segment.endMs;

const distinctiveTokenIndex = (
  candidates: readonly DesktopTimeEntryMatterCandidate[],
) => {
  const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const index = {
    name: new Map<string, Set<string>>(),
    clientName: new Map<string, Set<string>>(),
  };
  for (const field of ["name", "clientName"] as const) {
    for (const candidate of candidates) {
      for (const token of new Set(matchTokens(candidate[field] ?? ""))) {
        if (Array.from(graphemes.segment(token)).length < 3) {
          continue;
        }
        const owners = index[field].get(token);
        if (owners) {
          owners.add(candidate.id);
        } else {
          index[field].set(token, new Set([candidate.id]));
        }
      }
    }
  }
  return index;
};

/** The one matter among `tied` a server signal singles out, in signal
 * order; `null` when none does. */
const tieBreak = (tied: readonly DesktopTimeEntryMatterCandidate[]) => {
  let pool = tied;
  for (const signal of TIE_BREAK_SIGNALS) {
    const signalled = pool.filter(({ signals }) => signals[signal] !== null);
    if (signalled.length === 1) {
      return signalled.at(0) ?? null;
    }
    if (signalled.length > 1) {
      pool = signalled;
    }
  }
  return null;
};

type LikelyMatch = {
  matter: DesktopTimeEntryMatterCandidate;
  reason: Extract<MatchReason, { type: "reference" | "name" }>;
};
type LikelyMatterOptions = {
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  evidence: readonly string[];
  distinctiveTokens: ReturnType<typeof distinctiveTokenIndex>;
};
const likelyMatter = ({
  candidates,
  evidence,
  distinctiveTokens,
}: LikelyMatterOptions): LikelyMatch | null => {
  const details = evidence.map(matchTokens);
  const references = candidates.filter(
    ({ reference }) =>
      reference !== null &&
      reference.length > 0 &&
      details.some((detail) => hasPhrase(detail, matchTokens(reference))),
  );
  if (references.length > 0) {
    const matter =
      (references.length === 1 ? references.at(0) : tieBreak(references)) ??
      null;
    return matter?.reference
      ? { matter, reason: { type: "reference", reference: matter.reference } }
      : null;
  }
  const hits = new Map<string, string>();
  for (const field of ["name", "clientName"] as const) {
    for (const token of new Set(details.flat())) {
      const owners = distinctiveTokens[field].get(token);
      if (owners?.size !== 1) {
        continue;
      }
      for (const id of owners) {
        if (!hits.has(id)) {
          hits.set(id, token);
        }
      }
    }
  }
  const hit = candidates.filter(({ id }) => hits.has(id));
  const matter = (hit.length === 1 ? hit.at(0) : tieBreak(hit)) ?? null;
  const token = matter === null ? undefined : hits.get(matter.id);
  return matter !== null && token !== undefined
    ? { matter, reason: { type: "name", token } }
    : null;
};

type MatchSegmentOptions = {
  segment: TimedSegment;
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  access: MatterAccess;
  captureDetails: boolean;
  assignment: ActivityManualAssignment | undefined;
  drafted: boolean;
  distinctiveTokens: ReturnType<typeof distinctiveTokenIndex>;
  learning: MatterLearning;
  nowMs: number;
};

/** What rules and learning may read of a segment: titles and paths only
 * with the member's consent to record details. */
export const segmentEvidence = (
  segment: TimedSegment,
  captureDetails: boolean,
): SegmentEvidence => ({
  app: segment.appName,
  title: captureDetails ? segment.windowTitle : null,
  documentPath: captureDetails ? segment.document : null,
});
const matchSegment = ({
  segment,
  candidates,
  access,
  captureDetails,
  assignment,
  drafted,
  distinctiveTokens,
  learning,
  nowMs,
}: MatchSegmentOptions): MatchedSegment => {
  const evidence = captureDetails
    ? [
        ...new Set(
          [
            segment.document ? documentName(segment.document) : null,
            segment.windowTitle,
          ].filter((detail): detail is string => Boolean(detail)),
        ),
      ]
    : [];
  // A record's own matter outranks any heuristic, and an unavailable one is
  // reported as such rather than replaced by a guess.
  const recordedId = assignment?.matterId ?? segment.matterId;
  if (recordedId) {
    const matter = access.open.get(recordedId) ?? null;
    if (matter === null) {
      return {
        ...segment,
        matter,
        confidence: "unmatched",
        reason: { type: "none" },
        recordedMatter: access.unavailable.has(recordedId)
          ? "unavailable"
          : "unresolved",
        evidence,
        drafted,
      };
    }
    return {
      ...segment,
      matter,
      confidence: assignment ? "manual" : "strong",
      reason: assignment ? { type: "assigned" } : { type: "session" },
      recordedMatter: "open",
      evidence,
      drafted,
    };
  }
  const isOpen = (matterId: string) => access.open.has(matterId);
  const seen = segmentEvidence(segment, captureDetails);
  const rule = matchingRule(learning.rules, seen, isOpen);
  const ruleMatter = rule === null ? undefined : access.open.get(rule.matterId);
  if (rule !== null && ruleMatter !== undefined) {
    return {
      ...segment,
      matter: ruleMatter,
      confidence: "rule",
      reason: { type: "rule", rule },
      recordedMatter: "none",
      evidence,
      drafted,
    };
  }
  if (captureDetails) {
    const likely = likelyMatter({ candidates, evidence, distinctiveTokens });
    if (likely) {
      return {
        ...segment,
        matter: likely.matter,
        confidence: "likely",
        reason: likely.reason,
        recordedMatter: "none",
        evidence,
        drafted,
      };
    }
    const learned = learnedMatter({
      tokens: evidenceTokens([seen]),
      learned: learning.learned,
      isOpen,
      nowMs,
    });
    const learnedOpen =
      learned === null ? undefined : access.open.get(learned.matterId);
    if (learned !== null && learnedOpen !== undefined) {
      return {
        ...segment,
        matter: learnedOpen,
        confidence: "likely",
        reason: { type: "learned", token: learned.token },
        recordedMatter: "none",
        evidence,
        drafted,
      };
    }
  }
  return {
    ...segment,
    matter: null,
    confidence: "unmatched",
    reason: { type: "none" },
    recordedMatter: "none",
    evidence,
    drafted,
  };
};
/** The group's strongest confidence, and the reason of that confidence's
 * segment holding the most time. */
const groupMatch = (
  segments: readonly MatchedSegment[],
): { confidence: MatchConfidence; reason: MatchReason } => {
  for (const confidence of MATCH_CONFIDENCES) {
    const [longest] = segments
      .filter((segment) => segment.confidence === confidence)
      .sort(
        (left, right) =>
          right.endMs - right.startMs - (left.endMs - left.startMs) ||
          left.startMs - right.startMs,
      );
    if (longest !== undefined) {
      return { confidence, reason: longest.reason };
    }
  }
  return { confidence: "unmatched", reason: { type: "none" } };
};

// `host: name` from terminals and remote sessions; `page · site` and
// `page - site` from web pages.
const SHARED_CONTEXT = [
  { pattern: /^([^\s:]+): (.+)$/u, context: 1, own: 2 },
  // A site may contain hyphens (`my-site.com`); only a spaced hyphen separates.
  {
    pattern: /^(.+?) (?:·|\||-|–|—) ((?:(?! - )[^·|–—])+)$/u,
    context: 2,
    own: 1,
  },
] as const;

/** Context that several titles share says nothing about any of them, so it
 * is dropped: each title maps to its own part. */
export const cleanSharedContext = (evidence: readonly string[]) => {
  const cleaned = new Map(evidence.map((title) => [title, title]));
  let titles = [...evidence];
  for (const { pattern, context, own } of SHARED_CONTEXT) {
    const counts = new Map<string, number>();
    for (const title of titles) {
      const key = pattern.exec(title)?.at(context);
      if (key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    const strip = (title: string) => {
      const match = pattern.exec(title);
      const key = match?.at(context);
      const rest = match?.at(own);
      return key && rest && (counts.get(key) ?? 0) > 1 ? rest : title;
    };
    for (const [original, current] of cleaned) {
      cleaned.set(original, strip(current));
    }
    titles = [...new Set(titles.map(strip))];
  }
  return cleaned;
};

/** Titles a narrative template names per app before it stops. */
export const EVIDENCE_DETAIL_LIMIT = 3;

const TITLE_SEPARATORS = [" - ", " – ", " \u2014 "] as const;

/** Browsers title a window `page - Browser - Profile`; the app icon already
 * names the browser, so the title keeps only the page. */
export const withoutAppSuffix = (title: string, appName: string) => {
  let cut = title.length;
  for (const separator of TITLE_SEPARATORS) {
    const needle = `${separator}${appName}`;
    for (
      let index = title.indexOf(needle);
      index > 0;
      index = title.indexOf(needle, index + 1)
    ) {
      const rest = title.slice(index + needle.length);
      if (
        rest === "" ||
        TITLE_SEPARATORS.some((next) => rest.startsWith(next))
      ) {
        cut = Math.min(cut, index);
        break;
      }
    }
  }
  return title.slice(0, cut);
};

export const appEvidence = (
  segments: readonly MatchedSegment[],
): AppEvidence[] =>
  appTotals(segments).flatMap(({ identifier, name }) => {
    // A segment counts once per title, however many of its details name it.
    const byTitle = new Map<string, Set<MatchedSegment>>();
    for (const segment of segments) {
      if (segment.appIdentifier !== identifier) {
        continue;
      }
      for (const detail of segment.evidence) {
        const title = withoutAppSuffix(detail, name);
        const titled = byTitle.get(title) ?? new Set();
        titled.add(segment);
        byTitle.set(title, titled);
      }
    }
    const cleaned = cleanSharedContext([...byTitle.keys()]);
    const merged = new Map<string, Set<MatchedSegment>>();
    for (const [title, titled] of byTitle) {
      const own = cleaned.get(title) ?? title;
      merged.set(own, new Set([...(merged.get(own) ?? []), ...titled]));
    }
    const details = [...merged]
      .filter(([title]) => title.toLowerCase() !== name.toLowerCase())
      .map(([title, titled]) => ({
        title,
        durationMs: totalDurationMs([...titled]),
        matter: leadingMatter([...titled]),
      }))
      .sort(
        (left, right) =>
          right.durationMs - left.durationMs ||
          left.title.localeCompare(right.title),
      );
    return details.length > 0 ? [{ identifier, name, details }] : [];
  });

/** How some segments' time splits: the matter holding the most of it, and
 * the time no matter claimed. */
export const matterShare = (segments: readonly MatchedSegment[]) => {
  const totals = new Map<
    string,
    { durationMs: number; matter: DesktopTimeEntryMatterCandidate }
  >();
  let unmatchedMs = 0;
  for (const segment of segments) {
    const durationMs = segment.endMs - segment.startMs;
    if (segment.matter === null) {
      unmatchedMs += durationMs;
      continue;
    }
    const total = totals.get(segment.matter.id);
    totals.set(segment.matter.id, {
      durationMs: (total?.durationMs ?? 0) + durationMs,
      matter: segment.matter,
    });
  }
  const [leading = null] = [...totals.values()].sort(
    (left, right) =>
      right.durationMs - left.durationMs ||
      left.matter.id.localeCompare(right.matter.id),
  );
  return { leading, unmatchedMs };
};

/** The matter holding the most of some segments' time, or `null` when time
 * no matter claimed holds as much or more. */
export const leadingMatter = (
  segments: readonly MatchedSegment[],
): DesktopTimeEntryMatterCandidate | null => {
  const { leading, unmatchedMs } = matterShare(segments);
  return leading !== null && leading.durationMs > unmatchedMs
    ? leading.matter
    : null;
};

/** The matters one read under the member's own access can open, by id, and
 * the ids it answered could not be opened. */
type MatterAccess = {
  open: ReadonlyMap<string, DesktopTimeEntryMatterCandidate>;
  unavailable: ReadonlySet<string>;
};
const matterAccess = (
  candidates: readonly DesktopTimeEntryMatterCandidate[],
  resolved: readonly DesktopMatterResolution[],
): MatterAccess => {
  const open = new Map(candidates.map((matter) => [matter.id, matter]));
  const unavailable = new Set<string>();
  for (const resolution of resolved) {
    switch (resolution.type) {
      case "accessible":
        open.set(resolution.matter.id, resolution.matter);
        break;
      case "inaccessible":
        unavailable.add(resolution.id);
        break;
      default:
        resolution satisfies never;
        panic("Unknown matter access");
    }
  }
  return { open, unavailable };
};

type RecordedMatterIdsOptions = {
  segments: readonly { matterId?: string | null }[];
  manualAssignments: readonly ActivityManualAssignment[];
};
/** Every matter the day's own records name, each once. */
export const recordedMatterIds = ({
  segments,
  manualAssignments,
}: RecordedMatterIdsOptions) => [
  ...new Set([
    ...segments.flatMap(({ matterId }) => (matterId ? [matterId] : [])),
    ...manualAssignments.map(({ matterId }) => matterId),
  ]),
];

type UnresolvedMatterIdsOptions = {
  ids: readonly string[];
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  resolved: readonly DesktopMatterResolution[];
};
/** The recorded ids no read has answered for yet, in a stable order. An id
 * that is not a matter id cannot name one, so it is never asked for. */
export const unresolvedMatterIds = ({
  ids,
  candidates,
  resolved,
}: UnresolvedMatterIdsOptions) => {
  const { open, unavailable } = matterAccess(candidates, resolved);
  return ids
    .filter(
      (id) => !open.has(id) && !unavailable.has(id) && isDesktopMatterId(id),
    )
    .sort();
};

/** Splitting at every review boundary prevents assignments or receipts from
 * claiming time beyond the exact range the user selected. A matter recorded
 * under {@link BRIEF_MS} is listed among the brief touches instead of the
 * groups. */
export const matchDay = ({
  segments,
  candidates,
  resolved,
  captureDetails,
  manualAssignments,
  draftedEntries,
  learning,
  nowMs,
}: MatchDayOptions) => {
  const access = matterAccess(candidates, resolved);
  const orderedCandidates = [...access.open.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
  const distinctiveTokens = distinctiveTokenIndex(orderedCandidates);
  const assignments = manualAssignments.map((range) => ({
    ...range,
    startMs: Temporal.Instant.from(range.start).epochMilliseconds,
    endMs: Temporal.Instant.from(range.end).epochMilliseconds,
  }));
  const drafted = draftedEntries.map((range) => ({
    ...range,
    startMs: Temporal.Instant.from(range.start).epochMilliseconds,
    endMs: Temporal.Instant.from(range.end).epochMilliseconds,
  }));
  const edges = [
    ...new Set(
      [...assignments, ...drafted].flatMap(({ startMs, endMs }) => [
        startMs,
        endMs,
      ]),
    ),
  ].sort((left, right) => left - right);
  let edgeIndex = 0;
  const matchedSegments: MatchedSegment[] = [];
  for (const original of segments) {
    while (
      (edges.at(edgeIndex) ?? Number.POSITIVE_INFINITY) <= original.startMs
    ) {
      edgeIndex++;
    }
    const boundaries = [original.startMs];
    while ((edges.at(edgeIndex) ?? Number.POSITIVE_INFINITY) < original.endMs) {
      const edge = edges.at(edgeIndex);
      if (edge !== undefined) {
        boundaries.push(edge);
      }
      edgeIndex++;
    }
    boundaries.push(original.endMs);
    for (let index = 1; index < boundaries.length; index++) {
      const startMs = boundaries.at(index - 1);
      const endMs = boundaries.at(index);
      if (startMs === undefined || endMs === undefined || endMs <= startMs) {
        continue;
      }
      const segment = { ...original, startMs, endMs };
      let assignment: (typeof assignments)[number] | undefined;
      for (const range of assignments) {
        if (containsRange(range, segment)) {
          assignment = range;
        }
      }
      matchedSegments.push(
        matchSegment({
          segment,
          candidates: orderedCandidates,
          access,
          distinctiveTokens,
          learning,
          nowMs,
          captureDetails,
          assignment,
          drafted: drafted.some((range) => containsRange(range, segment)),
        }),
      );
    }
  }
  const grouped = new Map<string, MatchedSegment[]>();
  for (const segment of matchedSegments) {
    if (segment.drafted) {
      continue;
    }
    const id = segment.matter?.id ?? "unmatched";
    const group = grouped.get(id);
    if (group) {
      group.push(segment);
    } else {
      grouped.set(id, [segment]);
    }
  }
  const groups: Omit<DayReviewGroup, "workedMinutes" | "slivers">[] = [];
  for (const [id, group] of grouped) {
    const first = group.at(0);
    if (!first) {
      continue;
    }
    const durationMs = totalDurationMs(group);
    const evidence = appEvidence(group);
    const { confidence, reason } = groupMatch(group);
    groups.push({
      id,
      matter: first.matter,
      confidence,
      reason,
      evidence,
      apps: appTotals(group),
      segments: group,
      ranges: segmentRanges(group),
      durationMs,
    });
  }
  // A member's own assignment is never a brief touch, however short.
  const briefTouches = groups.filter(
    (group) =>
      group.matter !== null &&
      group.durationMs < BRIEF_MS &&
      group.confidence !== "manual",
  );
  const suggested = groups.filter(
    (group) => group.matter !== null && !briefTouches.includes(group),
  );
  const days = dayTimes(matchedSegments);
  const workedMinutes = dayMinutes(days);
  const slivers = sliversByMatter(matchedSegments);
  const offeredSlivers = (id: string) => {
    const offered = slivers.get(id) ?? [];
    return offered.length > 0 && keepsOtherShares(days, id, offered)
      ? offered
      : [];
  };
  const unmatched = groups
    .filter((group) => group.matter === null)
    .map((group) => ({
      ...group,
      workedMinutes: Math.floor(group.durationMs / MINUTE_MS),
      slivers: [],
    }));
  return {
    /** Every matter this read can open, by id. */
    openMatters: access.open,
    segments: matchedSegments,
    groups: [
      ...suggested.map((group) => ({
        ...group,
        workedMinutes: workedMinutes(group),
        slivers: offeredSlivers(group.id),
      })),
      ...unmatched,
    ].sort(
      (left, right) =>
        Number(left.matter === null) - Number(right.matter === null) ||
        right.durationMs - left.durationMs ||
        left.id.localeCompare(right.id),
    ),
    /** Matters recorded too briefly to suggest, longest first. A matter
     * part of whose time an entry already holds adds its rest rounded down,
     * and is no brief touch when that is no whole minute. */
    briefTouches: briefTouches
      .map((group) => ({
        ...group,
        workedMinutes:
          (days.get(group.id)?.draftedMs ?? 0) > 0
            ? Math.floor(group.durationMs / MINUTE_MS)
            : BRIEF_TOUCH_MINUTES,
        slivers: [],
      }))
      .filter(({ workedMinutes: minutes }) => minutes > 0)
      .sort(
        (left, right) =>
          right.durationMs - left.durationMs || left.id.localeCompare(right.id),
      ),
  };
};

/** A matter's time over the whole day: all of it, the part entries already
 * hold, and whether the member assigned any of it. */
type DayTime = { durationMs: number; draftedMs: number; assigned: boolean };

const dayTimes = (segments: readonly MatchedSegment[]) => {
  const days = new Map<string, DayTime>();
  for (const segment of segments) {
    if (segment.matter === null) {
      continue;
    }
    const day = days.get(segment.matter.id) ?? {
      durationMs: 0,
      draftedMs: 0,
      assigned: false,
    };
    const durationMs = segment.endMs - segment.startMs;
    days.set(segment.matter.id, {
      durationMs: day.durationMs + durationMs,
      draftedMs: day.draftedMs + (segment.drafted ? durationMs : 0),
      assigned: day.assigned || segment.confidence === "manual",
    });
  }
  return days;
};

/** Each pooled matter's share of the day's whole minutes, by largest
 * remainder; the same rule as the brief touches decides who is pooled. */
const poolShares = (days: ReadonlyMap<string, DayTime>) => {
  const pooled = [...days].filter(
    ([, { durationMs, assigned }]) => durationMs >= BRIEF_MS || assigned,
  );
  const minutes = recordedMinutes(
    pooled.map(([, { durationMs }]) => durationMs),
  );
  return new Map(pooled.map(([id], index) => [id, minutes[index] ?? 0]));
};

/**
 * The minutes each matter's suggestion claims. The day's matters share its
 * whole minutes by largest remainder over their whole-day time, drafted or
 * not, so creating one suggestion's entry never changes what the others
 * claim, and together they never claim more than was recorded. A matter part
 * of whose time an entry already holds claims its rest rounded down.
 */
const dayMinutes = (days: ReadonlyMap<string, DayTime>) => {
  const shared = poolShares(days);
  return ({ id, durationMs }: Pick<DayReviewGroup, "id" | "durationMs">) => {
    const day = days.get(id);
    const own = shared.get(id);
    return day === undefined || own === undefined || day.draftedMs > 0
      ? Math.floor(durationMs / MINUTE_MS)
      : own;
  };
};

/**
 * Whether taking a matter's slivers in leaves every other matter's share as
 * it is. An entry keeps the minutes it was created with, so a share that
 * moved to the sliver's matter afterwards would be claimed twice; slivers
 * that would move one are not offered.
 */
const keepsOtherShares = (
  days: ReadonlyMap<string, DayTime>,
  matterId: string,
  slivers: readonly MatchedSegment[],
) => {
  const day = days.get(matterId);
  if (day === undefined) {
    return false;
  }
  const before = poolShares(days);
  const after = poolShares(
    new Map(days).set(matterId, {
      ...day,
      durationMs: day.durationMs + totalDurationMs(slivers),
      assigned: true,
    }),
  );
  return [...before].every(
    ([id, minutes]) => id === matterId || after.get(id) === minutes,
  );
};

/** The exact ranges an entry made of these segments covers. */
export const segmentRanges = (
  segments: readonly MatchedSegment[],
): ActivityRange[] =>
  segments.map(({ startMs, endMs }) => ({
    start: Temporal.Instant.fromEpochMilliseconds(startMs).toString(),
    end: Temporal.Instant.fromEpochMilliseconds(endMs).toString(),
  }));

/** Where a segment's time stands for slivers: a matter's; recorded with no
 * matter at all; or taken, because an entry already holds it or it was
 * recorded with a matter the review did not offer, which is that matter's
 * and never another's. */
type SliverRole =
  { matterId: string; type: "matter" } | { type: "free" } | { type: "taken" };

const sliverRole = (segment: MatchedSegment | undefined): SliverRole => {
  if (segment === undefined || segment.drafted) {
    return { type: "taken" };
  }
  if (segment.matter !== null) {
    return { matterId: segment.matter.id, type: "matter" };
  }
  return segment.matterId === null ? { type: "free" } : { type: "taken" };
};

/**
 * Each matter's slivers: a run of time recorded with no matter, under
 * {@link BRIEF_MS} in all, whose neighbours on both sides are that one
 * matter's own time no more than {@link SUGGESTION_RUN_GAP_MS} away. Time
 * recorded on another matter, or already in an entry, never is one: offering
 * it would count one instant twice.
 */
const sliversByMatter = (segments: readonly MatchedSegment[]) => {
  const ordered = [...segments].sort(
    (left, right) => left.startMs - right.startMs,
  );
  const slivers = new Map<string, MatchedSegment[]>();
  for (let start = 0; start < ordered.length;) {
    let end = start;
    while (
      end < ordered.length &&
      sliverRole(ordered.at(end)).type === "free"
    ) {
      end++;
    }
    if (end === start) {
      start++;
      continue;
    }
    const run = ordered.slice(start, end);
    const before = start > 0 ? ordered.at(start - 1) : undefined;
    const after = ordered.at(end);
    start = end;
    const beforeRole = sliverRole(before);
    const afterRole = sliverRole(after);
    const first = run.at(0);
    const last = run.at(-1);
    if (
      beforeRole.type !== "matter" ||
      afterRole.type !== "matter" ||
      beforeRole.matterId !== afterRole.matterId ||
      before === undefined ||
      after === undefined ||
      first === undefined ||
      last === undefined ||
      totalDurationMs(run) >= BRIEF_MS ||
      first.startMs - before.endMs > SUGGESTION_RUN_GAP_MS ||
      after.startMs - last.endMs > SUGGESTION_RUN_GAP_MS
    ) {
      continue;
    }
    slivers.set(beforeRole.matterId, [
      ...(slivers.get(beforeRole.matterId) ?? []),
      ...run,
    ]);
  }
  return slivers;
};

/** The member's own entries on the reviewed day, as far as they were read. */
export type DayEntriesRead =
  | { type: "loading" }
  | { entries: DesktopDayEntriesResponse["entries"]; type: "ready" }
  | { type: "failed" };

/** What a suggestion says about its matter's time recorded elsewhere. */
export type RecordedElsewhere =
  | { type: "none" }
  | { minutes: number; type: "recorded" }
  /** The day's entries could not be read, so a duplicate cannot be ruled
   * out. */
  | { type: "unknown" };

type RecordedElsewhereOptions = {
  dayEntries: DayEntriesRead;
  /** The entries this computer created for the day. */
  draftedEntries: MatchDayOptions["draftedEntries"];
  /** The suggestion's matter, `null` before one is chosen. */
  matterId: string | null;
};

/**
 * The time already on a suggestion's matter for the reviewed day that this
 * computer did not submit: from another computer or the web. An entry this
 * computer created stays its own wherever it was edited later.
 */
export const recordedElsewhere = ({
  dayEntries,
  draftedEntries,
  matterId,
}: RecordedElsewhereOptions): RecordedElsewhere => {
  if (matterId === null) {
    return { type: "none" };
  }
  switch (dayEntries.type) {
    case "loading":
      return { type: "none" };
    case "failed":
      return { type: "unknown" };
    case "ready": {
      const ownEntryIds = new Set(draftedEntries.map(({ entryId }) => entryId));
      let minutes = 0;
      for (const entry of dayEntries.entries) {
        if (entry.matterId === matterId && !ownEntryIds.has(entry.id)) {
          minutes += entry.durationMinutes;
        }
      }
      return minutes > 0 ? { type: "recorded", minutes } : { type: "none" };
    }
    default:
      dayEntries satisfies never;
      return panic("Unknown day entries read");
  }
};
