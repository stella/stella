const NUMBERED_COPY = /^(.*) \((\d+)\)$/su;

// Case-insensitive like the ILIKE prefix query that supplies the names;
// accents stay distinct, as they do there.
const sameName = (left: string, right: string): boolean =>
  left.toLowerCase() === right.toLowerCase();

/**
 * The name a new matter is stored under. A name no matter in the
 * organization uses is kept as entered; otherwise the next free copy
 * number is appended, starting at " (2)", so two matters never share a
 * title. Names that merely start with the entered name do not count.
 *
 * `existingNames` holds every organization matter name that starts with
 * the entered one (the prefix query in the create handler).
 */
export const nextAvailableMatterName = (
  name: string,
  existingNames: readonly string[],
): string => {
  let taken = false;
  // Exact integers: a typed copy number past 2^53 must still be passed, not
  // rounded back onto a number already in use.
  let highestCopy = 1n;
  for (const existing of existingNames) {
    if (sameName(existing, name)) {
      taken = true;
      continue;
    }
    const copy = NUMBERED_COPY.exec(existing);
    if (
      copy?.[1] !== undefined &&
      copy[2] !== undefined &&
      sameName(copy[1], name)
    ) {
      const number = BigInt(copy[2]);
      if (number > highestCopy) {
        highestCopy = number;
      }
    }
  }
  return taken ? `${name} (${highestCopy + 1n})` : name;
};
