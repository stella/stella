import type { ParagraphBlock, ParagraphMeasure, Run } from "./types";

function clampCharOffset(value: number | undefined, length: number): number {
  if (value == null || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(length, value));
}

function runBoundaryPmPos(
  run: Run | undefined,
  charOffset: number,
  edge: "start" | "end",
): number | undefined {
  if (!run) {
    return undefined;
  }

  if (run.kind === "text") {
    if (typeof run.pmStart === "number") {
      return run.pmStart + clampCharOffset(charOffset, run.text.length);
    }
    return edge === "end" ? run.pmEnd : undefined;
  }

  if (edge === "end") {
    if (typeof run.pmEnd === "number") {
      return run.pmEnd;
    }
    return typeof run.pmStart === "number" ? run.pmStart + 1 : undefined;
  }
  return run.pmStart;
}

export function getParagraphFragmentPmRange(
  block: ParagraphBlock,
  measure: ParagraphMeasure,
  fromLine: number,
  toLine: number,
): { pmStart?: number; pmEnd?: number } {
  if (measure.lines.length === 0 || fromLine >= toLine) {
    const res: { pmStart?: number; pmEnd?: number } = {};
    if (block.pmStart !== undefined) {
      res.pmStart = block.pmStart;
    }
    if (block.pmEnd !== undefined) {
      res.pmEnd = block.pmEnd;
    }
    return res;
  }

  const firstLine = measure.lines[fromLine];
  const lastLine = measure.lines[toLine - 1];
  const firstRun = firstLine ? block.runs[firstLine.fromRun] : undefined;
  const lastRun = lastLine ? block.runs[lastLine.toRun] : undefined;

  let pmStart =
    fromLine === 0
      ? (block.pmStart ??
        runBoundaryPmPos(firstRun, firstLine?.fromChar ?? 0, "start"))
      : runBoundaryPmPos(firstRun, firstLine?.fromChar ?? 0, "start");
  let pmEnd =
    toLine >= measure.lines.length
      ? (block.pmEnd ?? runBoundaryPmPos(lastRun, lastLine?.toChar ?? 0, "end"))
      : runBoundaryPmPos(lastRun, lastLine?.toChar ?? 0, "end");

  if (pmStart == null) {
    pmStart = block.pmStart;
  }
  if (pmEnd == null) {
    pmEnd = block.pmEnd;
  }
  if (pmStart != null && pmEnd != null && pmEnd <= pmStart) {
    pmEnd = pmStart + 1;
  }

  const result: { pmStart?: number; pmEnd?: number } = {};
  if (pmStart !== undefined) {
    result.pmStart = pmStart;
  }
  if (pmEnd !== undefined) {
    result.pmEnd = pmEnd;
  }
  return result;
}
