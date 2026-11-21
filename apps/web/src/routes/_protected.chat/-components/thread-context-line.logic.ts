import { coversAllMatters } from "@/lib/workspaces/all-matters.logic";

/** Matters a history row shows by name before folding the rest into "+N". */
const THREAD_CONTEXT_INLINE_MATTERS = 2;
/** Files a history row shows by name before folding the rest into "+N". */
const THREAD_CONTEXT_INLINE_FILES = 2;

/**
 * A thread's context as the list endpoint returns it: a bounded, ordered
 * preview of each kind beside the number of items the server found.
 */
export type ThreadContextPreview<TMatter, TFile> = {
  fileCount: number;
  files: readonly TFile[];
  matterCount: number;
  matters: readonly TMatter[];
};

export type ThreadContextLayout<TMatter, TFile> = {
  /** Shown by name in the row, matters before files. */
  inline: {
    files: TFile[];
    matters: TMatter[];
  };
  /** Named but not shown inline; listed in the tooltip with the inline ones. */
  hidden: {
    files: TFile[];
    matters: TMatter[];
  };
  /** Counted by the server beyond the preview it named. */
  unnamedCount: number;
  /** Everything not shown inline: the row's "+N". Zero hides the badge. */
  overflowCount: number;
  /** Whether the row has any context line at all. */
  hasContext: boolean;
  /**
   * The chat drew on every matter the reader can open: the row shows one
   * "All matters" chip and names none of them.
   */
  allMatters: boolean;
};

/**
 * Splits a thread's context into what the row shows inline and what folds into
 * one "+N" badge. Each kind keeps its own inline budget, so many files never
 * push the matters out of the row (and the reverse); a kind with fewer items
 * than its budget does not lend the spare slots to the other, which keeps the
 * row's shape the same from one thread to the next.
 *
 * A count lower than the named preview is treated as the preview's length, so
 * a stale or inconsistent count can never produce a negative "+N".
 */
export const layoutThreadContext = <TMatter, TFile>(
  context: ThreadContextPreview<TMatter, TFile>,
  {
    accessibleMatterCount,
    maxInlineFiles = THREAD_CONTEXT_INLINE_FILES,
    maxInlineMatters = THREAD_CONTEXT_INLINE_MATTERS,
  }: {
    /** How many matters the reader can open; unknown while their list loads. */
    accessibleMatterCount?: number | undefined;
    maxInlineFiles?: number;
    maxInlineMatters?: number;
  } = {},
): ThreadContextLayout<TMatter, TFile> => {
  const matterTotal = Math.max(context.matterCount, context.matters.length);
  const fileTotal = Math.max(context.fileCount, context.files.length);
  const allMatters =
    accessibleMatterCount !== undefined &&
    coversAllMatters({ count: matterTotal, total: accessibleMatterCount });
  // A chat that drew on every matter says so once instead of naming them:
  // its matters leave the chips and the "+N" alike.
  const matters = allMatters ? [] : context.matters;
  const namedMatterTotal = allMatters ? 0 : matterTotal;
  const inlineMatters = matters.slice(0, Math.max(0, maxInlineMatters));
  const inlineFiles = context.files.slice(0, Math.max(0, maxInlineFiles));
  const unnamedCount =
    namedMatterTotal - matters.length + (fileTotal - context.files.length);

  return {
    allMatters,
    hasContext: matterTotal + fileTotal > 0,
    hidden: {
      files: context.files.slice(inlineFiles.length),
      matters: matters.slice(inlineMatters.length),
    },
    inline: { files: inlineFiles, matters: inlineMatters },
    overflowCount:
      namedMatterTotal + fileTotal - inlineMatters.length - inlineFiles.length,
    unnamedCount,
  };
};
