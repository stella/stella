import { Result } from "better-result";

import { HandlerError } from "@/api/lib/errors/tagged-errors";

type CommentRange = {
  rangeStart: number;
  rangeEnd: number;
  /** Length of the text the comment anchors into: a revision or proposal body. */
  textLength: number;
};

/**
 * A comment anchors to a character range of the text it was written against.
 * A range that runs backwards or past the end of that text would render at a
 * position that never existed, so it is refused at the boundary rather than
 * stored and clamped later.
 */
export const validateCommentRange = ({
  rangeStart,
  rangeEnd,
  textLength,
}: CommentRange): Result<void, HandlerError> => {
  if (rangeEnd < rangeStart) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Comment range ends before it starts",
      }),
    );
  }
  if (rangeEnd > textLength) {
    return Result.err(
      new HandlerError({
        status: 400,
        message: "Comment range is outside the commented text",
      }),
    );
  }

  return Result.ok(undefined);
};
