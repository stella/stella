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

const ROLE_REVIEW_BELOW = 0.5;
const TARGET_CONFIDENCE_MIN = 0.6;
const TARGET_MARGIN_MIN = 0.2;

export const scopeItemId = (referenceId: string): string =>
  `scope:${referenceId}`;

export const targetItemId = (
  referenceId: string,
  designatorIndex: number,
): string => `target:${referenceId}:${String(designatorIndex)}`;

export const roleItemId = (blockId: string): string => `role:${blockId}`;

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
  for (const { blockId, role, confidence, alternatives } of roles) {
    if (confidence < ROLE_REVIEW_BELOW && alternatives.length > 0) {
      items.push({
        id: roleItemId(blockId),
        kind: "blockRole",
        blockId,
        options: [{ role, confidence }, ...alternatives],
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
