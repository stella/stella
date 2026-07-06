import type { api } from "@/lib/api";

// All playbook position types are inferred from the Eden API surface so the
// editor's working state and save payload stay in lockstep with the backend
// `playbookPositionsSchema` (v2). Never hand-redefine the Position shape here.

type PlaybookDetailResponse = Awaited<
  ReturnType<ReturnType<typeof api.playbooks>["get"]>
>;

type PlaybookDetailData = Exclude<
  NonNullable<Extract<PlaybookDetailResponse, { data: unknown }>["data"]>,
  Response
>;

export type PlaybookPositionsValue = PlaybookDetailData["positions"];
export type Position = PlaybookPositionsValue["items"][number];

// Discriminated on `mode`; narrow to the concrete variant with `mode === "…"`.
export type GradedPosition = Extract<Position, { mode: "graded" }>;
export type ExtractPosition = Extract<Position, { mode: "extract" }>;

export type PositionSeverity = GradedPosition["severity"];
export type PositionTiers = GradedPosition["tiers"];
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

const textContent = (): PositionAskContent => ({ version: 1, type: "text" });

export const newGradedPosition = (): GradedPosition => ({
  mode: "graded",
  sourceId: crypto.randomUUID(),
  issue: "",
  severity: "medium",
  tiers: emptyTiers(),
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

// graded → extract drops the tier ladder + grading; the caller confirms first
// when tiers are non-empty. The authored ask is preserved: a manual ask carries
// straight over, an auto ask keeps its derived question/content when present.
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

// extract → graded is lossless (extract has no tiers): the authored ask survives
// as a manual override so the derived-question path never silently discards it.
export const extractToGraded = (position: ExtractPosition): GradedPosition => ({
  mode: "graded",
  sourceId: position.sourceId,
  issue: position.issue,
  severity: "medium",
  tiers: emptyTiers(),
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

export const duplicatePosition = (position: Position): Position => {
  if (position.mode === "extract") {
    return { ...position, sourceId: crypto.randomUUID() };
  }
  const { tiers } = position;
  return {
    ...position,
    sourceId: crypto.randomUUID(),
    tiers: {
      acceptable: {
        rules: tiers.acceptable.rules.map(withFreshRuleId),
        ...(tiers.acceptable.ideal !== undefined
          ? { ideal: tiers.acceptable.ideal }
          : {}),
      },
      fallback: {
        entries: tiers.fallback.entries.map(withFreshEntryId),
      },
      notAcceptable: {
        rules: tiers.notAcceptable.rules.map(withFreshRuleId),
      },
    },
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
  const { tiers } = position;
  return (
    tiers.acceptable.rules.some((rule) => rule.text.trim().length > 0) ||
    tiers.notAcceptable.rules.some((rule) => rule.text.trim().length > 0) ||
    tiers.fallback.entries.some((entry) => entry.text.trim().length > 0) ||
    hasUsableIdeal(position.tiers.acceptable.ideal)
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
  const clauseIdeal = position.tiers.acceptable.ideal;
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

  const { tiers, negotiation: rawNegotiation, ...rest } = position;
  const ideal = tiers.acceptable.ideal;
  const keepIdeal = hasUsableIdeal(ideal);
  const negotiation = normalizeNegotiation(rawNegotiation);
  return {
    ...rest,
    issue,
    tiers: {
      acceptable: {
        rules: cleanRules(tiers.acceptable.rules),
        ...(keepIdeal && ideal !== undefined ? { ideal } : {}),
      },
      fallback: { entries: cleanEntries(tiers.fallback.entries) },
      notAcceptable: { rules: cleanRules(tiers.notAcceptable.rules) },
    },
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
  const talkingPoints = negotiation.talkingPoints
    ?.map((point) => point.trim())
    .filter((point) => point.length > 0);
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

const cleanRules = (rules: readonly TierRule[]): TierRule[] =>
  rules
    .filter((rule) => rule.text.trim().length > 0)
    .map((rule) => ({ id: rule.id, text: rule.text.trim() }));

const trimmedEntry = (entry: FallbackEntry): FallbackEntry => {
  const label = entry.label?.trim();
  return label !== undefined && label.length > 0
    ? { id: entry.id, text: entry.text.trim(), label }
    : { id: entry.id, text: entry.text.trim() };
};

const cleanEntries = (entries: readonly FallbackEntry[]): FallbackEntry[] =>
  entries.filter((entry) => entry.text.trim().length > 0).map(trimmedEntry);

const normalizeContent = (content: PositionAskContent): PositionAskContent => {
  if (content.type !== "single-select" && content.type !== "multi-select") {
    return content;
  }
  return {
    ...content,
    options: content.options.filter((option) => option.value.trim().length > 0),
  };
};
