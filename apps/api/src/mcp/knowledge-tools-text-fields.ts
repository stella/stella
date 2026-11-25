import type { ClauseBody, ClauseRun } from "@/api/lib/clauses/types";
import type {
  Position,
  PositionStandard,
  Tiers,
} from "@/api/lib/workflow/playbook-positions";
import {
  defineTextFieldSpec,
  deriveTextFieldPaths,
} from "@/api/mcp/text-field-spec";
import type { McpTextFieldSpec } from "@/api/mcp/tool-types";

// --- Text-field specs (plan 049, Option B) --------------------------------
//
// Every anonymize-mode field below is organization-scoped: clauses and
// playbooks have no owning workspace, so `organizationId` is the
// anonymization scope everywhere. `organizationId` is not part of either
// served payload, so it is threaded in as a builder argument; the
// definitions below call these same builders with a placeholder id purely to
// derive the documented `textFields` path list — `deriveTextFieldPaths` only
// reads each spec's static `path`, never `scope`, so the placeholder never
// affects the declaration.

/**
 * Normalized read/write pair over one tenant-authored text unit. A clause
 * body paragraph's text and its optional inline runs' text both become one
 * unit apiece, so `clauseBodyTextFieldSpec` below can redact a whole body
 * (paragraphs + runs) as a single spec instead of re-deriving that shape at
 * every call site (clause body, clause variant bodies, standalone version
 * body).
 */
type TextUnit = {
  read: () => string | null | undefined;
  write: (value: string) => void;
};

/** A paragraph's inline runs, or an empty list when it has none. */
const clauseParagraphRuns = (
  paragraph: ClauseBody[number],
): readonly ClauseRun[] => {
  if (paragraph.runs === undefined) {
    return [];
  }
  return paragraph.runs;
};

const clauseBodyTextUnits = (body: ClauseBody): readonly TextUnit[] =>
  body.flatMap((paragraph): TextUnit[] => [
    {
      read: () => paragraph.text,
      write: (value) => {
        paragraph.text = value;
      },
    },
    ...clauseParagraphRuns(paragraph).map((run) => ({
      read: () => run.text,
      write: (value: string) => {
        run.text = value;
      },
    })),
  ]);

/**
 * One anonymize-mode spec over a whole `ClauseBody`, parameterized on the
 * `path` (`clause.body[].text` / `clause.variants[].body[].text` /
 * `version.body[].text`) and the `body` accessor for the branch's payload
 * shape. Every call site runs this only after its own `isClauseBody` guard
 * has passed (see the fail-closed control flow in `readClauseDetail`).
 */
export const clauseBodyTextFieldSpec = <TPayload>({
  body,
  organizationId,
  path,
}: {
  body: (payload: TPayload) => ClauseBody;
  organizationId: string;
  path: string;
}): McpTextFieldSpec<TPayload> =>
  defineTextFieldSpec({
    path,
    items: (payload: TPayload) => clauseBodyTextUnits(body(payload)),
    scope: () => organizationId,
    read: (unit: TextUnit) => unit.read(),
    apply: (unit: TextUnit, value) => {
      unit.write(value);
    },
  });

export const CLAUSE_BODY_TEXT_FIELD_PATH = "clause.body[].text";
export const CLAUSE_VARIANT_BODY_TEXT_FIELD_PATH =
  "clause.variants[].body[].text";
export const CLAUSE_VERSION_BODY_TEXT_FIELD_PATH = "version.body[].text";

// --- list_clauses ----------------------------------------------------------

type ClauseListItem = { title: string; description: string | null };
type ClauseCategoryItem = { name: string; description: string | null };

export const clauseListTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<{ clauses: readonly ClauseListItem[] }>[] => [
  defineTextFieldSpec({
    path: "clauses[].title",
    items: (payload) => payload.clauses,
    scope: () => organizationId,
    read: (item) => item.title,
    apply: (item, value) => {
      item.title = value;
    },
  }),
  defineTextFieldSpec({
    path: "clauses[].description",
    items: (payload) => payload.clauses,
    scope: () => organizationId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
];

export const categoryListTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<{
  categories: readonly ClauseCategoryItem[];
}>[] => [
  defineTextFieldSpec({
    path: "categories[].name",
    items: (payload) => payload.categories,
    scope: () => organizationId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "categories[].description",
    items: (payload) => payload.categories,
    scope: () => organizationId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
];

type ClauseCoreItem = {
  title: string;
  description: string | null;
  usageNotes: string | null;
};

/** Clause detail: title/description/usageNotes. Pushed unconditionally
 * before either `isClauseBody` guard in `readClauseDetail` runs — matching
 * the original handler, where these are pushed first and only discarded (via
 * the guard's early error return) if the body turns out malformed. */
export const clauseCoreTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<{ clause: ClauseCoreItem }>[] => [
  defineTextFieldSpec({
    path: "clause.title",
    items: (payload) => [payload.clause],
    scope: () => organizationId,
    read: (item) => item.title,
    apply: (item, value) => {
      item.title = value;
    },
  }),
  defineTextFieldSpec({
    path: "clause.description",
    items: (payload) => [payload.clause],
    scope: () => organizationId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
  defineTextFieldSpec({
    path: "clause.usageNotes",
    items: (payload) => [payload.clause],
    scope: () => organizationId,
    read: (item) => item.usageNotes,
    apply: (item, value) => {
      item.usageNotes = value;
    },
  }),
];

type ClauseVariantLabelItem = { label: string };

export const variantLabelTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<{ variant: ClauseVariantLabelItem }>[] => [
  defineTextFieldSpec({
    path: "clause.variants[].label",
    items: (payload) => [payload.variant],
    scope: () => organizationId,
    read: (item) => item.label,
    apply: (item, value) => {
      item.label = value;
    },
  }),
];

export const LIST_CLAUSES_TEXT_FIELD_PATHS = [
  ...deriveTextFieldPaths(clauseListTextFieldSpecs("")),
  ...deriveTextFieldPaths(categoryListTextFieldSpecs("")),
  ...deriveTextFieldPaths(clauseCoreTextFieldSpecs("")),
  CLAUSE_BODY_TEXT_FIELD_PATH,
  ...deriveTextFieldPaths(variantLabelTextFieldSpecs("")),
  CLAUSE_VARIANT_BODY_TEXT_FIELD_PATH,
  CLAUSE_VERSION_BODY_TEXT_FIELD_PATH,
];

// --- list_playbooks ---------------------------------------------------------

type PlaybookListItem = { name: string; description: string | null };

export const playbookListTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<{ items: readonly PlaybookListItem[] }>[] => [
  defineTextFieldSpec({
    path: "items[].name",
    items: (payload) => payload.items,
    scope: () => organizationId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "items[].description",
    items: (payload) => payload.items,
    scope: () => organizationId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
];

type GradedPosition = Extract<Position, { mode: "graded" }>;
type TierStandard = Extract<PositionStandard, { source: "tiers" }>;
type InlineIdeal = Extract<
  NonNullable<TierStandard["tiers"]["acceptable"]["ideal"]>,
  { source: "inline" }
>;

const gradedPositions = (
  positions: readonly Position[],
): readonly GradedPosition[] =>
  positions.flatMap((position) =>
    position.mode === "graded" ? [position] : [],
  );

// Only a tier standard carries authored prose. A reference standard's passages
// are quoted from a document the reader already has access to, and are
// redacted through the document's own path rather than the playbook's.
const tierLadders = (positions: readonly Position[]): readonly Tiers[] =>
  gradedPositions(positions).flatMap((position) =>
    position.standard.source === "tiers" ? [position.standard.tiers] : [],
  );

// Ask objects that carry a directly-authored question: every extract position
// and every graded position on the manual ask variant. The auto variant's
// derived question is redacted separately (`ask.derived.question`).
const manualAskItems = (
  positions: readonly Position[],
): readonly { question: string }[] =>
  positions.flatMap((position) => {
    if (position.mode === "extract") {
      return [position.ask];
    }
    return position.ask.mode === "manual" ? [position.ask] : [];
  });

const derivedAskItems = (
  positions: readonly Position[],
): readonly { question: string }[] =>
  gradedPositions(positions).flatMap((position) =>
    position.ask.mode === "auto" && position.ask.derived !== undefined
      ? [position.ask.derived]
      : [],
  );

const inlineIdealItems = (
  positions: readonly Position[],
): readonly InlineIdeal[] =>
  gradedPositions(positions).flatMap((position) => {
    if (position.standard.source !== "tiers") {
      return [];
    }
    const { ideal } = position.standard.tiers.acceptable;
    return ideal?.source === "inline" ? [ideal] : [];
  });

type NegotiationTextItem = {
  value: string | undefined;
  apply: (value: string) => void;
};

const negotiationScalarItems = (
  positions: readonly Position[],
  key: "escalation" | "rationale",
): readonly NegotiationTextItem[] =>
  gradedPositions(positions).flatMap((position) => {
    const negotiation = position.negotiation;
    if (negotiation === undefined) {
      return [];
    }

    return [
      {
        value: negotiation[key],
        apply: (value: string) => {
          negotiation[key] = value;
        },
      },
    ];
  });

const negotiationTalkingPointItems = (
  positions: readonly Position[],
): readonly NegotiationTextItem[] =>
  gradedPositions(positions).flatMap((position) => {
    const talkingPoints = position.negotiation?.talkingPoints;
    if (talkingPoints === undefined) {
      return [];
    }

    return talkingPoints.map((value, index) => ({
      value,
      apply: (next: string) => {
        talkingPoints[index] = next;
      },
    }));
  });

type PlaybookDetailPayload = {
  playbook: {
    name: string;
    description: string | null;
    positions: { items: readonly Position[] };
  };
};

/**
 * Every redactable field on one playbook detail response: the playbook's own
 * name/description, and per position its issue, purpose, guidance, and ask question
 * (the manual/extract question, or an auto position's derived question) —
 * plus, for a graded position, each tier rule (acceptable and not-acceptable
 * red lines), inline ideal language, and each fallback entry's text and label.
 * Deriving the declared `textFields` path list from these specs keeps the
 * documented paths and the runtime redaction in lockstep.
 */
export const playbookDetailTextFieldSpecs = (
  organizationId: string,
): readonly McpTextFieldSpec<PlaybookDetailPayload>[] => [
  defineTextFieldSpec({
    path: "playbook.name",
    items: (payload) => [payload.playbook],
    scope: () => organizationId,
    read: (item) => item.name,
    apply: (item, value) => {
      item.name = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.description",
    items: (payload) => [payload.playbook],
    scope: () => organizationId,
    read: (item) => item.description,
    apply: (item, value) => {
      item.description = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].issue",
    items: (payload) => payload.playbook.positions.items,
    scope: () => organizationId,
    read: (item) => item.issue,
    apply: (item, value) => {
      item.issue = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].ask.question",
    items: (payload) => manualAskItems(payload.playbook.positions.items),
    scope: () => organizationId,
    read: (item) => item.question,
    apply: (item, value) => {
      item.question = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].ask.derived.question",
    items: (payload) => derivedAskItems(payload.playbook.positions.items),
    scope: () => organizationId,
    read: (item) => item.question,
    apply: (item, value) => {
      item.question = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].purpose",
    items: (payload) => gradedPositions(payload.playbook.positions.items),
    scope: () => organizationId,
    read: (item) => item.purpose,
    apply: (item, value) => {
      item.purpose = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].guidance",
    items: (payload) => payload.playbook.positions.items,
    scope: () => organizationId,
    read: (item) => item.guidance,
    apply: (item, value) => {
      item.guidance = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].negotiation.rationale",
    items: (payload) =>
      negotiationScalarItems(payload.playbook.positions.items, "rationale"),
    scope: () => organizationId,
    read: (item) => item.value,
    apply: (item, value) => {
      item.apply(value);
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].negotiation.talkingPoints[]",
    items: (payload) =>
      negotiationTalkingPointItems(payload.playbook.positions.items),
    scope: () => organizationId,
    read: (item) => item.value,
    apply: (item, value) => {
      item.apply(value);
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].negotiation.escalation",
    items: (payload) =>
      negotiationScalarItems(payload.playbook.positions.items, "escalation"),
    scope: () => organizationId,
    read: (item) => item.value,
    apply: (item, value) => {
      item.apply(value);
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].standard.tiers.acceptable.rules[].text",
    items: (payload) =>
      tierLadders(payload.playbook.positions.items).flatMap(
        (tiers) => tiers.acceptable.rules,
      ),
    scope: () => organizationId,
    read: (item) => item.text,
    apply: (item, value) => {
      item.text = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].standard.tiers.acceptable.ideal.text",
    items: (payload) => inlineIdealItems(payload.playbook.positions.items),
    scope: () => organizationId,
    read: (item) => item.text,
    apply: (item, value) => {
      item.text = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].standard.tiers.fallback.entries[].text",
    items: (payload) =>
      tierLadders(payload.playbook.positions.items).flatMap(
        (tiers) => tiers.fallback.entries,
      ),
    scope: () => organizationId,
    read: (item) => item.text,
    apply: (item, value) => {
      item.text = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].standard.tiers.fallback.entries[].label",
    items: (payload) =>
      tierLadders(payload.playbook.positions.items).flatMap(
        (tiers) => tiers.fallback.entries,
      ),
    scope: () => organizationId,
    read: (item) => item.label,
    apply: (item, value) => {
      item.label = value;
    },
  }),
  defineTextFieldSpec({
    path: "playbook.positions.items[].standard.tiers.notAcceptable.rules[].text",
    items: (payload) =>
      tierLadders(payload.playbook.positions.items).flatMap(
        (tiers) => tiers.notAcceptable.rules,
      ),
    scope: () => organizationId,
    read: (item) => item.text,
    apply: (item, value) => {
      item.text = value;
    },
  }),
];
