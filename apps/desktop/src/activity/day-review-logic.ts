import type { DesktopTimeEntryMatterCandidate } from "@stll/api-contract/desktop-time-entries";
import { normalizeUnicode } from "@stll/text-normalize";
import { Temporal } from "@stll/time";

import {
  type AppTotal,
  appTotals,
  documentName,
  roundedTenthsOfHour,
  type TimedSegment,
  totalDurationMs,
} from "./activity-logic";
import type { ActivityManualAssignment } from "./activity-types";

type ActivityRange = { start: string; end: string };
export type MatchConfidence = "strong" | "likely" | "manual" | "unmatched";
export type MatchedSegment = TimedSegment & {
  matter: DesktopTimeEntryMatterCandidate | null;
  confidence: MatchConfidence;
  evidence: string[];
  drafted: boolean;
};
/** What an app's windows showed, the longest-used title first. */
export type AppEvidence = {
  identifier: string;
  name: string;
  details: string[];
};
export type DayReviewGroup = {
  id: string;
  matter: DesktopTimeEntryMatterCandidate | null;
  confidence: MatchConfidence;
  evidence: AppEvidence[];
  apps: AppTotal[];
  segments: MatchedSegment[];
  ranges: ActivityRange[];
  durationMs: number;
  roundedTenths: number;
};

type MatchDayOptions = {
  segments: readonly TimedSegment[];
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  captureDetails: boolean;
  manualAssignments: readonly ActivityManualAssignment[];
  draftedEntries: readonly (ActivityRange & { entryId: string })[];
};

const tokens = (text: string) =>
  normalizeUnicode(text, "NFKC")
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
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
      for (const token of new Set(tokens(candidate[field] ?? ""))) {
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

type LikelyMatterOptions = {
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  evidence: readonly string[];
  distinctiveTokens: ReturnType<typeof distinctiveTokenIndex>;
};
const likelyMatter = ({
  candidates,
  evidence,
  distinctiveTokens,
}: LikelyMatterOptions) => {
  const details = evidence.map(tokens);
  const references = candidates.filter(
    ({ reference }) =>
      reference !== null &&
      reference.length > 0 &&
      details.some((detail) => hasPhrase(detail, tokens(reference))),
  );
  if (references.length > 0) {
    return references.length === 1 ? (references.at(0) ?? null) : null;
  }
  const hits = new Set<string>();
  for (const field of ["name", "clientName"] as const) {
    for (const token of new Set(details.flat())) {
      const owners = distinctiveTokens[field].get(token);
      if (owners?.size !== 1) {
        continue;
      }
      for (const id of owners) {
        hits.add(id);
      }
    }
  }
  if (hits.size !== 1) {
    return null;
  }
  return candidates.find(({ id }) => hits.has(id)) ?? null;
};

type MatchSegmentOptions = {
  segment: TimedSegment;
  candidates: readonly DesktopTimeEntryMatterCandidate[];
  captureDetails: boolean;
  assignment: ActivityManualAssignment | undefined;
  drafted: boolean;
  distinctiveTokens: ReturnType<typeof distinctiveTokenIndex>;
};
const matchSegment = ({
  segment,
  candidates,
  captureDetails,
  assignment,
  drafted,
  distinctiveTokens,
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
  if (assignment) {
    const candidate = candidates.find(({ id }) => id === assignment.matterId);
    const matter =
      candidate ??
      (assignment.matter
        ? {
            ...assignment.matter,
            signals: {
              lastWorkedAt: null,
              newlyAssignedAt: null,
              upcomingDeadline: null,
            },
          }
        : null);
    return {
      ...segment,
      matter,
      confidence: matter ? "manual" : "unmatched",
      evidence,
      drafted,
    };
  }
  const strong = candidates.find(({ id }) => id === segment.matterId);
  if (strong) {
    return {
      ...segment,
      matter: strong,
      confidence: "strong",
      evidence,
      drafted,
    };
  }
  if (segment.matterId) {
    return {
      ...segment,
      matter: null,
      confidence: "unmatched",
      evidence,
      drafted,
    };
  }
  if (captureDetails) {
    const matter = likelyMatter({ candidates, evidence, distinctiveTokens });
    if (matter) {
      return { ...segment, matter, confidence: "likely", evidence, drafted };
    }
  }
  return {
    ...segment,
    matter: null,
    confidence: "unmatched",
    evidence,
    drafted,
  };
};
const groupConfidence = (
  segments: readonly MatchedSegment[],
): MatchConfidence => {
  for (const confidence of [
    "manual",
    "strong",
    "likely",
    "unmatched",
  ] as const) {
    if (segments.some((segment) => segment.confidence === confidence)) {
      return confidence;
    }
  }
  return "unmatched";
};

// `host: name` from terminals and remote sessions; `page · site` and
// `page - site` from web pages.
const SHARED_CONTEXT = [
  { pattern: /^([^\s:]+): (.+)$/u, context: 1, own: 2 },
  { pattern: /^(.+?) (?:·|\||-|–|—) ([^·|\-–—]+)$/u, context: 2, own: 1 },
] as const;

/** Context that several titles share says nothing about any of them, so it is
 * dropped and each title keeps only its own part. */
export const withoutSharedContext = (evidence: readonly string[]) => {
  let titles = [...evidence];
  for (const { pattern, context, own } of SHARED_CONTEXT) {
    const counts = new Map<string, number>();
    for (const title of titles) {
      const key = pattern.exec(title)?.at(context);
      if (key) {
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    titles = [
      ...new Set(
        titles.map((title) => {
          const match = pattern.exec(title);
          const key = match?.at(context);
          const rest = match?.at(own);
          return key && rest && (counts.get(key) ?? 0) > 1 ? rest : title;
        }),
      ),
    ];
  }
  return titles;
};

/** Titles a review row shows per app before it counts the rest. */
export const EVIDENCE_DETAIL_LIMIT = 3;

const TITLE_SEPARATORS = [" - ", " – ", " — "] as const;

/** Browsers title a window `page - Browser - Profile`; the app icon already
 * names the browser, so the title keeps only the page. */
export const withoutAppSuffix = (title: string, appName: string) => {
  for (const separator of TITLE_SEPARATORS) {
    const index = title.indexOf(`${separator}${appName}`);
    const rest = title.slice(index + separator.length + appName.length);
    if (
      index > 0 &&
      (rest === "" || TITLE_SEPARATORS.some((next) => rest.startsWith(next)))
    ) {
      return title.slice(0, index);
    }
  }
  return title;
};

const appEvidence = (segments: readonly MatchedSegment[]): AppEvidence[] =>
  appTotals(segments).flatMap(({ identifier, name }) => {
    const durations = new Map<string, number>();
    for (const segment of segments) {
      if (segment.appIdentifier !== identifier) {
        continue;
      }
      for (const detail of segment.evidence) {
        const title = withoutAppSuffix(detail, name);
        durations.set(
          title,
          (durations.get(title) ?? 0) + segment.endMs - segment.startMs,
        );
      }
    }
    const details = withoutSharedContext(
      [...durations]
        .sort(
          ([leftTitle, left], [rightTitle, right]) =>
            right - left || leftTitle.localeCompare(rightTitle),
        )
        .map(([title]) => title),
    ).filter((title) => title.toLowerCase() !== name.toLowerCase());
    return details.length > 0 ? [{ identifier, name, details }] : [];
  });

/** Splitting at every review boundary prevents assignments or receipts from
 * claiming time beyond the exact range the user selected. */
export const matchDay = ({
  segments,
  candidates,
  captureDetails,
  manualAssignments,
  draftedEntries,
}: MatchDayOptions) => {
  const orderedCandidates = [...candidates].sort((left, right) =>
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
          distinctiveTokens,
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
  const groups: DayReviewGroup[] = [];
  for (const [id, group] of grouped) {
    const first = group.at(0);
    if (!first) {
      continue;
    }
    const durationMs = totalDurationMs(group);
    const evidence = appEvidence(group);
    const confidence = groupConfidence(group);
    groups.push({
      id,
      matter: first.matter,
      confidence,
      evidence,
      apps: appTotals(group),
      segments: group,
      ranges: group.map(({ startMs, endMs }) => ({
        start: Temporal.Instant.fromEpochMilliseconds(startMs).toString(),
        end: Temporal.Instant.fromEpochMilliseconds(endMs).toString(),
      })),
      durationMs,
      roundedTenths: roundedTenthsOfHour(durationMs),
    });
  }
  return {
    segments: matchedSegments,
    groups: [...groups].sort(
      (left, right) =>
        Number(left.matter === null) - Number(right.matter === null) ||
        right.durationMs - left.durationMs ||
        left.id.localeCompare(right.id),
    ),
  };
};
