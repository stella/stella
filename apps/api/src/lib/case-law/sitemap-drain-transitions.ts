import { caseLawSitemapDrainProgress } from "@/api/db/schema";
import { defineScopedTransitions } from "@/api/lib/db/transitions";

export const SITEMAP_DRAIN_TRANSITION_IDENTITY = {
  tableName: "caseLawSitemapDrainProgress",
  key: "country",
  scope: ["year", "month"],
  stateColumn: "phase",
} as const;

export const SITEMAP_DRAIN_TRANSITIONS = defineScopedTransitions({
  table: caseLawSitemapDrainProgress,
  key: SITEMAP_DRAIN_TRANSITION_IDENTITY.key,
  scope: SITEMAP_DRAIN_TRANSITION_IDENTITY.scope,
  stateColumn: SITEMAP_DRAIN_TRANSITION_IDENTITY.stateColumn,
  edges: {
    draining: ["awaiting_visibility"],
    awaiting_visibility: ["draining"],
  },
  initial: ["draining"],
});
