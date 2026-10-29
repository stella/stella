import { panic } from "better-result";
import * as v from "valibot";

import { CZ_ECLI_COURT_REGISTRY } from "@stll/api-contract/case-law-courts";
import type { DecisionReviewLink } from "@stll/api-contract/case-law-reviews";
import { DECISION_REVIEW_OUTCOMES } from "@stll/api-contract/case-law-reviews";
import {
  CZE_SHEET_NUMBER_SOURCE,
  DECISION_DASH_CLASS_SOURCE,
  decisionDocketGrammarForJurisdiction,
  foldDecisionIdentifierInput,
} from "@stll/api-contract/decision-docket-grammar";
import { readDecisionDocketReference } from "@stll/api-contract/decision-docket-reference";
import { collapseSpacedLetters } from "@stll/text-normalize";

import { detectCitationDecisionDate } from "@/api/handlers/case-law/citation-decision-date";
import { isRecord } from "@/api/lib/type-guards";

export type CzechAppealReview = {
  reviewedCaseNumber: string;
  reviewedCourt: string;
  reviewedDecisionDate: string | null;
  outcome: DecisionReviewLink["outcome"];
};

const COURT_ADJECTIVES = {
  Krajského: "Krajský",
  Městského: "Městský",
  Vrchního: "Vrchní",
  Nejvyššího: "Nejvyšší",
  Okresního: "Okresní",
  Obvodního: "Obvodní",
} as const;

const CZECH_MONTHS = {
  ledna: "1",
  února: "2",
  března: "3",
  dubna: "4",
  května: "5",
  června: "6",
  července: "7",
  srpna: "8",
  září: "9",
  října: "10",
  listopadu: "11",
  prosince: "12",
} as const;
const czechMonthNumbers = new Map(Object.entries(CZECH_MONTHS));

const COURT_SEAT_SOURCE = String.raw`\s+(?:v|ve)\s+\p{Lu}\p{L}+(?:\s+(?:nad|pod)\s+\p{Lu}\p{L}+)?(?:\s+\p{Lu}\p{L}+)?(?:\s*[-–]\s*pobočky\s+v\s+\p{Lu}\p{L}+)?`;
const DISTRICT_COMPOUND_SEAT_SOURCE = String.raw`(?:Praha(?:\s*[${DECISION_DASH_CLASS_SOURCE}]\s*|\s+)(?:východ|západ)|Brno(?:\s*[${DECISION_DASH_CLASS_SOURCE}]\s*|\s+)venkov)`;
const COURT_SOURCE = String.raw`(?:(?:Krajského|Městského|Vrchního|Nejvyššího)(?:\s+správního)?\s+soudu(?:\s+České\s+republiky|${COURT_SEAT_SOURCE})?|Okresního\s+soudu(?:${COURT_SEAT_SOURCE}|\s+${DISTRICT_COMPOUND_SEAT_SOURCE})|Obvodního\s+soudu\s+pro\s+Prahu\s+(?:10|[1-9]))`;
const DATE_SOURCE = String.raw`\d{1,2}\.\s*(?:\d{1,2}\.|${Object.keys(CZECH_MONTHS).join("|")})\s*\d{4}`;
const DOCKET_SOURCE = String.raw`(?:(?:\d{1,3}|[IVX]+|Pl)\.?\s*)?(?:\d{1,3}\s*)?\p{L}{1,7}\.?\s*\d{1,6}\s*\/\s*\d{2}(?:\d{2})?(?:\s*[${DECISION_DASH_CLASS_SOURCE}]\s*${CZE_SHEET_NUMBER_SOURCE})?(?![\p{L}\d/]|\s*[${DECISION_DASH_CLASS_SOURCE}])`;
const TARGET = new RegExp(
  String.raw`(?<!\p{L})(?<connector>proti|a|,)\s+(?<documentType>rozsudku|usnesení|rozhodnutí)\s+(?<court>${COURT_SOURCE})\s+ze\s+dne\s+(?<date>${DATE_SOURCE}),?\s*(?:č\.\s*j\.|čj\.|sp\.\s*zn\.)\s*(?<docket>${DOCKET_SOURCE})(?![\p{L}\d/])`,
  "gu",
);

export const canonicalCzechReviewCourt = (court: string): string => {
  let normalized = court.replace(/\s+/gu, " ").trim();
  for (const [genitive, nominative] of Object.entries(COURT_ADJECTIVES)) {
    normalized = normalized.replace(genitive, () => nominative);
  }
  normalized = normalized
    .replace("správního", "správní")
    .replace("soudu", "soud")
    .replace("pobočky", "pobočka");
  const stateSuffix = " České republiky";
  if (normalized.endsWith(stateSuffix)) {
    normalized = normalized.slice(0, -stateSuffix.length);
  }
  const key = foldDecisionIdentifierInput(normalized);
  const compoundDistrictSeat = new RegExp(
    String.raw`^Okresní soud (?<seat>${DISTRICT_COMPOUND_SEAT_SOURCE})$`,
    "u",
  ).exec(key)?.groups?.["seat"];
  if (compoundDistrictSeat !== undefined) {
    return `Okresní soud ${compoundDistrictSeat.replaceAll(" ", "-").replace(/-+/gu, "-")}`;
  }
  // The source can name courts absent from the ECLI registry. Keep their
  // explicit names as unresolved evidence; registered names use its spelling.
  return (
    Object.values(CZ_ECLI_COURT_REGISTRY).find(
      ({ name }) => foldDecisionIdentifierInput(name) === key,
    )?.name ?? normalized
  );
};

const dateOf = (printed: string): string | null => {
  const numeric = printed.replace(/\p{L}+/gu, (month) => {
    const number = czechMonthNumbers.get(month);
    return number === undefined ? month : `${number}.`;
  });
  const context = ` ze dne ${numeric}, č. j. `;
  return detectCitationDecisionDate(context, context.length);
};

const remedyRejected =
  /(?:kasační\s+stížnosti?|ústavní\s+stížnosti?|dovolání|odvolání)(?!\p{L})[\s\S]*?(?:zamítá|odmítá|zamítají|odmítají)(?!\p{L})/iu;
const reversal = /(?<!\p{L})(?:zrušuje|zrušují|ruší|mění)(?!\p{L})/iu;
const dispositionVerb =
  /(?<!\p{L})(?:zrušuje|zrušují|ruší|mění|zamítá|odmítá|zamítají|odmítají|přerušuje)(?!\p{L})/giu;
const dispositionScopeSuffix =
  /^\s+(?:(?:pouze|jen|toliko)\s+)?(?:zčásti|částečně|v\s+části|v\s+celém\s+rozsahu|ve\s+všech\s+výrocích|ve?\s+výrok(?:u|y|ů|ích)?\s+(?:[IVX]+|\d+|o\s))/iu;

const holdingDispositions = (item: string): string[] => {
  const dispositions: string[] = [];
  let start = 0;
  for (const match of item.matchAll(dispositionVerb)) {
    const verbEnd = match.index + match[0].length;
    const scope = dispositionScopeSuffix.exec(item.slice(verbEnd));
    const end = verbEnd + (scope?.[0].length ?? 0);
    // A coordinated subject can name several judgments before one verb.
    // A later verb starts a new disposition, even inside one numbered item.
    dispositions.push(
      item.slice(start, end).replace(/^[\s.;]*(?:[IVX]+\.\s+)?/u, ""),
    );
    start = end;
  }
  return dispositions;
};
const appealProceedingInterrupted =
  /řízení\s+o\s+(?:kasační\s+stížnosti|ústavní\s+stížnosti|dovolání|odvolání)[^.!?]{0,120}se\s+přerušuje(?!\p{L})/iu;
const partial =
  /(?<!\p{L})(?:(?:zčásti|částečně|v\s+části)(?!\p{L})|(?:ve?\s+)?výrok(?:u|y|ů|ích)?\s+(?:[IVX]+(?!\p{L})|\d+|o\s))/iu;
const wholeJudgment = /(?:v\s+celém\s+rozsahu|ve\s+všech\s+výrocích)/iu;
const ancillaryOrder =
  /(?:o\s+ustanovení|ustanoven[ýé]|zprošťuje|odměn[ayěu])/iu;

type ReviewTarget = Omit<CzechAppealReview, "outcome"> & {
  documentType: string;
  docketFamily: string;
};

type ReviewOutcomeOptions = {
  target: ReviewTarget;
  items: string[];
  targetCount: number;
  sameFileTargets: ReviewTarget[];
};

const reviewOutcome = ({
  target,
  items,
  targetCount,
  sameFileTargets,
}: ReviewOutcomeOptions): CzechAppealReview["outcome"] => {
  const namesTarget = (
    item: string,
  ): "target" | "other" | "ambiguous" | "unnamed" => {
    const dockets = [...item.matchAll(new RegExp(DOCKET_SOURCE, "gu"))];
    if (dockets.length === 0) {
      const court = new RegExp(COURT_SOURCE, "u").exec(item)?.[0];
      if (
        court !== undefined &&
        canonicalCzechReviewCourt(court) !== target.reviewedCourt
      ) {
        return "other";
      }
      if (court === undefined && /(?<!\p{L})soudu(?!\p{L})/u.test(item)) {
        return "ambiguous";
      }
      if (
        targetCount > 1 &&
        reversal.test(item) &&
        !ancillaryOrder.test(item)
      ) {
        return "ambiguous";
      }
      return "unnamed";
    }
    let ambiguous = false;
    let previousDocketEnd = 0;
    for (const match of dockets) {
      const context = item.slice(previousDocketEnd, match.index);
      previousDocketEnd = match.index + match[0].length;
      const docket = readDecisionDocketReference(match[0], {
        grammar: decisionDocketGrammarForJurisdiction("CZE"),
      });
      if (docket === null || docket.family.canonical !== target.docketFamily) {
        continue;
      }
      const identity = new RegExp(
        String.raw`(?:(?<court>${COURT_SOURCE})\s+)?(?:ze\s+dne\s+(?<date>${DATE_SOURCE}),?\s*)?(?:č\.\s*j\.|čj\.|sp\.\s*zn\.)\s*$`,
        "u",
      ).exec(context)?.groups;
      const date = identity?.["date"];
      const court = identity?.["court"];
      const reviewedDate = date === undefined ? null : dateOf(date);
      const reviewedCourt =
        court === undefined ? null : canonicalCzechReviewCourt(court);
      const candidates = sameFileTargets.filter(
        (candidate) =>
          (reviewedCourt === null ||
            candidate.reviewedCourt === reviewedCourt) &&
          (reviewedDate === null ||
            candidate.reviewedDecisionDate === null ||
            candidate.reviewedDecisionDate === reviewedDate),
      );
      if (court === undefined && /(?<!\p{L})soudu(?!\p{L})/u.test(context)) {
        if (candidates.includes(target)) {
          ambiguous = true;
        }
        continue;
      }
      if (candidates.length === 1 && candidates[0] === target) {
        return "target";
      }
      if (candidates.includes(target)) {
        ambiguous = true;
      }
    }
    return ambiguous ? "ambiguous" : "other";
  };
  const dispositions = items.map((item) => ({
    item,
    match: namesTarget(item),
  }));
  const dispositionItems = dispositions
    .filter(({ item, match }) => {
      if (!reversal.test(item)) {
        return false;
      }
      if (match !== "unnamed") {
        return match === "target";
      }
      // Without an identity in the holding, only a sole reviewed judgment can
      // inherit the generic disposition. Orders about counsel are separate.
      if (targetCount !== 1 || ancillaryOrder.test(item)) {
        return false;
      }
      const documentType =
        target.documentType === "rozsudku" ? "rozsudek" : target.documentType;
      return new RegExp(
        String.raw`^(?:napaden[ýé]\s+)?(?:${documentType}|výrok(?:u|y)?\s+)`,
        "iu",
      ).test(item.trim());
    })
    .map(({ item }) => item);
  const rejection = dispositions.some(
    ({ item, match }) =>
      remedyRejected.test(item) && (match === "target" || match === "unnamed"),
  );
  if (dispositionItems.length === 0) {
    // A remaining-part rejection cannot settle which of the indistinguishable
    // judgments an explicit but ambiguous annulment overturned.
    if (
      dispositions.some(
        ({ item, match }) => match === "ambiguous" && reversal.test(item),
      )
    ) {
      return "unknown";
    }
    if (rejection) {
      const partialRejection = dispositions.some(
        ({ item, match }) =>
          (match === "target" || match === "unnamed") &&
          remedyRejected.test(item) &&
          partial.test(item),
      );
      if (!partialRejection) {
        return "upheld";
      }
      return items.some((item) =>
        /řízení[^.!?]{0,120}přerušuje(?!\p{L})/iu.test(item),
      )
        ? "pending"
        : "unknown";
    }
    return items.some((item) => appealProceedingInterrupted.test(item))
      ? "pending"
      : "unknown";
  }
  const limitedReversal = dispositionItems.some(
    (item) => !wholeJudgment.test(item) && partial.test(item),
  );
  return limitedReversal || (targetCount === 1 && rejection)
    ? "partly"
    : "overturned";
};

type ExtractCzechAppealReviewsOptions = {
  /** The opening section only; reasoning must never be supplied here. */
  header: string;
  /** Publisher holding paragraphs; a string represents one paragraph. */
  holding: string | readonly string[];
};

/** A reviewed judgment is identified by the opening formula, never proximity. */
export const extractCzechAppealReviews = ({
  header,
  holding,
}: ExtractCzechAppealReviewsOptions): CzechAppealReview[] => {
  const normalizedHeader =
    foldDecisionIdentifierInput(header)
      .split(/(?:takto\s*:|odůvodnění\s*:)/iu)
      .at(0) ?? "";
  const targets: ReviewTarget[] = [];
  let previousTargetEnd: number | null = null;
  for (const match of normalizedHeader.matchAll(TARGET)) {
    const { connector, court, date, docket, documentType } = match.groups ?? {};
    if (
      (connector !== "proti" &&
        (previousTargetEnd === null ||
          !/^[,\s]*$/u.test(
            normalizedHeader.slice(previousTargetEnd, match.index),
          ))) ||
      court === undefined ||
      date === undefined ||
      docket === undefined ||
      documentType === undefined
    ) {
      continue;
    }
    const reviewedCaseNumber = foldDecisionIdentifierInput(docket);
    const parsed = readDecisionDocketReference(reviewedCaseNumber, {
      grammar: decisionDocketGrammarForJurisdiction("CZE"),
    });
    if (parsed === null) {
      continue;
    }
    const reviewedCourt = canonicalCzechReviewCourt(court);
    previousTargetEnd = match.index + match[0].length;
    if (
      targets.some(
        (target) =>
          target.reviewedCourt === reviewedCourt &&
          target.reviewedCaseNumber === reviewedCaseNumber &&
          target.reviewedDecisionDate === dateOf(date),
      )
    ) {
      continue;
    }
    targets.push({
      reviewedCaseNumber,
      reviewedCourt,
      reviewedDecisionDate: dateOf(date),
      documentType,
      docketFamily: parsed.family.canonical,
    });
  }

  const paragraphs = typeof holding === "string" ? [holding] : holding;
  // Roman numerals also name operative parts inside a disposition. Preserve
  // publisher paragraphs and keep those references with their subject.
  const items = paragraphs.flatMap((paragraph) => {
    const normalized =
      foldDecisionIdentifierInput(collapseSpacedLetters(paragraph))
        .split(/odůvodnění\s*:/iu)
        .at(0) ?? "";
    return holdingDispositions(normalized);
  });
  return targets.map((target) => ({
    reviewedCaseNumber: target.reviewedCaseNumber,
    reviewedCourt: target.reviewedCourt,
    reviewedDecisionDate: target.reviewedDecisionDate,
    outcome: reviewOutcome({
      target,
      items,
      targetCount: targets.length,
      sameFileTargets: targets.filter(
        (candidate) => candidate.docketFamily === target.docketFamily,
      ),
    }),
  }));
};

const publisherReviewSchema = v.strictObject({
  reviewedCaseNumber: v.string(),
  reviewedCourt: v.string(),
  reviewedDecisionDate: v.nullable(v.string()),
  outcome: v.picklist(DECISION_REVIEW_OUTCOMES),
});

export type PlannedCzechAppealReview = CzechAppealReview & {
  source: DecisionReviewLink["source"];
  evidenceStatus: DecisionReviewLink["evidenceStatus"];
  openingEvidence: CzechAppealReview[];
};

type PlanCzechAppealReviewsOptions = ExtractCzechAppealReviewsOptions & {
  metadata: Record<string, unknown> | null | undefined;
};

type SameReviewedDecisionOptions = {
  publisher: CzechAppealReview;
  opening: CzechAppealReview;
};

const sameReviewedDecision = ({
  publisher,
  opening,
}: SameReviewedDecisionOptions): boolean => {
  const grammar = decisionDocketGrammarForJurisdiction("CZE");
  const first = readDecisionDocketReference(publisher.reviewedCaseNumber, {
    grammar,
  });
  const second = readDecisionDocketReference(opening.reviewedCaseNumber, {
    grammar,
  });
  if (first === null || second === null) {
    return panic(
      "Publisher review metadata contains an invalid reviewed docket",
    );
  }
  return (
    first.family.canonical === second.family.canonical &&
    (first.selector.kind === "none" ||
      second.selector.kind === "none" ||
      (first.selector.kind === second.selector.kind &&
        first.selector.value === second.selector.value)) &&
    foldDecisionIdentifierInput(publisher.reviewedCourt) ===
      foldDecisionIdentifierInput(opening.reviewedCourt) &&
    (publisher.reviewedDecisionDate === null ||
      opening.reviewedDecisionDate === null ||
      publisher.reviewedDecisionDate === opening.reviewedDecisionDate)
  );
};

/** Publisher identities win; conflicting prose stays visible as evidence. */
export const planCzechAppealReviews = ({
  header,
  holding,
  metadata,
}: PlanCzechAppealReviewsOptions): PlannedCzechAppealReview[] => {
  const opening = extractCzechAppealReviews({ header, holding });
  const rawRows = metadata?.["publisherReviewMetadata"];
  const incompletePublisherTarget =
    Array.isArray(rawRows) &&
    rawRows.some((row) => isRecord(row) && row["status"] === "incomplete");
  const stored = metadata?.["publisherReviews"];
  const parsed = v.safeParse(v.nullish(v.array(publisherReviewSchema)), stored);
  if (!parsed.success) {
    return panic(
      "Publisher review metadata does not match its ingestion contract",
    );
  }
  if (
    parsed.output === undefined ||
    parsed.output === null ||
    parsed.output.length === 0
  ) {
    // An empty publisher table supplies no usable target identity. A malformed
    // row is retained by the adapter and reported as conflicting evidence.
    return opening.map((review) => ({
      ...review,
      source: "opening",
      evidenceStatus: incompletePublisherTarget ? "conflict" : "opening_only",
      openingEvidence: [review],
    }));
  }
  const publisherRows = parsed.output;
  const consistent =
    !incompletePublisherTarget &&
    publisherRows.length === opening.length &&
    opening.every((candidate) =>
      publisherRows.some((review) =>
        sameReviewedDecision({ publisher: review, opening: candidate }),
      ),
    ) &&
    publisherRows.every(
      (review) =>
        opening.filter((candidate) =>
          sameReviewedDecision({ publisher: review, opening: candidate }),
        ).length === 1 &&
        opening.some(
          (candidate) =>
            sameReviewedDecision({ publisher: review, opening: candidate }) &&
            (candidate.outcome === "unknown" ||
              review.outcome === "unknown" ||
              candidate.outcome === review.outcome),
        ),
    );
  let evidenceStatus: DecisionReviewLink["evidenceStatus"];
  if (incompletePublisherTarget) {
    evidenceStatus = "conflict";
  } else if (opening.length === 0) {
    evidenceStatus = "metadata_only";
  } else if (consistent) {
    evidenceStatus = "consistent";
  } else {
    evidenceStatus = "conflict";
  }
  const publisherIdentities = new Map<string, typeof publisherRows>();
  for (const review of publisherRows) {
    const key = JSON.stringify([
      review.reviewedCourt,
      review.reviewedCaseNumber,
      review.reviewedDecisionDate,
    ]);
    const group = publisherIdentities.get(key);
    if (group === undefined) {
      publisherIdentities.set(key, [review]);
    } else {
      group.push(review);
    }
  }
  return [...publisherIdentities.values()].map((group) => {
    const review =
      group.at(0) ?? panic("Publisher review identity has no evidence");
    const knownOutcomes = new Set(
      group
        .map(({ outcome }) => outcome)
        .filter((outcome) => outcome !== "unknown"),
    );
    const officialConflict = knownOutcomes.size > 1;
    const officialOutcome = knownOutcomes.values().next().value;
    const sameTargets = opening.filter(
      (candidate) =>
        sameReviewedDecision({ publisher: review, opening: candidate }) &&
        (review.reviewedDecisionDate === null ||
          candidate.reviewedDecisionDate === review.reviewedDecisionDate),
    );
    const sameTarget = sameTargets.length === 1 ? sameTargets.at(0) : undefined;
    return {
      ...review,
      outcome: officialConflict
        ? "unknown"
        : (officialOutcome ?? sameTarget?.outcome ?? "unknown"),
      source: "metadata",
      evidenceStatus: officialConflict ? "conflict" : evidenceStatus,
      openingEvidence: opening,
    };
  });
};
