import { panic } from "better-result";

/**
 * Whose marks a reader surface draws. "none" is not an empty document: the
 * marks are there, the reader has asked to look past them.
 */
export type ReaderMarksFilter = "all" | "mine" | "none";

/** Authorship is the whole of what the filter reads off a mark. */
type OwnedMark = { mine: boolean };

export const annotationsForMarksFilter = <TMark extends OwnedMark>(
  annotations: readonly TMark[],
  marks: ReaderMarksFilter,
): readonly TMark[] => {
  switch (marks) {
    case "all": {
      return annotations;
    }
    case "mine": {
      return annotations.filter((annotation) => annotation.mine);
    }
    case "none": {
      return [];
    }
    default: {
      marks satisfies never;
      return panic(`Unhandled marks filter: ${String(marks)}`);
    }
  }
};
