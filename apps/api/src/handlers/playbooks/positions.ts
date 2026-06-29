import { t } from "elysia";
import type { Static } from "elysia";

import { propertyContentSchema } from "@/api/db/schema-validators";
import type { PlaybookBundleColumn } from "@/api/db/schema-validators";
import {
  positionRuleSchema,
  positionSeveritySchema,
  positionStandardSchema,
} from "@/api/handlers/playbooks/position-facets";

// Re-export the EXPECT/GRADE/severity facets so existing importers keep using
// `@/api/handlers/playbooks/positions` as the one entry point for Position types.
export {
  positionRuleSchema,
  positionSeveritySchema,
  positionStandardSchema,
  resolvedStandardSchema,
} from "@/api/handlers/playbooks/position-facets";
export type {
  PositionRule,
  PositionSeverity,
  PositionStandard,
  ResolvedStandard,
} from "@/api/handlers/playbooks/position-facets";

const v1 = t.Literal(1);

// ── ASK: what to read from each document ──────────────
// An empty `question` means manual input (no AI extraction), mirroring the
// legacy bundle column where an empty prompt selected manual-input.
export const positionAskSchema = t.Object({
  question: t.String({ maxLength: 1000 }),
  content: propertyContentSchema,
});
export type PositionAsk = Static<typeof positionAskSchema>;

// ── Position: the atom ────────────────────────────────
export const positionSchema = t.Object({
  // Stable, client-supplied id; survives edits so re-running a playbook maps a
  // position back to the same materialized column/finding instead of
  // duplicating it.
  sourceId: t.String({ format: "uuid" }),
  issue: t.String({ minLength: 1, maxLength: 256 }),
  ask: positionAskSchema,
  standard: positionStandardSchema,
  rule: positionRuleSchema,
  severity: positionSeveritySchema,
  guidance: t.Optional(t.String({ maxLength: 2000 })),
});
export type Position = Static<typeof positionSchema>;

// ── Positions container (version-tagged JSONB) ────────
export const playbookPositionsSchema = t.Object({
  version: v1,
  items: t.Array(positionSchema, { maxItems: 200 }),
});
export type PlaybookPositions = Static<typeof playbookPositionsSchema>;

// ── Migration compat: lift a legacy bundle column to a position ──
// A pre-positions "playbook bundle" column is a pure extraction column; it maps
// to an ASK-only position with no standard and no grade. Kept as one canonical
// mapping so the SQL backfill and any script agree.
export const bundleColumnToPosition = (
  column: PlaybookBundleColumn,
): Position => ({
  sourceId: column.sourceId,
  issue: column.name,
  ask: {
    question: column.prompt,
    content: column.content,
  },
  standard: { source: "none" },
  rule: { kind: "extractOnly" },
  severity: "medium",
});
