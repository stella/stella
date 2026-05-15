export type CommentMarkRange = {
  from: number;
  to: number;
};

export function clampCommentMarkRange(
  docSize: number,
  range: CommentMarkRange,
): CommentMarkRange | null {
  const from = Math.max(0, Math.min(range.from, docSize));
  const to = Math.max(from, Math.min(range.to, docSize));
  if (from === to) {
    return null;
  }
  return { from, to };
}

export function resolveCommentCreationRange({
  docSize,
  capturedRange,
  currentRange,
  savedRange,
}: {
  docSize: number;
  capturedRange: CommentMarkRange;
  currentRange: CommentMarkRange;
  savedRange: CommentMarkRange | null;
}): CommentMarkRange | null {
  const range = (() => {
    if (capturedRange.from !== capturedRange.to) {
      return capturedRange;
    }
    if (currentRange.from !== currentRange.to) {
      return currentRange;
    }
    if (savedRange && savedRange.from !== savedRange.to) {
      return savedRange;
    }
    return null;
  })();

  return range ? clampCommentMarkRange(docSize, range) : null;
}
