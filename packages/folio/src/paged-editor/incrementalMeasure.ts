import type {
  FlowBlock,
  Measure,
  ParagraphBlock,
} from "../core/layout-engine/types";

export type DirtyRange = {
  from: number;
  to: number;
};

export type IncrementalMeasureInput = {
  previousBlocks: FlowBlock[];
  previousMeasures: Measure[];
  previousBlockWidths: number[];
  nextBlocks: FlowBlock[];
  nextBlockWidths: number[];
  dirtyRange: DirtyRange;
  measureBlock: (
    block: FlowBlock,
    blockWidth: number,
    blockIndex: number,
  ) => Measure;
};

export type IncrementalMeasureResult = {
  measures: Measure[];
  measuredBlockIndexes: number[];
};

export function mergeDirtyRanges(
  first: DirtyRange | null,
  second: DirtyRange | null,
): DirtyRange | null {
  if (!first) {
    return second;
  }
  if (!second) {
    return first;
  }
  return {
    from: Math.min(first.from, second.from),
    to: Math.max(first.to, second.to),
  };
}

export function findDirtyBlockIndexes(
  blocks: FlowBlock[],
  dirtyRange: DirtyRange,
): number[] {
  const indexes: number[] = [];
  const dirtyFrom = Math.min(dirtyRange.from, dirtyRange.to);
  const dirtyTo = Math.max(dirtyRange.from, dirtyRange.to);

  for (let i = 0; i < blocks.length; i += 1) {
    const block = blocks[i];
    if (!block) {
      continue;
    }
    const blockStart = "pmStart" in block ? block.pmStart : undefined;
    const blockEnd = "pmEnd" in block ? block.pmEnd : undefined;
    if (blockStart === undefined || blockEnd === undefined) {
      return [];
    }
    if (rangesTouch(blockStart, blockEnd, dirtyFrom, dirtyTo)) {
      indexes.push(i);
    }
  }

  return indexes;
}

export function tryBuildIncrementalMeasures({
  previousBlocks,
  previousMeasures,
  previousBlockWidths,
  nextBlocks,
  nextBlockWidths,
  dirtyRange,
  measureBlock,
}: IncrementalMeasureInput): IncrementalMeasureResult | null {
  if (
    previousBlocks.length !== nextBlocks.length ||
    previousMeasures.length !== nextBlocks.length ||
    previousBlockWidths.length !== nextBlockWidths.length
  ) {
    return null;
  }

  for (let i = 0; i < nextBlockWidths.length; i += 1) {
    if (previousBlockWidths[i] !== nextBlockWidths[i]) {
      return null;
    }
  }

  if (!nextBlocks.every(isIncrementalMeasureEligibleBlock)) {
    return null;
  }

  const dirtyBlockIndexes = findDirtyBlockIndexes(nextBlocks, dirtyRange);
  if (dirtyBlockIndexes.length === 0) {
    return null;
  }

  const measures = previousMeasures.slice();
  for (const blockIndex of dirtyBlockIndexes) {
    const block = nextBlocks[blockIndex];
    const blockWidth = nextBlockWidths[blockIndex];
    if (!block || blockWidth === undefined) {
      return null;
    }
    measures[blockIndex] = measureBlock(block, blockWidth, blockIndex);
  }

  return {
    measures,
    measuredBlockIndexes: dirtyBlockIndexes,
  };
}

function rangesTouch(
  blockStart: number,
  blockEnd: number,
  dirtyFrom: number,
  dirtyTo: number,
): boolean {
  if (dirtyFrom === dirtyTo) {
    return dirtyFrom >= blockStart && dirtyFrom <= blockEnd;
  }
  return dirtyFrom <= blockEnd && dirtyTo >= blockStart;
}

function isIncrementalMeasureEligibleBlock(block: FlowBlock): boolean {
  if (block.kind !== "paragraph") {
    return false;
  }

  const paragraph = block as ParagraphBlock;
  if (
    paragraph.attrs?.listMarker ||
    paragraph.attrs?.contextualSpacing ||
    paragraph.attrs?.borders
  ) {
    return false;
  }

  return paragraph.runs.every((run) => {
    if (run.kind === "field" || run.kind === "image") {
      return false;
    }
    return !(
      "footnoteRefId" in run ||
      "endnoteRefId" in run ||
      "isInsertion" in run ||
      "isDeletion" in run ||
      "changeRevisionId" in run
    );
  });
}
