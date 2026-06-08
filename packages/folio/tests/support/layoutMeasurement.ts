import type {
  HiddenEditorPhase,
  HiddenEditorStateReason,
  LayoutPhase,
  LayoutRunReason,
} from "../../src/core/layout-engine/layoutInstrumentation";

export type CounterBucket = {
  count: number;
  totalMs: number;
};

export type LayoutMeasurementStats = {
  layoutCompletions: number;
  layoutErrors: { message: string; reason: LayoutRunReason }[];
  layoutPhases: Record<LayoutPhase, CounterBucket>;
  layoutReasons: Record<LayoutRunReason, number>;
  hiddenStateCreations: Record<HiddenEditorStateReason, number>;
  hiddenEditorPhases: Record<HiddenEditorPhase, CounterBucket>;
  measureBlockCalls: number;
};

declare global {
  // Browser-side global installed by perf harnesses to count real layout work.
  var __folioLayoutMeasurementStats: LayoutMeasurementStats | undefined;
}
