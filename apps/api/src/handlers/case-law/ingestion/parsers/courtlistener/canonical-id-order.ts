// parser-output-unchanged: [us-courtlistener] canonical ID helpers moved here unchanged; output is identical.
/** UTF-16 code-unit order, independent of locale. */
export const compareBytewise = (left: string, right: string): number => {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
};

/** Numeric order of canonical IDs without `Number`, which loses past 2^53. */
export const compareCanonicalIds = (left: string, right: string): number =>
  left.length === right.length
    ? compareBytewise(left, right)
    : left.length - right.length;
