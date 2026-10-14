const NUMBERED_COPY = /^(.*) \((\d+)\)$/u;

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
  let highestCopy = 1;
  for (const existing of existingNames) {
    if (sameName(existing, name)) {
      taken = true;
      continue;
    }
    const copy = NUMBERED_COPY.exec(existing);
    if (copy?.[1] !== undefined && sameName(copy[1], name)) {
      highestCopy = Math.max(highestCopy, Number(copy[2]));
    }
  }
  return taken ? `${name} (${highestCopy + 1})` : name;
};
