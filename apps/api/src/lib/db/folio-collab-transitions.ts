import { folioCollabRooms } from "@/api/db/schema";
import { FOLIO_COLLAB_TRANSITION_IDENTITIES } from "@/api/lib/db/folio-collab-transition-identities";
import { defineScopedTransitions } from "@/api/lib/db/transitions";

// Its own module so the collaboration handlers depend on this spec alone, not
// on the total registry and every feature's tables behind it.
export const FOLIO_COLLAB_SEED_TRANSITIONS = defineScopedTransitions({
  ...FOLIO_COLLAB_TRANSITION_IDENTITIES.FOLIO_COLLAB_SEED_TRANSITIONS,
  table: folioCollabRooms,
  edges: {
    empty: ["empty", "claimed"],
    claimed: ["empty", "claimed", "seeded"],
    seeded: ["empty", "seeded"],
  },
  initial: ["empty"],
});
