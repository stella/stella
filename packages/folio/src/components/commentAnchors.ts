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
  const range =
    capturedRange.from !== capturedRange.to
      ? capturedRange
      : currentRange.from !== currentRange.to
        ? currentRange
        : savedRange && savedRange.from !== savedRange.to
          ? savedRange
          : null;

  return range ? clampCommentMarkRange(docSize, range) : null;
}
