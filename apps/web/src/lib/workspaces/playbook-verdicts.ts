/**
 * Pairing a graded playbook position with its verdict.
 *
 * A graded position materialises two sibling properties: the ASK that holds the
 * extracted value, and a `playbook-verdict` that grades it and carries the
 * ASK's id in `askPropertyId`. They are one fact — "missing" says nothing
 * without the answer it was reached from — so no surface may list them as two
 * independent properties.
 *
 * That rule used to live as a comment next to the table's column builder, and
 * the inspector's metadata panel, written later, did not know about it: every
 * verdict rendered as a row of its own, stranded from the value it graded.
 * Deriving the pairing here makes the next surface inherit it instead of
 * rediscovering it, and `no-unpaired-playbook-verdict` keeps the discrimination
 * from being hand-rolled again.
 */
import type { PropertyId, WorkspaceProperty } from "@/lib/types";

const PLAYBOOK_VERDICT_TOOL = "playbook-verdict";

type PlaybookVerdictProperty = WorkspaceProperty & {
  tool: Extract<WorkspaceProperty["tool"], { type: "playbook-verdict" }>;
};

/**
 * A property whose tool a person can act on: everything except a verdict.
 *
 * `WorkspaceProperty` is one object with a union-typed `tool`, not a union of
 * objects, so narrowing away the verdict variant needs its own guard —
 * `!isPlaybookVerdictProperty(p)` leaves `tool` as wide as it started.
 */
type GradableProperty = WorkspaceProperty & {
  tool: Exclude<WorkspaceProperty["tool"], { type: "playbook-verdict" }>;
};

/** Whether this property is a verdict rather than something to list on its own. */
export const isPlaybookVerdictProperty = (
  property: WorkspaceProperty,
): property is PlaybookVerdictProperty =>
  property.tool.type === PLAYBOOK_VERDICT_TOOL;

/** The complement of {@link isPlaybookVerdictProperty}, narrowing `tool`. */
export const isGradableProperty = (
  property: WorkspaceProperty,
): property is GradableProperty => property.tool.type !== PLAYBOOK_VERDICT_TOOL;

export type PairedPlaybookProperty = {
  /** The property to render: never a verdict. */
  property: WorkspaceProperty;
  /** The verdict grading it, when the position is graded. */
  verdictProperty: WorkspaceProperty | undefined;
};

/**
 * Every property worth listing, each carrying the verdict that grades it.
 *
 * Verdicts are removed from the list rather than filtered by the caller, so a
 * surface that simply maps the result cannot render one on its own by omission.
 * Input order is preserved: callers rely on the workspace's column order.
 */
export const pairPlaybookVerdicts = (
  properties: readonly WorkspaceProperty[],
): PairedPlaybookProperty[] => {
  const verdictByAskId = new Map<PropertyId, WorkspaceProperty>();
  for (const property of properties) {
    if (isPlaybookVerdictProperty(property)) {
      verdictByAskId.set(property.tool.askPropertyId, property);
    }
  }

  return properties.flatMap((property) =>
    isPlaybookVerdictProperty(property)
      ? []
      : [{ property, verdictProperty: verdictByAskId.get(property.id) }],
  );
};

/**
 * The verdict grading each ASK property, keyed by the ASK's id.
 *
 * For callers that already hold their own property list and need only the
 * lookup — the pairing rule still comes from one place.
 */
export const playbookVerdictByAskId = (
  properties: readonly WorkspaceProperty[],
): ReadonlyMap<PropertyId, WorkspaceProperty> => {
  const byAskId = new Map<PropertyId, WorkspaceProperty>();
  for (const property of properties) {
    if (isPlaybookVerdictProperty(property)) {
      byAskId.set(property.tool.askPropertyId, property);
    }
  }
  return byAskId;
};
