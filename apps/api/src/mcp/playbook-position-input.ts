/**
 * Snake_case MCP surface for `save_playbook`'s `positions` entries, and the
 * merge that lays them over a stored playbook.
 *
 * The input carries what `list_playbooks` returns, minus everything the server
 * owns (tier rule and fallback entry ids, the derived ask, the deterministic
 * `check`), and flatter: the ladder is `tiers`, lifted out of `standard`. The
 * CLI refuses a tool list whose schema nests deeper than `MAX_SCHEMA_DEPTH`
 * (`packages/cli/src/registry-trust.ts`), and installed CLIs cannot be told to
 * accept more, so the stored `standard.tiers.acceptable.rules[].text` nesting
 * does not fit under `positions[]`. A call names only the positions it adds or changes,
 * so the merge never touches a stored position the call does not address.
 */

import * as v from "valibot";

import {
  POSITION_LIMITS,
  POSITION_PURPOSE_MAX_LENGTH,
  POSITION_SEVERITIES,
} from "@/api/lib/workflow/playbook-positions";
import type {
  FallbackEntry,
  IdealLanguage,
  Position,
  Tiers,
  TierRule,
} from "@/api/lib/workflow/playbook-positions";
import { uuidInputSchema } from "@/api/mcp/tool-utils";

/** Answer types an AI ask can extract that need no further configuration. */
export const PLAYBOOK_ANSWER_TYPES = ["text", "date", "int"] as const;
type PlaybookAnswerType = (typeof PLAYBOOK_ANSWER_TYPES)[number];

const REFERENCE_STANDARD_REFUSAL =
  "A reference standard is pinned to a source document and cannot be " +
  "written by save_playbook; edit that position in the playbook editor.";

const boundedText = (maxLength: number, description: string) =>
  v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(maxLength),
    v.description(description),
  );

// An optional text a model has nothing to say in arrives as "" as often as it
// is left out. Both mean absent, so neither is refused.
const optionalText = (maxLength: number, description: string) =>
  v.optional(
    v.pipe(v.string(), v.maxLength(maxLength), v.description(description)),
  );

const presentText = (text: string | undefined): string | undefined =>
  text === undefined || text.trim().length === 0 ? undefined : text;

// Every tier is a list of `{ text }`, the shape a read returns. With rules as
// bare strings beside fallback objects, a small model put each in the other.
const tierRulesInput = (description: string) =>
  v.pipe(
    v.array(
      v.strictObject({
        text: boundedText(POSITION_LIMITS.tierRuleTextMaxLength, "One rule"),
      }),
    ),
    v.maxLength(POSITION_LIMITS.tierRulesMaxItems),
    v.description(description),
  );

const positionCommonInput = {
  source_id: v.optional(
    uuidInputSchema(
      "sourceId of the stored position to replace; omit to add a position",
    ),
  ),
  issue: boundedText(
    POSITION_LIMITS.issueMaxLength,
    "Short name of the term under review; unique within the playbook",
  ),
  guidance: optionalText(
    POSITION_LIMITS.guidanceMaxLength,
    "What a reviewer examines in the clause",
  ),
  enabled: v.optional(
    v.pipe(
      v.boolean(),
      v.description("false skips the position in runs; defaults to true"),
    ),
  ),
};

const extractPositionInput = v.strictObject({
  mode: v.pipe(
    v.literal("extract"),
    v.description("Captures a value from each document; no grading"),
  ),
  ...positionCommonInput,
  ask: v.strictObject({
    question: boundedText(
      POSITION_LIMITS.askQuestionMaxLength,
      "Question answered from each document",
    ),
    answer_type: v.optional(
      v.pipe(
        v.picklist(PLAYBOOK_ANSWER_TYPES),
        v.description(
          "Defaults to text; omit on a replace to keep the stored type",
        ),
      ),
    ),
  }),
});

const gradedPositionInput = v.strictObject({
  mode: v.pipe(
    v.literal("graded"),
    v.description(
      "Grades each document's clause against tiers. Its question is derived " +
        "from them, so it takes no ask",
    ),
  ),
  ...positionCommonInput,
  severity: v.pipe(
    v.picklist(POSITION_SEVERITIES),
    v.description("Weight of a deviation; blocker is a walk-away term"),
  ),
  purpose: optionalText(
    POSITION_PURPOSE_MAX_LENGTH,
    "One sentence on what the term is for, from the reviewing side",
  ),
  tiers: v.pipe(
    v.strictObject({
      acceptable: v.optional(
        tierRulesInput("What an acceptable clause provides"),
      ),
      ideal: optionalText(
        POSITION_LIMITS.languageTextMaxLength,
        "Preferred wording, inserted when a document deviates",
      ),
      fallback: v.optional(
        v.pipe(
          v.array(
            v.strictObject({
              text: boundedText(
                POSITION_LIMITS.languageTextMaxLength,
                "Accepted alternative wording",
              ),
              label: optionalText(
                POSITION_LIMITS.fallbackLabelMaxLength,
                "Short name for the alternative",
              ),
            }),
          ),
          v.maxLength(POSITION_LIMITS.fallbackEntriesMaxItems),
          v.description("Accepted alternatives, best first"),
        ),
      ),
      not_acceptable: v.optional(tierRulesInput("Red lines")),
    }),
    v.description(
      "The grading ladder; a tier left out is empty, and at least one rule, fallback entry, or ideal is required",
    ),
  ),
  negotiation: v.optional(
    v.strictObject({
      rationale: optionalText(
        POSITION_LIMITS.rationaleMaxLength,
        "Why the organization holds this position",
      ),
      talking_points: v.optional(
        v.pipe(
          v.array(
            boundedText(POSITION_LIMITS.talkingPointMaxLength, "One point"),
          ),
          v.maxLength(POSITION_LIMITS.talkingPointsMaxItems),
          v.description("What to say to the counterparty"),
        ),
      ),
      escalation: optionalText(
        POSITION_LIMITS.escalationMaxLength,
        "Who decides a deviation, and when to route it to them",
      ),
    }),
  ),
});

export const playbookPositionInputSchema = v.variant("mode", [
  extractPositionInput,
  gradedPositionInput,
]);
export type PlaybookPositionInput = v.InferOutput<
  typeof playbookPositionInputSchema
>;

type GradedPosition = Extract<Position, { mode: "graded" }>;
type ExtractPosition = Extract<Position, { mode: "extract" }>;

/** Closed set: each is a next step the tool's error hint spells out. */
export type PlaybookMergeIssueCode =
  | "unknown_source_id"
  | "duplicate_source_id"
  | "duplicate_issue"
  | "reference_standard"
  | "mode_change"
  | "too_many_positions";

export type PlaybookMergeIssue = {
  code: PlaybookMergeIssueCode;
  path: string;
  message: string;
};

export type MergePlaybookPositionsArgs = {
  stored: readonly Position[];
  positions: readonly PlaybookPositionInput[];
  removeSourceIds: readonly string[];
  /** Injected so the merge is a pure function of its arguments in tests. */
  mintId: () => string;
};

type WrittenPlaybookPosition = {
  sourceId: string;
  issue: string;
  change: "added" | "changed";
};

/**
 * Best effort per entry: a refused position is reported in `issues` and the
 * rest of the call still applies, so one forgotten `source_id` does not cost a
 * model the positions it got right.
 */
export type MergePlaybookPositionsResult = {
  items: Position[];
  written: WrittenPlaybookPosition[];
  removedSourceIds: string[];
  issues: PlaybookMergeIssue[];
};

// Case and surrounding space never distinguish two issues to a reader, so a
// forgotten `source_id` cannot slip a duplicate past on "Liability Cap".
const issueKey = (issue: string): string => issue.trim().toLowerCase();

/**
 * Keep the stored id of every line whose text is unchanged, so a finding that
 * cites a red line still names it after a neighbouring rule is reworded. A
 * stored id is claimed once: two identical texts get two distinct ids.
 */
const withStableIds = <TLine extends { text: string }>({
  lines,
  storedLines,
  mintId,
}: {
  lines: readonly TLine[];
  /** Absent when the position is new: every line is then minted. */
  storedLines: readonly { id: string; text: string }[] | undefined;
  mintId: () => string;
}): (TLine & { id: string })[] => {
  const unclaimed = storedLines === undefined ? [] : [...storedLines];
  return lines.map((line) => {
    const index = unclaimed.findIndex((stored) => stored.text === line.text);
    if (index === -1) {
      return { ...line, id: mintId() };
    }
    const [claimed] = unclaimed.splice(index, 1);
    return { ...line, id: claimed?.id ?? mintId() };
  });
};

const contentForAnswerType = (
  type: PlaybookAnswerType,
): ExtractPosition["ask"]["content"] => ({ version: 1, type });

const toExtractPosition = ({
  input,
  sourceId,
  stored,
}: {
  input: Extract<PlaybookPositionInput, { mode: "extract" }>;
  sourceId: string;
  stored: ExtractPosition | undefined;
}): ExtractPosition => {
  const guidance = presentText(input.guidance);
  return {
    mode: "extract",
    sourceId,
    issue: input.issue,
    ask: {
      question: input.ask.question,
      content:
        input.ask.answer_type === undefined
          ? (stored?.ask.content ?? contentForAnswerType("text"))
          : contentForAnswerType(input.ask.answer_type),
    },
    ...(guidance === undefined ? {} : { guidance }),
    enabled: input.enabled ?? true,
  };
};

// Two models in the authoring eval left an empty tier out instead of sending
// `[]`. Absence has one meaning here, so it is read, not refused.
const ruleLines = (
  rules: readonly { text: string }[] | undefined,
): { text: string }[] => (rules === undefined ? [] : [...rules]);

const fallbackLines = (
  entries: readonly { text: string; label?: string | undefined }[] | undefined,
): { text: string; label?: string }[] =>
  entries === undefined
    ? []
    : entries.map((entry) => {
        const label = presentText(entry.label);
        return { text: entry.text, ...(label === undefined ? {} : { label }) };
      });

/**
 * The input writes inline ideal language only. A stored clause link is a
 * deliberate library binding the model cannot express, so omitting `ideal`
 * keeps it; an inline ideal it could see is replaced like any other field.
 */
const resolveIdeal = ({
  input,
  storedTiers,
}: {
  input: string | undefined;
  storedTiers: Tiers | undefined;
}): IdealLanguage | undefined => {
  if (input !== undefined) {
    return { source: "inline", text: input };
  }
  const stored = storedTiers?.acceptable.ideal;
  return stored?.source === "clause" ? stored : undefined;
};

const toGradedPosition = ({
  input,
  sourceId,
  stored,
  mintId,
}: {
  input: Extract<PlaybookPositionInput, { mode: "graded" }>;
  sourceId: string;
  stored: GradedPosition | undefined;
  mintId: () => string;
}): GradedPosition => {
  const storedTiers =
    stored?.standard.source === "tiers" ? stored.standard.tiers : undefined;
  const { tiers } = input;
  const ideal = resolveIdeal({
    input: presentText(tiers.ideal),
    storedTiers,
  });
  const { negotiation } = input;
  const purpose = presentText(input.purpose);
  const guidance = presentText(input.guidance);
  const rationale = presentText(negotiation?.rationale);
  const escalation = presentText(negotiation?.escalation);

  return {
    mode: "graded",
    sourceId,
    issue: input.issue,
    severity: input.severity,
    standard: {
      source: "tiers",
      tiers: {
        acceptable: {
          rules: withStableIds<{ text: string }>({
            lines: ruleLines(tiers.acceptable),
            storedLines: storedTiers?.acceptable.rules,
            mintId,
          }) satisfies TierRule[],
          ...(ideal === undefined ? {} : { ideal }),
        },
        fallback: {
          entries: withStableIds<{ text: string; label?: string }>({
            lines: fallbackLines(tiers.fallback),
            storedLines: storedTiers?.fallback.entries,
            mintId,
          }) satisfies FallbackEntry[],
        },
        notAcceptable: {
          rules: withStableIds<{ text: string }>({
            lines: ruleLines(tiers.not_acceptable),
            storedLines: storedTiers?.notAcceptable.rules,
            mintId,
          }) satisfies TierRule[],
        },
      },
    },
    // Server-owned: the deterministic check and the ask are not in the input.
    // The stored ask carries its `derived` question, which `deriveAutoAsks`
    // reuses while the rules hash still matches.
    ...(stored?.check === undefined ? {} : { check: stored.check }),
    ask: stored?.ask ?? { mode: "auto" },
    ...(purpose === undefined ? {} : { purpose }),
    ...(guidance === undefined ? {} : { guidance }),
    ...(negotiation === undefined
      ? {}
      : {
          negotiation: {
            ...(rationale === undefined ? {} : { rationale }),
            ...(negotiation.talking_points === undefined
              ? {}
              : { talkingPoints: negotiation.talking_points }),
            ...(escalation === undefined ? {} : { escalation }),
          },
        }),
    enabled: input.enabled ?? true,
  };
};

/**
 * Lay a call's positions over the stored ones. A position with a `source_id`
 * replaces the stored position in place; one without is appended under a
 * minted id. Every stored position the call does not name comes back as the
 * same object, untouched.
 *
 * Entries apply one at a time against the playbook as it stands at that
 * entry, removals first. The working list therefore never holds two positions
 * with one issue, whichever entries of the call were refused.
 */
export const mergePlaybookPositions = ({
  stored,
  positions,
  removeSourceIds,
  mintId,
}: MergePlaybookPositionsArgs): MergePlaybookPositionsResult => {
  const issues: PlaybookMergeIssue[] = [];
  const removedSourceIds: string[] = [];
  let items = [...stored];

  for (const [index, sourceId] of removeSourceIds.entries()) {
    if (!items.some((position) => position.sourceId === sourceId)) {
      issues.push({
        code: "unknown_source_id",
        path: `remove_source_ids.${index}`,
        message: `No stored position has sourceId ${sourceId}`,
      });
      continue;
    }
    items = items.filter((position) => position.sourceId !== sourceId);
    removedSourceIds.push(sourceId);
  }

  const written: WrittenPlaybookPosition[] = [];

  for (const [index, input] of positions.entries()) {
    const path = `positions.${index}`;
    const storedPosition =
      input.source_id === undefined
        ? undefined
        : items.find((position) => position.sourceId === input.source_id);

    if (input.source_id !== undefined) {
      if (storedPosition === undefined) {
        issues.push({
          code: "unknown_source_id",
          path: `${path}.source_id`,
          message: `No stored position has sourceId ${input.source_id}`,
        });
        continue;
      }
      if (written.some(({ sourceId }) => sourceId === input.source_id)) {
        issues.push({
          code: "duplicate_source_id",
          path: `${path}.source_id`,
          message: `sourceId ${input.source_id} appears twice in this call`,
        });
        continue;
      }
    }

    const owner = items.find(
      (position) =>
        position.sourceId !== input.source_id &&
        issueKey(position.issue) === issueKey(input.issue),
    );
    if (owner !== undefined) {
      issues.push({
        code: "duplicate_issue",
        path: `${path}.issue`,
        message: `A position named "${owner.issue}" already exists with sourceId ${owner.sourceId}`,
      });
      continue;
    }

    if (storedPosition !== undefined && storedPosition.mode !== input.mode) {
      issues.push({
        code: "mode_change",
        path: `${path}.mode`,
        message: `The stored position is ${storedPosition.mode}, not ${input.mode}`,
      });
      continue;
    }
    if (
      storedPosition?.mode === "graded" &&
      storedPosition.standard.source === "reference"
    ) {
      issues.push({
        code: "reference_standard",
        path: `${path}.source_id`,
        message: REFERENCE_STANDARD_REFUSAL,
      });
      continue;
    }
    if (
      storedPosition === undefined &&
      items.length >= POSITION_LIMITS.positionsMaxItems
    ) {
      issues.push({
        code: "too_many_positions",
        path,
        message: `A playbook holds at most ${POSITION_LIMITS.positionsMaxItems} positions`,
      });
      continue;
    }

    const sourceId = input.source_id ?? mintId();
    const position =
      input.mode === "extract"
        ? toExtractPosition({
            input,
            sourceId,
            stored:
              storedPosition?.mode === "extract" ? storedPosition : undefined,
          })
        : toGradedPosition({
            input,
            sourceId,
            stored:
              storedPosition?.mode === "graded" ? storedPosition : undefined,
            mintId,
          });

    written.push({
      sourceId,
      issue: input.issue,
      change: storedPosition === undefined ? "added" : "changed",
    });
    if (storedPosition === undefined) {
      items.push(position);
    } else {
      items[items.indexOf(storedPosition)] = position;
    }
  }

  return { items, written, removedSourceIds, issues };
};
