import type { api } from "@/lib/api";

// All playbook position types are inferred from the Eden API surface so the
// editor's working state and save payload stay in lockstep with the backend
// `playbookPositionsSchema` (v3). Never hand-redefine the Position shape here.

type PlaybookDetailResponse = Awaited<
  ReturnType<ReturnType<typeof api.playbooks>["get"]>
>;

type PlaybookDetailData = Exclude<
  NonNullable<Extract<PlaybookDetailResponse, { data: unknown }>["data"]>,
  Response
>;

export type PlaybookPositionsValue = PlaybookDetailData["positions"];
export type Position = PlaybookPositionsValue["items"][number];

// What the org's reviewers have done with each position, computed from their
// findings on every read. Keyed by `position.sourceId`.
export type PlaybookPositionDecisions = PlaybookDetailData["positionDecisions"];

// Scope facets, also inferred rather than hand-listed: a new perspective or
// trigger added to the backend schema must not need a matching edit here.
export type PlaybookScope = NonNullable<PlaybookDetailData["scope"]>;
export type PlaybookPerspective = NonNullable<PlaybookScope["perspective"]>;
export type PlaybookTrigger = NonNullable<PlaybookScope["trigger"]>;

// Advisory approval status (v1) — draft while unreviewed, approved once
// snapshotted by `POST /playbooks/:playbookId/approve`.
export type PlaybookApprovalStatus = PlaybookDetailData["status"];

// Discriminated on `mode`; narrow to the concrete variant with `mode === "…"`.
export type GradedPosition = Extract<Position, { mode: "graded" }>;
export type ExtractPosition = Extract<Position, { mode: "extract" }>;

export type PositionSeverity = GradedPosition["severity"];

// How it should be, for one graded position: an authored tier ladder or the
// passages of a reference document someone already negotiated. Grading
// dispatches on `source`, and so does every editor below.
export type PositionStandard = GradedPosition["standard"];
export type PositionStandardSource = PositionStandard["source"];
export type TieredStandard = Extract<PositionStandard, { source: "tiers" }>;
export type ReferenceStandard = Extract<
  PositionStandard,
  { source: "reference" }
>;
export type ReferencePassage = ReferenceStandard["passages"][number];

export type PositionTiers = TieredStandard["tiers"];
export type TierRule = PositionTiers["acceptable"]["rules"][number];
export type FallbackEntry = PositionTiers["fallback"]["entries"][number];
export type IdealLanguage = NonNullable<PositionTiers["acceptable"]["ideal"]>;
export type DeterministicCheck = NonNullable<GradedPosition["check"]>;
export type Negotiation = NonNullable<GradedPosition["negotiation"]>;
export type GradedAskConfig = GradedPosition["ask"];
export type AskManual = ExtractPosition["ask"];
export type PositionAskContent = AskManual["content"];

export type PlaybookListResponse = Awaited<
  ReturnType<typeof api.playbooks.get>
>;

type PlaybookListData = Exclude<
  NonNullable<Extract<PlaybookListResponse, { data: unknown }>["data"]>,
  Response
>;

export type PlaybookListItem = PlaybookListData["items"][number];

export type RecentPlaybookResponse = Awaited<
  ReturnType<typeof api.playbooks.recent.get>
>;

type RecentPlaybookData = Exclude<
  NonNullable<Extract<RecentPlaybookResponse, { data: unknown }>["data"]>,
  Response
>;

export type RecentPlaybookItem = RecentPlaybookData["items"][number];

export type PlaybookVersionsResponse = Awaited<
  ReturnType<ReturnType<typeof api.playbooks>["versions"]["get"]>
>;

type PlaybookVersionsData = Exclude<
  NonNullable<Extract<PlaybookVersionsResponse, { data: unknown }>["data"]>,
  Response
>;

export type PlaybookVersionItem = PlaybookVersionsData["items"][number];

// ── Constructors ──────────────────────────────────────
// Every position, rule, and fallback entry carries a client-generated uuid so
// reorder/DnD and finding citations reference stable identity, not array index.

export const newTierRule = (): TierRule => ({
  id: crypto.randomUUID(),
  text: "",
});

export const newFallbackEntry = (): FallbackEntry => ({
  id: crypto.randomUUID(),
  text: "",
});

const emptyTiers = (): PositionTiers => ({
  acceptable: { rules: [] },
  fallback: { entries: [] },
  notAcceptable: { rules: [] },
});

export const emptyTieredStandard = (): PositionStandard => ({
  source: "tiers",
  tiers: emptyTiers(),
});

/** The tier ladder a position is graded by, or `null` when its standard is a
 *  reference document's passages instead. */
export const positionTiers = (
  position: GradedPosition,
): PositionTiers | null =>
  position.standard.source === "tiers" ? position.standard.tiers : null;

/**
 * Every reference passage a list of positions pins, in the order they appear.
 * What a surface hands the passage-text read, so one request covers the whole
 * list rather than one per card.
 */
export const positionReferencePassages = (
  positions: readonly Position[],
): ReferencePassage[] => {
  const passages: ReferencePassage[] = [];
  for (const position of positions) {
    if (
      position.mode === "graded" &&
      position.standard.source === "reference"
    ) {
      passages.push(...position.standard.passages);
    }
  }
  return passages;
};

/**
 * The passages a reference standard quotes, joined as one block of language:
 * what "Convert to rules" seeds the acceptable tier's ideal wording with.
 *
 * A passage carries an id, not words: the text lives in the matter the
 * reference belongs to. One whose words this reader did not receive
 * contributes nothing, so the conversion can only write language already on
 * screen into the playbook.
 */
export const referencePassagesText = (
  passages: readonly ReferencePassage[],
  textById: ReadonlyMap<string, string>,
): string => {
  const quoted: string[] = [];
  for (const passage of passages) {
    const text = textById.get(passage.id)?.trim() ?? "";
    if (text.length > 0) {
      quoted.push(text);
    }
  }
  return quoted.join("\n\n");
};

const textContent = (): PositionAskContent => ({ version: 1, type: "text" });

export const newGradedPosition = (): GradedPosition => ({
  mode: "graded",
  sourceId: crypto.randomUUID(),
  issue: "",
  severity: "medium",
  standard: emptyTieredStandard(),
  ask: { mode: "auto" },
  enabled: true,
});

export const newExtractPosition = (): ExtractPosition => ({
  mode: "extract",
  sourceId: crypto.randomUUID(),
  issue: "",
  ask: { question: "", content: textContent() },
  enabled: true,
});

// ── Mode conversion (explicit, no silent data loss) ───

const gradedAskToManual = (ask: GradedAskConfig): AskManual => {
  if (ask.mode === "manual") {
    return { question: ask.question, content: ask.content };
  }
  if (ask.derived) {
    return { question: ask.derived.question, content: ask.derived.content };
  }
  return { question: "", content: textContent() };
};

// graded → extract drops the standard + grading; the caller confirms first
// when the standard carries content. The authored ask is preserved: a manual
// ask carries straight over, an auto ask keeps its derived question/content
// when present.
export const gradedToExtract = (position: GradedPosition): ExtractPosition => {
  const ask = gradedAskToManual(position.ask);
  return {
    mode: "extract",
    sourceId: position.sourceId,
    issue: position.issue,
    ask,
    ...(position.guidance !== undefined ? { guidance: position.guidance } : {}),
    enabled: position.enabled,
  };
};

// extract → graded is lossless (extract has no standard): the authored ask
// survives as a manual override so the derived-question path never silently
// discards it.
export const extractToGraded = (position: ExtractPosition): GradedPosition => ({
  mode: "graded",
  sourceId: position.sourceId,
  issue: position.issue,
  severity: "medium",
  standard: emptyTieredStandard(),
  ask: {
    mode: "manual",
    question: position.ask.question,
    content: position.ask.content,
  },
  ...(position.guidance !== undefined ? { guidance: position.guidance } : {}),
  enabled: position.enabled,
});

// ── Deep duplicate ────────────────────────────────────
// A duplicated position needs a fresh sourceId and fresh rule/entry ids so it is
// a distinct materialized column/finding target, never an alias of the original.
// Named (non-map-arrow) helpers so the id refresh does not spread the mapped
// element inside the `map` callback (oxc/no-map-spread).
const withFreshRuleId = (rule: TierRule): TierRule => ({
  id: crypto.randomUUID(),
  text: rule.text,
});

const withFreshEntryId = (entry: FallbackEntry): FallbackEntry =>
  entry.label !== undefined
    ? { id: crypto.randomUUID(), text: entry.text, label: entry.label }
    : { id: crypto.randomUUID(), text: entry.text };

// A reference standard's passages carry no client-generated ids (they are
// pinned provenance, not editable rows), so a copy shares them verbatim.
const duplicateStandard = (standard: PositionStandard): PositionStandard => {
  if (standard.source === "reference") {
    return standard;
  }
  const { tiers } = standard;
  return {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: tiers.acceptable.rules.map(withFreshRuleId),
        ...(tiers.acceptable.ideal !== undefined
          ? { ideal: tiers.acceptable.ideal }
          : {}),
      },
      fallback: { entries: tiers.fallback.entries.map(withFreshEntryId) },
      notAcceptable: { rules: tiers.notAcceptable.rules.map(withFreshRuleId) },
    },
  };
};

export const duplicatePosition = (position: Position): Position => {
  if (position.mode === "extract") {
    return { ...position, sourceId: crypto.randomUUID() };
  }
  return {
    ...position,
    sourceId: crypto.randomUUID(),
    standard: duplicateStandard(position.standard),
  };
};

// ── Reorder ───────────────────────────────────────────
// Bounds-checked adjacent swap: returns a new array with item[index] moved one
// slot up/down, or null when the move would fall off either end so callers can
// skip the state update entirely (no spurious re-render / dirty flag).
export const moveAdjacent = <T>(
  items: readonly T[],
  index: number,
  direction: "up" | "down",
): T[] | null => {
  const target = direction === "up" ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= items.length) {
    return null;
  }
  const next = items.slice();
  const current = next[index];
  const swap = next[target];
  if (current === undefined || swap === undefined) {
    return null;
  }
  next[index] = swap;
  next[target] = current;
  return next;
};

// ── Validation (mirrors positions-validation.ts, surfaced inline) ──

export type PositionErrors = {
  issue?: "required";
  content?: "gradedNeedsContent";
  clause?: "required";
};

const gradedHasContent = (position: GradedPosition): boolean => {
  if (position.check !== undefined) {
    return true;
  }
  const tiers = positionTiers(position);
  // A reference standard is content by construction: the schema requires at
  // least one quoted passage, and that passage IS the standard.
  if (tiers === null) {
    return true;
  }
  return (
    tiers.acceptable.rules.some((rule) => rule.text.trim().length > 0) ||
    tiers.notAcceptable.rules.some((rule) => rule.text.trim().length > 0) ||
    tiers.fallback.entries.some((entry) => entry.text.trim().length > 0) ||
    hasUsableIdeal(tiers.acceptable.ideal)
  );
};

const hasUsableIdeal = (ideal: IdealLanguage | undefined): boolean => {
  if (ideal === undefined) {
    return false;
  }
  if (ideal.source === "clause") {
    return ideal.clauseId.length > 0;
  }
  return ideal.text.trim().length > 0;
};

export const validatePosition = (position: Position): PositionErrors => {
  const errors: PositionErrors = {};
  if (position.issue.trim().length === 0) {
    errors.issue = "required";
  }
  if (position.mode !== "graded") {
    return errors;
  }
  const clauseIdeal = positionTiers(position)?.acceptable.ideal;
  if (clauseIdeal?.source === "clause" && clauseIdeal.clauseId.length === 0) {
    errors.clause = "required";
  }
  if (!gradedHasContent(position)) {
    errors.content = "gradedNeedsContent";
  }
  return errors;
};

export const hasErrors = (errors: PositionErrors): boolean =>
  errors.issue !== undefined ||
  errors.content !== undefined ||
  errors.clause !== undefined;

// ── Save-time normalization ───────────────────────────
// Trim the issue, drop blank rule/entry rows (server requires minLength 1) and
// an empty inline ideal, returning a fresh position so editor state is never
// mutated in place.
export const normalizePosition = (position: Position): Position => {
  const issue = position.issue.trim();
  if (position.mode === "extract") {
    return {
      ...position,
      issue,
      ask: {
        ...position.ask,
        question: position.ask.question.trim(),
        content: normalizeContent(position.ask.content),
      },
    };
  }

  const { standard, negotiation: rawNegotiation, ...rest } = position;
  const negotiation = normalizeNegotiation(rawNegotiation);
  return {
    ...rest,
    issue,
    standard: normalizeStandard(standard),
    ask:
      position.ask.mode === "manual"
        ? {
            mode: "manual",
            question: position.ask.question.trim(),
            content: normalizeContent(position.ask.content),
          }
        : position.ask,
    ...(negotiation !== undefined ? { negotiation } : {}),
  };
};

// Reference passages are pinned quotes, not editable rows: there is nothing to
// trim or drop, so only a tier ladder is normalized.
const normalizeStandard = (standard: PositionStandard): PositionStandard => {
  if (standard.source === "reference") {
    return standard;
  }
  const { tiers } = standard;
  const ideal = tiers.acceptable.ideal;
  const keepIdeal = hasUsableIdeal(ideal);
  return {
    source: "tiers",
    tiers: {
      acceptable: {
        rules: cleanRules(tiers.acceptable.rules),
        ...(keepIdeal && ideal !== undefined ? { ideal } : {}),
      },
      fallback: { entries: cleanEntries(tiers.fallback.entries) },
      notAcceptable: { rules: cleanRules(tiers.notAcceptable.rules) },
    },
  };
};

// Trim rationale/escalation, drop blank talking points (server requires
// minLength 1), and drop the whole facet when every field ends up empty so an
// untouched "Negotiation" section never round-trips as `{}`.
const normalizeNegotiation = (
  negotiation: Negotiation | undefined,
): Negotiation | undefined => {
  if (negotiation === undefined) {
    return undefined;
  }
  const rationale = negotiation.rationale?.trim();
  const rawTalkingPoints = negotiation.talkingPoints;
  let talkingPoints: string[] | undefined;
  if (rawTalkingPoints !== undefined) {
    talkingPoints = [];
    for (const point of rawTalkingPoints) {
      const trimmedPoint = point.trim();
      if (trimmedPoint.length > 0) {
        talkingPoints.push(trimmedPoint);
      }
    }
  }
  const escalation = negotiation.escalation?.trim();

  const next: Negotiation = {
    ...(rationale !== undefined && rationale.length > 0 ? { rationale } : {}),
    ...(talkingPoints !== undefined && talkingPoints.length > 0
      ? { talkingPoints }
      : {}),
    ...(escalation !== undefined && escalation.length > 0
      ? { escalation }
      : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
};

const cleanRules = (rules: readonly TierRule[]): TierRule[] => {
  const result: TierRule[] = [];
  for (const rule of rules) {
    const text = rule.text.trim();
    if (text.length > 0) {
      result.push({ id: rule.id, text });
    }
  }
  return result;
};

const trimmedEntry = (entry: FallbackEntry): FallbackEntry => {
  const label = entry.label?.trim();
  return label !== undefined && label.length > 0
    ? { id: entry.id, text: entry.text.trim(), label }
    : { id: entry.id, text: entry.text.trim() };
};

const cleanEntries = (entries: readonly FallbackEntry[]): FallbackEntry[] => {
  const result: FallbackEntry[] = [];
  for (const entry of entries) {
    if (entry.text.trim().length > 0) {
      result.push(trimmedEntry(entry));
    }
  }
  return result;
};

const normalizeContent = (content: PositionAskContent): PositionAskContent => {
  if (content.type !== "single-select" && content.type !== "multi-select") {
    return content;
  }
  return {
    ...content,
    options: content.options.filter((option) => option.value.trim().length > 0),
  };
};
