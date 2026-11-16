import type { SkillDraftNameKind } from "@stll/api-contract";
import { escapeRegExp, slugify } from "@stll/text-normalize";

/** A skill draft as the API returns it for review. */
export type SkillDraft = {
  markdown: string;
  resources: { content: string; path: string }[];
};

/** One name of a person or organization the draft holds. */
export type SkillDraftName = { kind: SkillDraftNameKind; value: string };

/**
 * Every key replaced by its value in one pass, the longest key where two
 * start at the same place. A replacement is never replaced again, so a path
 * renamed to one another file had cannot be renamed a second time.
 */
const replaceAll = (
  text: string,
  replacements: ReadonlyMap<string, string>,
) => {
  const keys = [...replacements.keys()]
    .filter((key) => key !== "")
    .toSorted((left, right) => right.length - left.length);
  if (keys.length === 0) {
    return text;
  }
  const pattern = new RegExp(keys.map(escapeRegExp).join("|"), "gu");
  return text.replace(pattern, (found) => replacements.get(found) ?? found);
};

/** Longer than any name a skill file path holds. */
const PATH_SLUG_MAX = 256;

/**
 * How a name can appear in a skill file path, which is lowercase: as written,
 * or as a path slug.
 */
const pathForms = (value: string): string[] => [
  ...new Set(
    [
      value.toLowerCase(),
      slugify(value, {
        charset: "ascii",
        fallback: "",
        maxLength: PATH_SLUG_MAX,
        separator: "-",
      }),
    ].filter((form) => form !== ""),
  ),
];

/** The path without the replaced names, kept unique among `taken`. */
const neutralPath = (
  path: string,
  replaced: readonly SkillDraftName[],
  taken: ReadonlySet<string>,
): string => {
  let next = path;
  for (const { kind, value } of replaced) {
    for (const form of pathForms(value)) {
      next = next.split(form).join(kind);
    }
  }
  if (next === path || !taken.has(next)) {
    return next;
  }
  const dot = next.lastIndexOf(".");
  const [stem, extension] =
    dot > next.lastIndexOf("/")
      ? [next.slice(0, dot), next.slice(dot)]
      : [next, ""];
  let suffix = 2;
  while (taken.has(`${stem}-${suffix}${extension}`)) {
    suffix += 1;
  }
  return `${stem}-${suffix}${extension}`;
};

/**
 * The draft with each name the author did not keep replaced by its role, in
 * SKILL.md and every companion file. A file whose path holds the name is
 * renamed with the name's kind instead, and every link to it follows.
 */
export const replaceDraftNames = (
  draft: SkillDraft,
  replaced: readonly SkillDraftName[],
  roleOf: (kind: SkillDraftNameKind) => string,
): SkillDraft => {
  if (replaced.length === 0) {
    return draft;
  }
  // Longer names first, so a name inside another is not replaced half-way.
  const longestFirst = [...replaced].toSorted(
    (left, right) => right.value.length - left.value.length,
  );
  const taken = new Set(draft.resources.map(({ path }) => path));
  const renames = new Map<string, string>();
  for (const { path } of draft.resources) {
    const next = neutralPath(path, longestFirst, taken);
    if (next !== path) {
      taken.add(next);
      renames.set(path, next);
    }
  }
  // Paths and names in one pass: a link is renamed whole, never by a name
  // or a shorter path inside it.
  const replacements = new Map([
    ...renames,
    ...longestFirst.map(({ kind, value }) => [value, roleOf(kind)] as const),
  ]);
  return {
    markdown: replaceAll(draft.markdown, replacements),
    resources: draft.resources.map((resource) => ({
      path: renames.get(resource.path) ?? resource.path,
      content: replaceAll(resource.content, replacements),
    })),
  };
};

/** Every name approved so far, once each. */
export const mergeApprovedNames = (
  approved: readonly string[],
  kept: Iterable<string>,
): string[] => [...new Set([...approved, ...kept])];
