import type {
  PlaybookPositions,
  Position,
  Tiers,
} from "@/api/handlers/playbooks/positions";

// Clones a starter's positions with a brand-new uuid for every id: the
// position `sourceId`, every acceptable/not-acceptable tier-rule id, and
// every fallback-entry id. Two orgs instantiating the same starter (or one
// org instantiating it twice) must never share an id — re-run mapping,
// finding citations, and DnD reorder all key off these ids as stable identity.
export const instantiateStarterPositions = (
  positions: PlaybookPositions,
): PlaybookPositions => ({
  version: 2,
  items: positions.items.map(regeneratePositionIds),
});

const regeneratePositionIds = (position: Position): Position => {
  if (position.mode === "extract") {
    return { ...position, sourceId: Bun.randomUUIDv7() };
  }
  return {
    ...position,
    sourceId: Bun.randomUUIDv7(),
    tiers: regenerateTierIds(position.tiers),
  };
};

const regenerateTierIds = (tiers: Tiers): Tiers => ({
  acceptable: {
    ...tiers.acceptable,
    rules: tiers.acceptable.rules.map((rule) => ({
      ...rule,
      id: Bun.randomUUIDv7(),
    })),
  },
  fallback: {
    entries: tiers.fallback.entries.map((entry) => ({
      ...entry,
      id: Bun.randomUUIDv7(),
    })),
  },
  notAcceptable: {
    rules: tiers.notAcceptable.rules.map((rule) => ({
      ...rule,
      id: Bun.randomUUIDv7(),
    })),
  },
});
