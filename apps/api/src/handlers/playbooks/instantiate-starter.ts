import { panic } from "better-result";

import { remapNodePropertyIds } from "@/api/lib/conditions/ast-utils";
import type {
  PlaybookPositions,
  Position,
  PositionStandard,
  Tiers,
} from "@/api/lib/workflow/playbook-positions";

// Clones a starter's positions with a brand-new uuid for every id: the
// position `sourceId`, every acceptable/not-acceptable tier-rule id, and
// every fallback-entry id. Two orgs instantiating the same starter (or one
// org instantiating it twice) must never share an id — re-run mapping,
// finding citations, and DnD reorder all key off these ids as stable identity.
export const instantiateStarterPositions = (
  positions: PlaybookPositions,
): PlaybookPositions => {
  const sourceIdMap = new Map(
    positions.items.map((position) => [position.sourceId, Bun.randomUUIDv7()]),
  );

  return {
    version: 3,
    items: positions.items.map((position) =>
      regeneratePositionIds(position, sourceIdMap),
    ),
  };
};

const regeneratePositionIds = (
  position: Position,
  sourceIdMap: ReadonlyMap<string, string>,
): Position => {
  const sourceId =
    sourceIdMap.get(position.sourceId) ??
    panic("Starter position source id was not regenerated");

  if (position.mode === "extract") {
    return { ...position, sourceId };
  }

  const regenerated = {
    ...position,
    sourceId,
    standard: regenerateStandardIds(position.standard),
  };
  if (position.check?.kind !== "constraint") {
    return regenerated;
  }
  return {
    ...regenerated,
    check: {
      ...position.check,
      condition: remapNodePropertyIds(
        position.check.condition,
        (id) =>
          sourceIdMap.get(id) ??
          panic("Starter constraint references an unknown position"),
      ),
    },
  };
};

// A reference standard carries no authored ids: its passages are identified by
// the document version and block they were quoted from.
const regenerateStandardIds = (standard: PositionStandard): PositionStandard =>
  standard.source === "tiers"
    ? { source: "tiers", tiers: regenerateTierIds(standard.tiers) }
    : standard;

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
