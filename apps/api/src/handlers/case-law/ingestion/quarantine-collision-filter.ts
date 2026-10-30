import { panic } from "better-result";

import type { CompleteReconciliationScope } from "@/api/handlers/case-law/ingestion/slice-listing";
import type { IngestionResult } from "@/api/lib/legal-search/ingestion-types";
import { quarantinePeerCollisions } from "@/api/lib/legal-search/quarantine-identity";

export type CollisionFilterProof =
  CompleteReconciliationScope | { readonly type: "no-listing-proof" };

const collisionFilteredDecisionsBrand = Symbol("CollisionFilteredDecisions");

/** Only this owner can construct the decisions accepted by page apply paths. */
export type CollisionFilteredDecisions = {
  readonly [collisionFilteredDecisionsBrand]: true;
  readonly decisions: readonly IngestionResult[];
  readonly collidingIds: readonly string[];
};

type FilterQuarantinePeerCollisionsOptions = {
  decisions: readonly IngestionResult[];
  proof: CollisionFilterProof;
};

/** A captured peer remains a separate record; absent listing proof cannot authorize adoption. */
export const filterQuarantinePeerCollisions = ({
  decisions,
  proof,
}: FilterQuarantinePeerCollisionsOptions): CollisionFilteredDecisions => {
  switch (proof.type) {
    case "complete-scope": {
      const collidingIds = quarantinePeerCollisions([
        ...proof.listedIdentities.flatMap((identity) =>
          identity.type === "document"
            ? [{ sourceDocumentId: identity.sourceDocumentId }]
            : [],
        ),
        ...decisions.map((decision) => ({
          sourceDocumentId: decision.sourceDocumentId ?? "",
          quarantinePeers: decision.sourceDocumentIdRepairAliases,
        })),
      ]);
      const colliding = new Set(collidingIds);
      return {
        [collisionFilteredDecisionsBrand]: true,
        decisions:
          colliding.size === 0
            ? decisions
            : decisions.map((decision) => ({
                ...decision,
                sourceDocumentIdRepairAliases:
                  decision.sourceDocumentIdRepairAliases?.filter(
                    (alias) => !colliding.has(alias),
                  ),
              })),
        collidingIds,
      };
    }
    case "no-listing-proof":
      return {
        [collisionFilteredDecisionsBrand]: true,
        decisions: decisions.map((decision) => ({
          ...decision,
          sourceDocumentIdRepairAliases: [],
        })),
        collidingIds: [],
      };
    default: {
      proof satisfies never;
      return panic("Unknown listing proof");
    }
  }
};
