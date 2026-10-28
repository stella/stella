import { panic } from "better-result";
import * as v from "valibot";

import { CZ_ECLI_COURT_REGISTRY } from "@stll/api-contract/case-law-courts";
import type { DecisionReviewLink } from "@stll/api-contract/case-law-reviews";
import { DECISION_REVIEW_OUTCOMES } from "@stll/api-contract/case-law-reviews";
import {
  canonicalDecisionIdentifierKey,
  CZE_SHEET_NUMBER_SOURCE,
  DECISION_DASH_CLASS_SOURCE,
  decisionDocketGrammarForJurisdiction,
  foldDecisionIdentifierInput,
  parseDecisionDocket,
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
    .replace("pobočky", "pobočka")
    .replace(/\s+České republiky$/u, "");
  const key = foldDecisionIdentifierInput(normalized);
  const compoundDistrictSeat = new RegExp(
    String.raw`^Okresní soud (?<seat>${DISTRICT_COMPOUND_SEAT_SOURCE})$`,
    "u",
  ).exec(key)?.groups?.["seat"];
  if (compoundDistrictSeat !== undefined) {
    return `Okresní soud ${compoundDistrictSeat.replace(/\s*-\s*|\s+/gu, "-")}`;
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
  /^\s+(?:zčásti|částečně|v\s+části|v\s+celém\s+rozsahu|ve\s+všech\s+výrocích|ve?\s+výrok(?:u|y|ů|ích)?\s+(?:[IVX]+|\d+|o\s))/iu;

const holdingDispositions = (item: string): string[] => {
  const dispositions: string[] = [];
  let start = 0;
  for (const match of item.matchAll(dispositionVerb)) {
    const verbEnd = match.index + match[0].length;
    const scope = dispositionScopeSuffix.exec(item.slice(verbEnd));
    const end = verbEnd + (scope?.[0].length ?? 0);
    // A coordinated subject can name several judgments before one verb.
    // A later verb starts a new disposition, even inside one numbered item.
    dispositions.push(item.slice(start, end));
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
};

const docketKey = canonicalDecisionIdentifierKey;

type ReviewOutcomeOptions = {
  target: ReviewTarget;
  items: string[];
  targetCount: number;
  sameFileTargetCount: number;
};

const reviewOutcome = ({
  target,
  items,
  targetCount,
  sameFileTargetCount,
}: ReviewOutcomeOptions): CzechAppealReview["outcome"] => {
  const key = docketKey(target.reviewedCaseNumber);
  const namesTarget = (item: string): boolean | null => {
    const dockets = [...item.matchAll(new RegExp(DOCKET_SOURCE, "gu"))];
    if (dockets.length > 0) {
      return dockets.some((match) => {
        if (docketKey(match[0]) !== key) {
          return false;
        }
        const date = new RegExp(
          String.raw`ze\s+dne\s+(?<date>${DATE_SOURCE}),?\s*(?:č\.\s*j\.|čj\.|sp\.\s*zn\.)\s*$`,
          "u",
        ).exec(item.slice(0, match.index))?.groups?.["date"];
        const reviewedDate = date === undefined ? null : dateOf(date);
        return reviewedDate === null
          ? sameFileTargetCount === 1
          : target.reviewedDecisionDate === null ||
              reviewedDate === target.reviewedDecisionDate;
      });
    }
    return null;
  };
  const dispositionItems = items.filter((item) => {
    if (!reversal.test(item)) {
      return false;
    }
    const named = namesTarget(item);
    if (named !== null) {
      return named;
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
  });
  const rejection = items.some(
    (item) => remedyRejected.test(item) && namesTarget(item) !== false,
  );
  if (dispositionItems.length === 0) {
    if (rejection) {
      return "upheld";
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
  /** The holding only; quoted outcomes in the reasoning are not evidence. */
  holding: string;
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
    const parsed = parseDecisionDocket(reviewedCaseNumber, {
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
    });
  }

  const normalizedHolding =
    foldDecisionIdentifierInput(collapseSpacedLetters(holding))
      .split(/odůvodnění\s*:/iu)
      .at(0) ?? "";
  const items = normalizedHolding
    .split(/(?:^|\s)[IVX]+\.\s+/u)
    .flatMap(holdingDispositions);
  return targets.map((target) => ({
    reviewedCaseNumber: target.reviewedCaseNumber,
    reviewedCourt: target.reviewedCourt,
    reviewedDecisionDate: target.reviewedDecisionDate,
    outcome: reviewOutcome({
      target,
      items,
      targetCount: targets.length,
      sameFileTargetCount: targets.filter(
        (candidate) =>
          candidate.reviewedCourt === target.reviewedCourt &&
          docketKey(candidate.reviewedCaseNumber) ===
            docketKey(target.reviewedCaseNumber),
      ).length,
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
  const parsed = v.safeParse(v.array(publisherReviewSchema), stored ?? []);
  if (!parsed.success) {
    return panic(
      "Publisher review metadata does not match its ingestion contract",
    );
  }
  if (parsed.output.length === 0) {
    // An empty publisher table supplies no usable target identity. A malformed
    // row is retained by the adapter and reported as conflicting evidence.
    return opening.map((review) => ({
      ...review,
      source: "opening",
      evidenceStatus: incompletePublisherTarget ? "conflict" : "opening_only",
      openingEvidence: [review],
    }));
  }
  const consistent =
    !incompletePublisherTarget &&
    parsed.output.length === opening.length &&
    parsed.output.every(
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
  return parsed.output.map((review) => {
    const sameTargets = opening.filter(
      (candidate) =>
        sameReviewedDecision({ publisher: review, opening: candidate }) &&
        (review.reviewedDecisionDate === null ||
          candidate.reviewedDecisionDate === review.reviewedDecisionDate),
    );
    const sameTarget = sameTargets.length === 1 ? sameTargets.at(0) : undefined;
    return {
      ...review,
      outcome:
        review.outcome === "unknown" && sameTarget !== undefined
          ? sameTarget.outcome
          : review.outcome,
      source: "metadata",
      evidenceStatus,
      openingEvidence: opening,
    };
  });
};
