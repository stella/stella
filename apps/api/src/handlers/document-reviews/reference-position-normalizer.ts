/**
 * What the model proposed, held to what the documents actually say.
 *
 * One normalizer serves both proposal paths. The non-streaming handler feeds
 * it the finished object; the streaming handler feeds it each array element as
 * that element closes. Both hand it the same values in the same order, so both
 * produce the same events — a position confirmed from the stream and the same
 * position read from the batch response cannot differ.
 *
 * The rules it enforces, in the order it applies them:
 *   - a position may only quote text the reference actually contains, because
 *     that quoted text is what the run grades against;
 *   - one issue is proposed once, and never one the reviewer already has;
 *   - `blocker` is reserved for a stated quantity;
 *   - a `parameter` whose passages state nothing but a calendar date or a
 *     blank is not a comparable term at all, and is reported as skipped
 *     rather than proposed.
 */

import * as v from "valibot";

import type { SafeId } from "@/api/lib/branded-types";
import {
  REVIEW_PARTIES_MAX,
  REVIEW_PARTY_NAME_MAX_LENGTH,
  REVIEW_PARTY_ROLE_MAX_LENGTH,
  REVIEW_SKIP_REASON_MAX_LENGTH,
  REVIEW_SKIP_SUBJECT_MAX_LENGTH,
  REVIEW_SKIPPED_MAX,
} from "@/api/lib/document-review/contract";
import type {
  ReviewParty,
  ReviewSkippedTerm,
  ReviewSkipReason,
} from "@/api/lib/document-review/contract";
import type { PreparedDocxFile } from "@/api/lib/workflow/generate-batch";
import {
  POSITION_PURPOSE_MAX_LENGTH,
  POSITION_SEVERITIES,
  POSITION_TERM_KINDS,
} from "@/api/lib/workflow/playbook-positions";
import type {
  Position,
  PositionSeverity,
  PositionTermKind,
  ReferencePassage,
} from "@/api/lib/workflow/playbook-positions";

/** Matches `positionStandardSchema`'s `passages` bound. A position that needs
 *  more than this to state its standard is not one term. */
const PASSAGES_PER_POSITION_MAX = 12;
const ISSUE_MAX_LENGTH = 256;
const GUIDANCE_MAX_LENGTH = 2000;

/** Why a proposed term was turned into a skip instead of a position: the value
 *  it quotes belongs to one deal, so no second document can be measured
 *  against it. */
export const DEAL_SPECIFIC_VALUE_SKIP_REASON = "deal-specific value";

/** Why a subject was never a term to begin with: it is a difference in how the
 *  two documents are built, not something either of them states. */
export const STRUCTURAL_SKIP_REASON = "structural";

/**
 * The reason phrases the prompt itself hands the model, read back as codes.
 *
 * Both paths meet here: the skip this module decides on its own, and the same
 * phrase echoed back by a model doing what the prompt asked. A reason the
 * model wrote itself stays text — it follows the document's language, and no
 * catalog of ours would render it any better.
 */
const CODED_SKIP_REASONS: Record<string, ReviewSkipReason> = {
  [DEAL_SPECIFIC_VALUE_SKIP_REASON]: { kind: "deal-specific-value" },
  [STRUCTURAL_SKIP_REASON]: { kind: "structural" },
};

export const codeSkipReason = (text: string): ReviewSkipReason =>
  CODED_SKIP_REASONS[text.toLocaleLowerCase("und")] ?? { kind: "other", text };

export const proposedPositionSchema = v.strictObject({
  /** What shape of term this is. Decides how the comparison is expressed and
   *  edited, so it is chosen here, once, rather than per grading. Engine-only:
   *  the prompt forbids naming it in any text a reviewer reads. */
  termKind: v.picklist(POSITION_TERM_KINDS),
  issue: v.pipe(v.string(), v.minLength(1), v.maxLength(ISSUE_MAX_LENGTH)),
  /** The legal and economic function of the term in this kind of deal, from
   *  the side the review takes. What `guidance` never says: why anyone
   *  negotiates this at all. */
  purpose: v.pipe(v.string(), v.maxLength(POSITION_PURPOSE_MAX_LENGTH)),
  /** What the later comparison should examine — the comparable attribute and
   *  the reference's stance on it — and why the severity is what it is;
   *  becomes the position's reviewer guidance. */
  guidance: v.pipe(v.string(), v.maxLength(GUIDANCE_MAX_LENGTH)),
  severity: v.picklist(POSITION_SEVERITIES),
  passages: v.array(
    v.strictObject({ sourceKey: v.string(), blockId: v.string() }),
  ),
});

export const skippedTermSchema = v.strictObject({
  subject: v.pipe(v.string(), v.maxLength(REVIEW_SKIP_SUBJECT_MAX_LENGTH)),
  reason: v.pipe(v.string(), v.maxLength(REVIEW_SKIP_REASON_MAX_LENGTH)),
});

// No transforms here: the schema is handed to the provider as JSON Schema,
// which cannot express them. Whitespace is normalized by this module instead.
export const proposedPartySchema = v.strictObject({
  role: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(REVIEW_PARTY_ROLE_MAX_LENGTH),
  ),
  name: v.nullable(
    v.pipe(v.string(), v.maxLength(REVIEW_PARTY_NAME_MAX_LENGTH)),
  ),
});

/**
 * Field order is the wire order the provider emits, and time to the first
 * position is what it buys: the sides come out before the checklist, and what
 * was deliberately left out comes after it. Severity ordering within
 * `positions` is asked for in the prompt.
 */
export const proposedPositionsSchema = v.strictObject({
  // The target's parties, so the lawyer can say which one they act for.
  parties: v.array(proposedPartySchema),
  // Cardinality is normalized below. Providers do not reliably honor JSON
  // Schema array limits, so excess suggestions stay recoverable.
  positions: v.array(proposedPositionSchema),
  // What was read and deliberately not compared.
  skipped: v.array(skippedTermSchema),
});

export type ProposedPosition = v.InferOutput<typeof proposedPositionSchema>;
export type ProposedParty = v.InferOutput<typeof proposedPartySchema>;
export type ProposedSkippedTerm = v.InferOutput<typeof skippedTermSchema>;
export type ProposedPositions = v.InferOutput<typeof proposedPositionsSchema>;

/** Where a prepared reference document came from, so a verified block can be
 *  pinned as a passage that outlives this request. */
export type ReferenceSource = {
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  entityVersionId: SafeId<"entityVersion">;
  file: PreparedDocxFile;
};

/**
 * Severity, held to what the term can carry. `blocker` is the walk-away tier,
 * and only a stated quantity — money, a liability cap, a time bar — walks a
 * deal away on its own. A protection or a wording standard may still be `high`,
 * but calling every clause a blocker is what turns a review into a list nobody
 * can triage.
 */
export const cappedSeverity = (
  severity: PositionSeverity,
  termKind: PositionTermKind,
): PositionSeverity =>
  severity === "blocker" && termKind !== "parameter" ? "high" : severity;

// ── Deal-specific values ──────────────────────────────
//
// A date and a blank are the two things that look like a value and still
// cannot be compared: "27 August 2026" and "[●]" name one deal, not a term.
// A locked-box date is not a position; the locked-box PERIOD is.

/** A blank the deal fills in: `[●]`, `[•]`, `[__]`, `[insert date]`. */
const PLACEHOLDER_PATTERN = /\[[^\]\n]{0,24}\]/gu;

/**
 * A calendar date in the forms a contract states one: ISO, day-first with dots
 * or slashes, and a spelled month on either side of the day. Detection keys on
 * the four-digit year rather than a month-name list, because the month word is
 * in whatever language the document is written in.
 */
const CALENDAR_DATE_PATTERN =
  /\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\s*[./]\s*\d{1,2}\s*[./]\s*\d{4}\b|\b\d{1,2}\.?\s+\p{L}+\s+\d{4}\b|\b\p{L}+\s+\d{1,2},?\s+\d{4}\b/gu;

const DIGIT_PATTERN = /\p{Nd}/u;

/**
 * Whether a passage states something a second document can be measured
 * against.
 *
 * Only a passage that carried a date or a blank can fail: strip those, and if
 * every digit went with them, the passage stated a particular of this deal and
 * nothing else. A passage with no date and no blank is left alone, because a
 * term stated in words ("six months") is still a term.
 */
export const statesComparableValue = (text: string): boolean => {
  const stripped = text
    .replaceAll(CALENDAR_DATE_PATTERN, " ")
    .replaceAll(PLACEHOLDER_PATTERN, " ");
  return stripped === text || DIGIT_PATTERN.test(stripped);
};

// ── Passage verification ──────────────────────────────

type SourceIndex = ReadonlyMap<
  string,
  { source: ReferenceSource; blocks: ReadonlyMap<string, string> }
>;

const indexSources = (sources: readonly ReferenceSource[]): SourceIndex =>
  new Map(
    sources.map((source) => [
      source.file.simplifiedName,
      {
        source,
        blocks: new Map(
          source.file.blocks.map((block) => [block.id, block.text]),
        ),
      },
    ]),
  );

/**
 * Verify the proposed passages against the documents they claim to quote. A
 * passage the reference does not contain is dropped, and a position left with
 * none is dropped with it: a standard nobody can quote is not a standard.
 */
const verifyPassages = (
  proposed: readonly ProposedPosition["passages"][number][],
  sources: SourceIndex,
): ReferencePassage[] => {
  const seen = new Set<string>();
  const passages: ReferencePassage[] = [];
  for (const { sourceKey, blockId } of proposed) {
    const entry = sources.get(sourceKey);
    const text = entry?.blocks.get(blockId);
    if (entry === undefined || text === undefined || text.trim().length === 0) {
      continue;
    }
    const key = `${entry.source.entityVersionId}:${blockId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    passages.push({
      workspaceId: entry.source.workspaceId,
      entityId: entry.source.entityId,
      fileFieldId: entry.source.file.fileFieldId,
      entityVersionId: entry.source.entityVersionId,
      blockId,
      text,
    });
    if (passages.length === PASSAGES_PER_POSITION_MAX) {
      break;
    }
  }
  return passages;
};

const normalizeIssue = (value: string): string =>
  value.trim().toLocaleLowerCase("und");

// ── The normalizer ────────────────────────────────────

/**
 * One decided piece of the proposal. `index` counts per event kind and rises
 * by one per emitted event, so a client assembling the list from the stream
 * can order and de-duplicate without holding the whole response.
 */
export type ReviewProposalEvent =
  | { type: "parties"; parties: ReviewParty[] }
  | { type: "position"; index: number; position: Position }
  | { type: "skipped"; index: number; skipped: ReviewSkippedTerm };

export type ProposalNormalizer = {
  /** The target's sides. Accepted once; later calls report nothing. */
  parties: (proposed: readonly ProposedParty[]) => ReviewProposalEvent[];
  /** One proposed term: a position, a skip (a deal-specific value), or
   *  nothing (unquotable, repeated, or past the cap). */
  position: (proposed: ProposedPosition) => ReviewProposalEvent[];
  /** One term the model itself declined to compare. */
  skipped: (proposed: ProposedSkippedTerm) => ReviewProposalEvent[];
};

export type ProposalNormalizerArgs = {
  seededPositions: readonly Position[];
  sources: readonly ReferenceSource[];
  positionsMax: number;
  /** The stable id a position keeps for the rest of its life: findings,
   *  decisions and any playbook saved out of the run are keyed by it. Supplied
   *  by the caller so this module stays replayable — the same model output
   *  normalizes the same way twice. */
  newSourceId: () => string;
};

export const createProposalNormalizer = ({
  seededPositions,
  sources,
  positionsMax,
  newSourceId,
}: ProposalNormalizerArgs): ProposalNormalizer => {
  const index = indexSources(sources);
  const seenIssues = new Set(
    seededPositions.map((position) => normalizeIssue(position.issue)),
  );
  const seenSubjects = new Set<string>();
  const counts = {
    parties: 0,
    // Seeded positions occupy the cap: the reviewer keeps what they had.
    positions: seededPositions.length,
    emittedPositions: 0,
    skipped: 0,
  };

  const skip = (
    subject: string,
    reason: ReviewSkipReason,
  ): ReviewProposalEvent[] => {
    if (counts.skipped >= REVIEW_SKIPPED_MAX || subject.length === 0) {
      return [];
    }
    const key = subject.toLocaleLowerCase("und");
    if (seenSubjects.has(key)) {
      return [];
    }
    seenSubjects.add(key);
    const emitted = counts.skipped;
    counts.skipped += 1;
    return [{ type: "skipped", index: emitted, skipped: { subject, reason } }];
  };

  return {
    parties: (proposed) => {
      if (counts.parties > 0) {
        return [];
      }
      counts.parties = 1;
      const parties: ReviewParty[] = [];
      for (const party of proposed.slice(0, REVIEW_PARTIES_MAX)) {
        const role = party.role.trim();
        if (role.length === 0) {
          continue;
        }
        const name = party.name?.trim() ?? "";
        parties.push({ role, name: name.length === 0 ? null : name });
      }
      return [{ type: "parties", parties }];
    },

    position: (proposed) => {
      if (counts.positions >= positionsMax) {
        return [];
      }
      const issue = proposed.issue.trim();
      const normalized = normalizeIssue(issue);
      if (normalized.length === 0 || seenIssues.has(normalized)) {
        return [];
      }
      const passages = verifyPassages(proposed.passages, index);
      if (passages.length === 0) {
        return [];
      }
      // Decided either way: the issue does not come back for a second verdict.
      seenIssues.add(normalized);

      // A quantity nobody can measure a second document against is a
      // particular of this deal, not a term. The prompt asks for the derived
      // term instead (a period rather than either of its two dates); this is
      // what catches the ask being ignored.
      if (
        proposed.termKind === "parameter" &&
        !passages.some((passage) => statesComparableValue(passage.text))
      ) {
        return skip(issue, { kind: "deal-specific-value" });
      }

      const purpose = proposed.purpose.trim();
      const guidance = proposed.guidance.trim();
      counts.positions += 1;
      const emitted = counts.emittedPositions;
      counts.emittedPositions += 1;
      return [
        {
          type: "position",
          index: emitted,
          position: {
            mode: "graded",
            sourceId: newSourceId(),
            issue,
            severity: cappedSeverity(proposed.severity, proposed.termKind),
            standard: {
              source: "reference",
              termKind: proposed.termKind,
              passages,
            },
            // A reference-standard position is compared against the document's
            // own blocks and never extracts a value, so there is no question
            // to derive.
            ask: { mode: "auto" },
            ...(purpose.length === 0 ? {} : { purpose }),
            ...(guidance.length === 0 ? {} : { guidance }),
            enabled: true,
          },
        },
      ];
    },

    skipped: (proposed) => {
      const reason = proposed.reason.trim();
      // A subject with no reason is half a statement; the count it would add
      // says nothing the reviewer can act on.
      return reason.length === 0
        ? []
        : skip(proposed.subject.trim(), codeSkipReason(reason));
    },
  };
};

/** What the proposal pass hands back: the plan to confirm, what it left
 *  uncompared, and the sides the lawyer can act for. */
export type ReviewPositionProposal = {
  positions: Position[];
  skipped: ReviewSkippedTerm[];
  parties: ReviewParty[];
};

/**
 * The whole response, decided in the wire order the stream decides it in, so
 * the batch path and the streaming path cannot drift apart. Seeded positions
 * lead the list: the reviewer keeps what they already had.
 */
export const normalizeProposal = ({
  output,
  ...args
}: ProposalNormalizerArgs & {
  output: ProposedPositions;
}): ReviewPositionProposal => {
  const { seededPositions } = args;
  const normalizer = createProposalNormalizer(args);
  const proposal: ReviewPositionProposal = {
    positions: [...seededPositions],
    skipped: [],
    parties: [],
  };
  const apply = (events: readonly ReviewProposalEvent[]): void => {
    for (const event of events) {
      switch (event.type) {
        case "parties":
          proposal.parties = event.parties;
          break;
        case "position":
          proposal.positions.push(event.position);
          break;
        case "skipped":
          proposal.skipped.push(event.skipped);
          break;
        default:
          event satisfies never;
      }
    }
  };

  apply(normalizer.parties(output.parties));
  for (const position of output.positions) {
    apply(normalizer.position(position));
  }
  for (const skipped of output.skipped) {
    apply(normalizer.skipped(skipped));
  }
  return proposal;
};

// ── Reading an unfinished response ────────────────────

/**
 * The partial object, read as what it is: a best-effort parse of an unfinished
 * JSON document. Only the three top-level arrays are looked at, and only their
 * shape is trusted here — every element is validated against the real schema
 * before it reaches the normalizer.
 */
const partialProposalSchema = v.looseObject({
  parties: v.optional(v.unknown()),
  positions: v.optional(v.unknown()),
  skipped: v.optional(v.unknown()),
});

const readArray = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

/**
 * Turns successive partial parses of one response into events, exactly once
 * each.
 *
 * An element is closed when a later sibling has started, when the following
 * top-level key has appeared, or when the run finished; at that point its bytes
 * are all there and validating it means something. The last element of a
 * growing array is deliberately held back — half a position validates as
 * nothing useful, and emitting it would put a term on the reviewer's screen
 * that the model was still writing.
 *
 * Because the reader only ever advances, and the normalizer behind it decides
 * each element once, feeding it the finished object at the end is safe: it
 * reports whatever the partials never reached, and nothing twice.
 */
export const createPartialProposalReader = (
  normalizer: ProposalNormalizer,
): ((value: unknown, final: boolean) => ReviewProposalEvent[]) => {
  const cursors = { positions: 0, skipped: 0, parties: false };

  const drain = <TItem>(
    raw: readonly unknown[],
    closed: number,
    cursor: "positions" | "skipped",
    schema: v.GenericSchema<TItem>,
    accept: (item: TItem) => ReviewProposalEvent[],
  ): ReviewProposalEvent[] => {
    const events: ReviewProposalEvent[] = [];
    while (cursors[cursor] < closed) {
      const parsed = v.safeParse(schema, raw[cursors[cursor]]);
      cursors[cursor] += 1;
      if (parsed.success) {
        events.push(...accept(parsed.output));
      }
    }
    return events;
  };

  return (value, final) => {
    const parsed = v.safeParse(partialProposalSchema, value);
    if (!parsed.success) {
      return [];
    }
    const { parties, positions, skipped } = parsed.output;
    const events: ReviewProposalEvent[] = [];

    if (!cursors.parties && (final || positions !== undefined)) {
      cursors.parties = true;
      const sides: ProposedParty[] = [];
      for (const party of readArray(parties)) {
        const side = v.safeParse(proposedPartySchema, party);
        if (side.success) {
          sides.push(side.output);
        }
      }
      events.push(...normalizer.parties(sides));
    }

    const rawPositions = readArray(positions);
    events.push(
      ...drain(
        rawPositions,
        final || skipped !== undefined
          ? rawPositions.length
          : rawPositions.length - 1,
        "positions",
        proposedPositionSchema,
        normalizer.position,
      ),
    );

    const rawSkipped = readArray(skipped);
    events.push(
      ...drain(
        rawSkipped,
        final ? rawSkipped.length : rawSkipped.length - 1,
        "skipped",
        skippedTermSchema,
        normalizer.skipped,
      ),
    );
    return events;
  };
};
