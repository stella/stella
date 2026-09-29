const CHANGESET_FRONTMATTER_FENCE = "---";

class ChangesetEntryError extends Error {
  readonly _tag = "ChangesetEntryError";

  constructor(message: string) {
    super(message);
    this.name = "ChangesetEntryError";
  }
}

/**
 * `"@stll/cli": minor`, quoted or bare, as Changesets writes the frontmatter.
 * A package name holds no colon, so the first one separates it from the bump.
 */
const changesetPackageName = (line: string): string | null => {
  const separator = line.indexOf(":");
  if (separator === -1 || line.slice(separator + 1).trim().length === 0) {
    return null;
  }
  const key = line.slice(0, separator).trim();
  const quoted =
    key.length > 1 &&
    (key.startsWith('"') || key.startsWith("'")) &&
    key.endsWith(key.slice(0, 1));
  const name = quoted ? key.slice(1, -1) : key;
  return name.length > 0 ? name : null;
};

/**
 * The packages a changeset frontmatter names and the summary beneath it.
 * An entry with no frontmatter (`bun run changeset --empty`) names none: it
 * records a deliberate no-release change and belongs in no changelog.
 */
export const parseChangesetEntry = (
  entry: string,
): { packages: readonly string[]; summary: string } => {
  const lines = entry.split("\n");
  if (lines.at(0)?.trim() !== CHANGESET_FRONTMATTER_FENCE) {
    return { packages: [], summary: "" };
  }
  const packages: string[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    if (line.trim() === CHANGESET_FRONTMATTER_FENCE) {
      return {
        packages,
        summary: lines
          .slice(index + 2)
          .join("\n")
          .trim(),
      };
    }
    const name = changesetPackageName(line);
    if (name !== null) {
      packages.push(name);
    }
  }
  throw new ChangesetEntryError(
    "A pending changeset has unterminated frontmatter",
  );
};
