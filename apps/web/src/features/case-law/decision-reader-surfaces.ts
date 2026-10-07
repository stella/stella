/** Each linked reader owns the same stored-row loading and placement path. */
export const DECISION_READER_SURFACES = {
  "full-reader":
    "apps/web/src/features/case-law/components/case-viewer/decision-workspace.tsx",
  inspector:
    "apps/web/src/features/case-law/components/case-decision-inspector-view.tsx",
  development:
    "apps/web/src/routes/dev/-components/inspector-pane-playground.tsx",
} as const;

export type DecisionReaderSurface = keyof typeof DECISION_READER_SURFACES;
