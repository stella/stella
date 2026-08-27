import { Result } from "better-result";
import { describe, expect, it } from "bun:test";

import { validateCommentRange } from "./range";

const BODY_LENGTH = 20;

describe("comment range validation", () => {
  it("accepts a range inside the commented text", () => {
    expect(
      Result.isOk(
        validateCommentRange({
          rangeStart: 3,
          rangeEnd: 9,
          textLength: BODY_LENGTH,
        }),
      ),
    ).toBe(true);
  });

  it("accepts an empty range, the anchor of a point comment", () => {
    expect(
      Result.isOk(
        validateCommentRange({
          rangeStart: 7,
          rangeEnd: 7,
          textLength: BODY_LENGTH,
        }),
      ),
    ).toBe(true);
  });

  it("accepts a range ending exactly at the end of the text", () => {
    expect(
      Result.isOk(
        validateCommentRange({
          rangeStart: 0,
          rangeEnd: BODY_LENGTH,
          textLength: BODY_LENGTH,
        }),
      ),
    ).toBe(true);
  });

  it("refuses a range that runs backwards", () => {
    const result = validateCommentRange({
      rangeStart: 9,
      rangeEnd: 3,
      textLength: BODY_LENGTH,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error.status).toBe(400);
  });

  it("refuses a range reaching past the end of the text", () => {
    const result = validateCommentRange({
      rangeStart: 0,
      rangeEnd: BODY_LENGTH + 1,
      textLength: BODY_LENGTH,
    });

    expect(Result.isError(result)).toBe(true);
    if (Result.isOk(result)) {
      return;
    }
    expect(result.error.status).toBe(400);
  });

  it("refuses any range against empty text except the empty one", () => {
    expect(
      Result.isOk(
        validateCommentRange({ rangeStart: 0, rangeEnd: 0, textLength: 0 }),
      ),
    ).toBe(true);
    expect(
      Result.isError(
        validateCommentRange({ rangeStart: 0, rangeEnd: 1, textLength: 0 }),
      ),
    ).toBe(true);
  });

  it("rejects negative offsets", () => {
    for (const range of [
      { rangeStart: -1, rangeEnd: 3, textLength: 10 },
      { rangeStart: 0, rangeEnd: -1, textLength: 10 },
    ]) {
      const result = validateCommentRange(range);
      expect(Result.isError(result)).toBe(true);
    }
  });
});
