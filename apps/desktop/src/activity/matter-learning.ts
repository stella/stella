import { panic } from "better-result";

import { normalizeUnicode } from "@stll/text-normalize";

/**
 * The member's own matter rules and what this computer learned from their
 * confirmed entries. Everything here names matters by id only: a name comes
 * from a read under the member's current access, never from this state, and
 * nothing here leaves the machine. Pure: the clock is an argument.
 */

export const MATTER_RULE_FIELDS = ["title", "documentPath", "app"] as const;
export type MatterRuleField = (typeof MATTER_RULE_FIELDS)[number];
export const MATTER_RULE_OPS = ["contains", "startsWith"] as const;
export type MatterRuleOp = (typeof MATTER_RULE_OPS)[number];

/** Bounds shared with the native store, which refuses anything larger. */
export const MATTER_LEARNING_LIMITS = {
  rules: 200,
  learned: 5000,
  tallies: 500,
  value: 512,
  token: 128,
} as const;

/** "Always file windows whose `field` `op` `value` under `matterId`." */
export type MatterRule = {
  id: string;
  field: MatterRuleField;
  op: MatterRuleOp;
  value: string;
  matterId: string;
};

/** One token's weight toward one matter, as of `atMs`; it halves every
 * {@link LEARNED_HALF_LIFE_MS} after that. */
export type LearnedAssociation = {
  token: string;
  matterId: string;
  weight: number;
  atMs: number;
};

export const TALLY_STATUSES = ["counting", "declined"] as const;
/** How often one piece of evidence was confirmed under one matter: the
 * second confirmation proposes a rule, unless the member declined it. */
export type EvidenceTally = Omit<MatterRule, "id"> & {
  count: number;
  status: (typeof TALLY_STATUSES)[number];
};

export type MatterLearning = {
  rules: MatterRule[];
  learned: LearnedAssociation[];
  tallies: EvidenceTally[];
};

export const EMPTY_MATTER_LEARNING: MatterLearning = {
  rules: [],
  learned: [],
  tallies: [],
};

const DAY_MS = 24 * 60 * 60 * 1000;
export const LEARNED_HALF_LIFE_MS = 30 * DAY_MS;
/** A correction keeps a quarter of the wrong pair's weight. */
export const CORRECTION_FACTOR = 0.25;
/** Below this a learned weight says nothing and is dropped. */
const FORGOTTEN_WEIGHT = 0.05;
/** A learned matter needs this much distinctive weight to be suggested… */
const LEARNED_MIN_SCORE = 1.5;
/** …and this many times the next matter's. */
const LEARNED_MIN_LEAD = 2;
/** Confirmations of one piece of evidence before a rule is proposed. */
export const RULE_PROPOSAL_CONFIRMATIONS = 2;
const MIN_TOKEN_GRAPHEMES = 3;

/** What one stretch of activity showed: the evidence rules and learning
 * read. The document path is the full local path. */
export type SegmentEvidence = {
  app: string;
  title: string | null;
  documentPath: string | null;
};

const normalized = (text: string) =>
  normalizeUnicode(text, "NFKC").toLowerCase();

/** Word tokens of `text`, normalized for comparison. */
export const matchTokens = (text: string) =>
  normalized(text).match(/[\p{L}\p{N}]+/gu) ?? [];

/** Either platform's separators, so a rule written on one path form matches
 * the other. */
const normalizedPath = (path: string) => normalized(path).replaceAll("\\", "/");

const fieldValue = (evidence: SegmentEvidence, field: MatterRuleField) => {
  switch (field) {
    case "title":
      return evidence.title === null ? null : normalized(evidence.title);
    case "documentPath":
      return evidence.documentPath === null
        ? null
        : normalizedPath(evidence.documentPath);
    case "app":
      return normalized(evidence.app);
    default:
      field satisfies never;
      return panic("Unknown matter rule field");
  }
};

const ruleValue = ({ field, value }: Pick<MatterRule, "field" | "value">) =>
  field === "documentPath" ? normalizedPath(value) : normalized(value);

export const ruleMatches = (
  rule: Pick<MatterRule, "field" | "op" | "value">,
  evidence: SegmentEvidence,
) => {
  const value = ruleValue(rule);
  const seen = fieldValue(evidence, rule.field);
  if (seen === null || value.trim().length === 0) {
    return false;
  }
  switch (rule.op) {
    case "contains":
      return seen.includes(value);
    case "startsWith":
      return seen.startsWith(value);
    default:
      rule.op satisfies never;
      return panic("Unknown matter rule operator");
  }
};

/**
 * The rule that files this evidence, among rules whose matter `isOpen`: the
 * most specific (longest value) one. Rules of the same specificity that
 * disagree file nothing, so a rule never guesses between matters.
 */
export const matchingRule = (
  rules: readonly MatterRule[],
  evidence: SegmentEvidence,
  isOpen: (matterId: string) => boolean,
): MatterRule | null => {
  let best: MatterRule[] = [];
  let bestLength = -1;
  for (const rule of rules) {
    if (!isOpen(rule.matterId) || !ruleMatches(rule, evidence)) {
      continue;
    }
    const length = ruleValue(rule).length;
    if (length > bestLength) {
      best = [rule];
      bestLength = length;
    } else if (length === bestLength) {
      best.push(rule);
    }
  }
  const [first] = best;
  return first !== undefined &&
    best.every(({ matterId }) => matterId === first.matterId)
    ? first
    : null;
};

/** A learned weight decayed to `nowMs`; never grows with time. */
export const decayedWeight = (
  { weight, atMs }: Pick<LearnedAssociation, "weight" | "atMs">,
  nowMs: number,
) => weight * 0.5 ** (Math.max(0, nowMs - atMs) / LEARNED_HALF_LIFE_MS);

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const isDistinctiveToken = (token: string) =>
  Array.from(graphemes.segment(token)).length >= MIN_TOKEN_GRAPHEMES &&
  token.length <= MATTER_LEARNING_LIMITS.token;

/** The tokens learning reads from some evidence: the title's words and the
 * document path's folder and file names, each once. The app is left out:
 * one app serves every matter. */
export const evidenceTokens = (evidence: readonly SegmentEvidence[]) => [
  ...new Set(
    evidence
      .flatMap(({ title, documentPath }) => [
        ...matchTokens(title ?? ""),
        ...matchTokens(documentPath ?? ""),
      ])
      .filter(isDistinctiveToken),
  ),
];

export type LearnedMatch = {
  matterId: string;
  /** The token that contributed most, for the reason line. */
  token: string;
};

type LearnedMatterOptions = {
  tokens: readonly string[];
  learned: readonly LearnedAssociation[];
  isOpen: (matterId: string) => boolean;
  nowMs: number;
};
/**
 * The matter the learned weights point to, if one clearly leads. Each
 * token's weight counts by how much of that token's total weight its matter
 * holds, so a token seen under every matter says little. The leader must be
 * a matter the member can open: losing access to it never promotes the
 * runner-up.
 */
export const learnedMatter = ({
  tokens,
  learned,
  isOpen,
  nowMs,
}: LearnedMatterOptions): LearnedMatch | null => {
  const wanted = new Set(tokens);
  const byToken = new Map<string, Map<string, number>>();
  for (const association of learned) {
    if (!wanted.has(association.token)) {
      continue;
    }
    const matters = byToken.get(association.token) ?? new Map<string, number>();
    matters.set(
      association.matterId,
      (matters.get(association.matterId) ?? 0) +
        decayedWeight(association, nowMs),
    );
    byToken.set(association.token, matters);
  }
  const scores = new Map<
    string,
    { score: number; token: string; top: number }
  >();
  for (const [token, matters] of byToken) {
    let total = 0;
    for (const weight of matters.values()) {
      total += weight;
    }
    for (const [matterId, weight] of matters) {
      if (total === 0) {
        continue;
      }
      const contribution = (weight * weight) / total;
      const current = scores.get(matterId) ?? { score: 0, token, top: 0 };
      scores.set(matterId, {
        score: current.score + contribution,
        token: contribution > current.top ? token : current.token,
        top: Math.max(current.top, contribution),
      });
    }
  }
  const ranked = [...scores]
    .map(([matterId, { score, token }]) => ({ matterId, score, token }))
    .sort(
      (left, right) =>
        right.score - left.score || left.matterId.localeCompare(right.matterId),
    );
  const [first, second] = ranked;
  if (
    first === undefined ||
    first.score < LEARNED_MIN_SCORE ||
    (second !== undefined && first.score < second.score * LEARNED_MIN_LEAD) ||
    !isOpen(first.matterId)
  ) {
    return null;
  }
  return { matterId: first.matterId, token: first.token };
};

/** The rule a piece of evidence would become: a document's folder, or a
 * window's title. */
const proposedRules = (
  evidence: SegmentEvidence,
): Omit<MatterRule, "id" | "matterId">[] => {
  if (evidence.documentPath !== null) {
    const path = evidence.documentPath.replaceAll("\\", "/");
    const folder = path.slice(0, path.lastIndexOf("/") + 1);
    return folder.length > 1 && folder.length <= MATTER_LEARNING_LIMITS.value
      ? [{ field: "documentPath", op: "startsWith", value: folder }]
      : [];
  }
  const title = evidence.title?.trim() ?? "";
  return title.length > 0 &&
    title.length <= MATTER_LEARNING_LIMITS.value &&
    matchTokens(title).some(isDistinctiveToken) &&
    normalized(title) !== normalized(evidence.app)
    ? [{ field: "title", op: "contains", value: title }]
    : [];
};

const sameRule = (
  left: Pick<MatterRule, "field" | "op" | "value">,
  right: Pick<MatterRule, "field" | "op" | "value">,
) =>
  left.field === right.field &&
  left.op === right.op &&
  ruleValue(left) === ruleValue(right);

export type Confirmation = {
  evidence: readonly SegmentEvidence[];
  /** The matter the member confirmed. */
  matterId: string;
  /** The matter the review suggested, when it suggested one. */
  suggestedMatterId: string | null;
  nowMs: number;
};

/** Keeps the heaviest rows within the store's bound and drops forgotten ones. */
const pruned = (learned: LearnedAssociation[], nowMs: number) =>
  learned
    .filter(
      (association) => decayedWeight(association, nowMs) >= FORGOTTEN_WEIGHT,
    )
    .sort(
      (left, right) =>
        decayedWeight(right, nowMs) - decayedWeight(left, nowMs) ||
        left.token.localeCompare(right.token) ||
        left.matterId.localeCompare(right.matterId),
    )
    .slice(0, MATTER_LEARNING_LIMITS.learned);

/**
 * Learns from one confirmed entry: its evidence's tokens count toward the
 * confirmed matter; when the member chose another matter than the one
 * suggested, the suggested pair keeps only {@link CORRECTION_FACTOR} of its
 * weight. Each piece of evidence also counts toward proposing a rule.
 */
export const learn = (
  learning: MatterLearning,
  { evidence, matterId, suggestedMatterId, nowMs }: Confirmation,
): MatterLearning => {
  const tokens = new Set(evidenceTokens(evidence));
  const corrected =
    suggestedMatterId !== null && suggestedMatterId !== matterId
      ? suggestedMatterId
      : null;
  const learned: LearnedAssociation[] = [];
  const credited = new Set<string>();
  for (const association of learning.learned) {
    if (!tokens.has(association.token)) {
      learned.push(association);
      continue;
    }
    const weight = decayedWeight(association, nowMs);
    if (association.matterId === matterId) {
      credited.add(association.token);
      learned.push({ ...association, weight: weight + 1, atMs: nowMs });
    } else if (association.matterId === corrected) {
      learned.push({
        ...association,
        weight: weight * CORRECTION_FACTOR,
        atMs: nowMs,
      });
    } else {
      learned.push(association);
    }
  }
  for (const token of tokens) {
    if (!credited.has(token)) {
      learned.push({ token, matterId, weight: 1, atMs: nowMs });
    }
  }
  const tallies = [...learning.tallies];
  const counted: Omit<MatterRule, "id" | "matterId">[] = [];
  for (const proposed of evidence.flatMap(proposedRules)) {
    if (
      counted.some((rule) => sameRule(rule, proposed)) ||
      learning.rules.some((rule) => sameRule(rule, proposed))
    ) {
      continue;
    }
    counted.push(proposed);
    const index = tallies.findIndex(
      (tally) => tally.matterId === matterId && sameRule(tally, proposed),
    );
    const tally = tallies[index];
    if (tally === undefined) {
      tallies.push({ ...proposed, matterId, count: 1, status: "counting" });
    } else {
      tallies[index] = {
        field: tally.field,
        op: tally.op,
        value: tally.value,
        matterId: tally.matterId,
        count: tally.count + 1,
        status: tally.status,
      };
    }
  }
  return {
    rules: learning.rules,
    learned: pruned(learned, nowMs),
    // The newest evidence stays when the bound is reached.
    tallies: tallies.slice(-MATTER_LEARNING_LIMITS.tallies),
  };
};

/** Rules worth proposing: evidence confirmed under one matter often enough,
 * not declined and not already a rule; the most confirmed first. */
export const ruleProposals = (learning: MatterLearning) =>
  learning.tallies
    .filter(
      (tally) =>
        tally.status === "counting" &&
        tally.count >= RULE_PROPOSAL_CONFIRMATIONS &&
        !learning.rules.some((rule) => sameRule(rule, tally)),
    )
    .sort((left, right) => right.count - left.count);

/** The proposal becomes a rule; its tally is done. */
export const acceptProposal = (
  learning: MatterLearning,
  proposal: EvidenceTally,
  id: string,
): MatterLearning => ({
  rules: [
    ...learning.rules,
    {
      id,
      field: proposal.field,
      op: proposal.op,
      value: proposal.value,
      matterId: proposal.matterId,
    },
  ].slice(-MATTER_LEARNING_LIMITS.rules),
  learned: learning.learned,
  tallies: learning.tallies.filter((tally) => !sameRule(tally, proposal)),
});

/** The member said no: the evidence keeps counting toward nothing. */
export const declineProposal = (
  learning: MatterLearning,
  proposal: EvidenceTally,
): MatterLearning => ({
  rules: learning.rules,
  learned: learning.learned,
  tallies: learning.tallies.map((tally) =>
    tally.matterId === proposal.matterId && sameRule(tally, proposal)
      ? {
          field: tally.field,
          op: tally.op,
          value: tally.value,
          matterId: tally.matterId,
          count: tally.count,
          status: "declined",
        }
      : tally,
  ),
});

/** Learned rows and tallies for matters the member can no longer open are
 * forgotten. Rules stay, the member's own words, until the member removes
 * them; they file nothing while their matter is unavailable. */
export const forgetMatters = (
  learning: MatterLearning,
  matterIds: ReadonlySet<string>,
): MatterLearning => ({
  rules: learning.rules,
  learned: learning.learned.filter(({ matterId }) => !matterIds.has(matterId)),
  tallies: learning.tallies.filter(({ matterId }) => !matterIds.has(matterId)),
});

type SuggestedMatterIdsOptions = {
  evidence: readonly SegmentEvidence[];
  learning: MatterLearning;
  nowMs: number;
};
/** Every matter a rule or the learned weights would suggest for some
 * evidence, whatever the member's access: the ids to resolve before any of
 * them may be suggested. */
export const suggestedMatterIds = ({
  evidence,
  learning,
  nowMs,
}: SuggestedMatterIdsOptions) => {
  const ids = new Set<string>();
  const anyMatter = () => true;
  for (const piece of evidence) {
    for (const rule of learning.rules) {
      if (ruleMatches(rule, piece)) {
        ids.add(rule.matterId);
      }
    }
    const learned = learnedMatter({
      tokens: evidenceTokens([piece]),
      learned: learning.learned,
      isOpen: anyMatter,
      nowMs,
    });
    if (learned !== null) {
      ids.add(learned.matterId);
    }
  }
  return [...ids];
};
