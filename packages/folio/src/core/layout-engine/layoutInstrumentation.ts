import type { FlowBlock } from "./types";

export type LayoutRunReason =
  | "font-ready"
  | "initial"
  | "layout-input"
  | "manual"
  | "transaction";

export type LayoutPhase =
  | "flow-blocks"
  | "header-footer"
  | "initial-fonts"
  | "layout-document"
  | "measure-blocks"
  | "render-pages";

export type HiddenEditorStateReason = "external-document" | "mount";

export type HiddenEditorPhase =
  | "editor-state"
  | "editor-view"
  | "to-prose-doc"
  | "update-state";

export type LayoutInstrumentation = {
  onHiddenEditorPhase?: (event: {
    durationMs: number;
    phase: HiddenEditorPhase;
    reason: HiddenEditorStateReason;
  }) => void;
  onHiddenEditorStateCreate?: (event: {
    reason: HiddenEditorStateReason;
  }) => void;
  onLayoutComplete?: (event: { reason: LayoutRunReason }) => void;
  onLayoutError?: (event: { message: string; reason: LayoutRunReason }) => void;
  onLayoutPhase?: (event: {
    durationMs: number;
    phase: LayoutPhase;
    reason: LayoutRunReason;
  }) => void;
  onMeasureBlock?: (event: {
    blockIndex: number;
    blockKind: FlowBlock["kind"];
  }) => void;
};

declare global {
  // Browser tests install this hook to count real production layout work.
  // It is undefined in normal use, so the instrumentation is a no-op.
  var __folioLayoutInstrumentation: LayoutInstrumentation | undefined;
}

export function recordMeasureBlock(blockIndex: number, block: FlowBlock): void {
  globalThis.__folioLayoutInstrumentation?.onMeasureBlock?.({
    blockIndex,
    blockKind: block.kind,
  });
}

export function recordLayoutComplete(reason: LayoutRunReason = "manual"): void {
  globalThis.__folioLayoutInstrumentation?.onLayoutComplete?.({ reason });
}

export function recordLayoutError(
  reason: LayoutRunReason,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  globalThis.__folioLayoutInstrumentation?.onLayoutError?.({
    message,
    reason,
  });
}

export function recordLayoutPhase(
  reason: LayoutRunReason,
  phase: LayoutPhase,
  durationMs: number,
): void {
  globalThis.__folioLayoutInstrumentation?.onLayoutPhase?.({
    durationMs,
    phase,
    reason,
  });
}

export function recordHiddenEditorStateCreate(
  reason: HiddenEditorStateReason,
): void {
  globalThis.__folioLayoutInstrumentation?.onHiddenEditorStateCreate?.({
    reason,
  });
}

export function recordHiddenEditorPhase(
  reason: HiddenEditorStateReason,
  phase: HiddenEditorPhase,
  durationMs: number,
): void {
  globalThis.__folioLayoutInstrumentation?.onHiddenEditorPhase?.({
    durationMs,
    phase,
    reason,
  });
}
