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
const parseChangesetFrontmatter = (entry: string) => {
  const lines = entry.split("\n");
  if (lines.at(0)?.trim() !== CHANGESET_FRONTMATTER_FENCE) {
    return { names: [], frontmatter: undefined, summary: "" };
  }
  const names: string[] = [];
  for (const [index, line] of lines.slice(1).entries()) {
    if (line.trim() === CHANGESET_FRONTMATTER_FENCE) {
      return {
        names,
        frontmatter: lines.slice(1, index + 1).join("\n"),
        summary: lines
          .slice(index + 2)
          .join("\n")
          .trim(),
      };
    }
    const name = changesetPackageName(line);
    if (name !== null) {
      names.push(name);
    }
  }
  throw new ChangesetEntryError(
    "A pending changeset has unterminated frontmatter",
  );
};

export const parseChangesetEntry = (
  entry: string,
): { packages: readonly string[]; summary: string } => {
  const { names, summary } = parseChangesetFrontmatter(entry);
  return { packages: names, summary };
};

type ChangesetRelease = { name: string; type: "major" | "minor" | "patch" };

const CHANGESET_BUMPS = ["major", "minor", "patch", "none"] as const;

const isChangesetBump = (
  value: unknown,
): value is (typeof CHANGESET_BUMPS)[number] =>
  CHANGESET_BUMPS.some((bump) => bump === value);

const unreadableChangeset = (reason: string): never => {
  throw new ChangesetEntryError(
    `Changesets cannot read a pending changeset: ${reason}`,
  );
};

const parseFrontmatterYaml = (frontmatter: string): unknown => {
  try {
    return Bun.YAML.parse(frontmatter);
  } catch (error) {
    return unreadableChangeset(
      `invalid YAML in frontmatter (${error instanceof Error ? error.message : String(error)})`,
    );
  }
};

/**
 * The releases as Changesets reads them at release time: the frontmatter is
 * parsed as YAML 1.2, as `@changesets/parse` does, so quoting, comments and
 * block scalars mean what they mean to `changeset version`, and the same
 * entries are refused (invalid YAML, a non-mapping, an empty package name, a
 * bump other than major, minor, patch or none). A refused entry fails the
 * check instead of reading as no release; a `none` bump authorizes nothing.
 * Install-free CI steps import this module, so it uses Bun's built-in YAML
 * reader rather than the Changesets package.
 */
export const parseChangesetReleases = (
  entry: string,
): readonly ChangesetRelease[] => {
  const { frontmatter } = parseChangesetFrontmatter(entry);
  if (frontmatter === undefined) {
    return [];
  }
  const parsed = parseFrontmatterYaml(frontmatter);
  if (parsed === null || parsed === undefined) {
    return [];
  }
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    return unreadableChangeset(
      "frontmatter must map package names to version types",
    );
  }
  return Object.entries(parsed).flatMap(([name, type]) => {
    if (name.trim().length === 0) {
      return unreadableChangeset("empty package name in frontmatter");
    }
    if (!isChangesetBump(type)) {
      return unreadableChangeset(
        `invalid version type ${JSON.stringify(type)} for package "${name}"`,
      );
    }
    return type === "none" ? [] : [{ name, type }];
  });
};
