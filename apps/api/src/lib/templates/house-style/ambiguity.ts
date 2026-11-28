// The decisions the rules leave open, as questions made of ids and enumerated
// options, and the checked answers to them. Whoever answers (a model, a
// person, the rule below) picks among the options given: an answer is never
// text and never an id the question did not offer, so nothing an answerer
// says can put words into the document or point a reference at a block the
// detector did not find.

import { panic } from "better-result";

import type { DetectedReference } from "@/api/lib/templates/house-style/reference-detector";
import type {
  HouseStyleRole,
  RoleProposal,
} from "@/api/lib/templates/house-style/role-proposer";

export type AmbiguityItem =
  | {
      id: string;
      kind: "referenceScope";
      blockId: string;
      options: readonly ["internal", "external"];
    }
  | {
      id: string;
      kind: "referenceTarget";
      blockId: string;
      candidates: { targetBlockId: string; confidence: number }[];
    }
  | {
      id: string;
      kind: "blockRole";
      blockId: string;
      options: { role: HouseStyleRole; confidence: number }[];
    };

/** `choice` is one of the item's options: a scope, a target block id or a
 *  role. `null` leaves the item open; the plan then takes the safe path. */
type AmbiguityDecision = { id: string; choice: string | null };

/** The model step. It is given items and returns decisions, nothing else. */
export type AmbiguityResolver = (
  items: readonly AmbiguityItem[],
) => Promise<AmbiguityDecision[]>;

/** Below this the rules' reading of a block is a guess between near
 *  readings: a line at the boundary of two zones, text under a provision that
 *  may or may not continue it. */
const ROLE_REVIEW_BELOW = 0.7;
const ROLE_OPTIONS_MAX = 4;
/** Readings offered from the blocks around a doubtful one, and plain text:
 *  less likely than the rules' own alternatives. */
const NEIGHBOUR_CONFIDENCE = 0.2;
const PLAIN_CONFIDENCE = 0.1;
const TARGET_CONFIDENCE_MIN = 0.6;
const TARGET_MARGIN_MIN = 0.2;

export const scopeItemId = (referenceId: string): string =>
  `scope:${referenceId}`;

export const targetItemId = (
  referenceId: string,
  designatorIndex: number,
): string => `target:${referenceId}:${String(designatorIndex)}`;

export const roleItemId = (blockId: string): string => `role:${blockId}`;

/**
 * The readings offered for a doubtful block: the rules' reading and their
 * alternatives, then the readings of the blocks before and after it, then
 * plain text. Most doubtful readings put a line on the wrong side of a
 * boundary (the title and the parties, the parties and the recitals, a
 * provision and the text under it), and the reading of the other side is
 * that of a neighbour.
 */
const roleOptionsOf = (
  roles: readonly RoleProposal[],
  position: number,
): { role: HouseStyleRole; confidence: number }[] => {
  const proposal = roles[position];
  if (proposal === undefined) {
    return [];
  }
  const neighbours = [roles[position - 1], roles[position + 1]].flatMap(
    (neighbour) =>
      neighbour === undefined
        ? []
        : [{ role: neighbour.role, confidence: NEIGHBOUR_CONFIDENCE }],
  );
  const options: { role: HouseStyleRole; confidence: number }[] = [];
  for (const option of [
    { role: proposal.role, confidence: proposal.confidence },
    ...proposal.alternatives,
    ...neighbours,
    { role: "body" as const, confidence: PLAIN_CONFIDENCE },
  ]) {
    if (!options.some(({ role }) => role === option.role)) {
      options.push(option);
    }
  }
  return options.slice(0, ROLE_OPTIONS_MAX);
};

type CollectOptions = {
  references: readonly DetectedReference[];
  roles: readonly RoleProposal[];
};

/** Every open decision of one document, in document order per kind. */
export const collectAmbiguities = ({
  references,
  roles,
}: CollectOptions): AmbiguityItem[] => {
  const items: AmbiguityItem[] = [];
  for (const reference of references) {
    if (reference.scope === "unknown") {
      items.push({
        id: scopeItemId(reference.id),
        kind: "referenceScope",
        blockId: reference.blockId,
        options: ["internal", "external"],
      });
    }
    for (const [index, { resolution }] of reference.designators.entries()) {
      if (resolution.status === "ambiguous") {
        items.push({
          id: targetItemId(reference.id, index),
          kind: "referenceTarget",
          blockId: reference.blockId,
          candidates: resolution.candidates,
        });
      }
    }
  }
  for (const [position, { blockId, confidence }] of roles.entries()) {
    const options = roleOptionsOf(roles, position);
    if (confidence < ROLE_REVIEW_BELOW && options.length > 1) {
      items.push({
        id: roleItemId(blockId),
        kind: "blockRole",
        blockId,
        options,
      });
    }
  }
  return items;
};

const optionsOf = (item: AmbiguityItem): string[] => {
  switch (item.kind) {
    case "referenceScope":
      return [...item.options];
    case "referenceTarget":
      return item.candidates.map(({ targetBlockId }) => targetBlockId);
    case "blockRole":
      return item.options.map(({ role }) => role);
    default: {
      item satisfies never;
      return panic("Unhandled item");
    }
  }
};

/**
 * Keeps the decisions that answer an item with one of its options. Anything
 * else (an unknown id, an option that was not offered, a second answer to
 * one item) is dropped, and the item stays open.
 */
export const acceptDecisions = (
  items: readonly AmbiguityItem[],
  decisions: readonly AmbiguityDecision[],
): Map<string, string> => {
  const offered = new Map(items.map((item) => [item.id, optionsOf(item)]));
  const accepted = new Map<string, string>();
  for (const { id, choice } of decisions) {
    if (
      choice !== null &&
      !accepted.has(id) &&
      offered.get(id)?.includes(choice) === true
    ) {
      accepted.set(id, choice);
    }
  }
  return accepted;
};

/**
 * The resolver used where no model is wired: a reference with several
 * candidate targets takes the first only when it clearly leads; scopes and
 * roles stay as the rules read them.
 */
export const resolveAmbiguitiesByRule: AmbiguityResolver = async (items) =>
  // Nothing to wait for; the type is the model step's.
  await Promise.resolve(
    items.map((item): AmbiguityDecision => {
      if (item.kind !== "referenceTarget") {
        return { id: item.id, choice: null };
      }
      const [first, second] = item.candidates.toSorted(
        (left, right) => right.confidence - left.confidence,
      );
      const leads =
        first !== undefined &&
        first.confidence >= TARGET_CONFIDENCE_MIN &&
        (second === undefined ||
          first.confidence - second.confidence >= TARGET_MARGIN_MIN);
      return { id: item.id, choice: leads ? first.targetBlockId : null };
    }),
  );
