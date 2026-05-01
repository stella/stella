import type { FlowBlock } from "../core/layout-engine/types";

export type LayoutInstrumentation = {
  onLayoutComplete?: () => void;
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

export function recordLayoutComplete(): void {
  globalThis.__folioLayoutInstrumentation?.onLayoutComplete?.();
}
