import { collectSectionConfigs } from "../core/layout-engine";
import type { SectionLayoutConfig } from "../core/layout-engine";
import type { ColumnLayout, FlowBlock } from "../core/layout-engine/types";

type ComputePerBlockWidthsInput = {
  blocks: FlowBlock[];
  bodyConfig: SectionLayoutConfig;
  finalConfig: SectionLayoutConfig;
};

/**
 * Compute per-block measurement widths by scanning for section breaks.
 * Blocks in multi-column sections must be measured at column width, not full content width.
 *
 * OOXML note: Each section break carries the CURRENT section's properties.
 * Section N's blocks use config from sectionBreak[N].
 * The final section (after all breaks) uses body-level config.
 */
export function computePerBlockWidths({
  blocks,
  bodyConfig,
  finalConfig,
}: ComputePerBlockWidthsInput): number[] {
  function colWidth(cw: number, cols: ColumnLayout): number {
    if (cols.count <= 1) {
      return cw;
    }
    return Math.floor((cw - (cols.count - 1) * cols.gap) / cols.count);
  }

  function contentWidth(config: SectionLayoutConfig): number {
    return config.pageSize.w - config.margins.left - config.margins.right;
  }

  const { configs: sectionConfigs, breakIndices } = collectSectionConfigs(
    blocks,
    bodyConfig,
    finalConfig,
  );

  let sectionIdx = 0;
  const widths: number[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const config = sectionConfigs[sectionIdx] ?? finalConfig;
    widths.push(
      colWidth(contentWidth(config), config.columns ?? { count: 1, gap: 0 }),
    );

    if (sectionIdx < breakIndices.length && i === breakIndices[sectionIdx]) {
      sectionIdx++;
    }
  }

  return widths;
}
