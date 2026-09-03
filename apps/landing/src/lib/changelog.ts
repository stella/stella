import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import releaseDates from "../data/changelog-release-dates.json";
import { getReleaseKind, groupMaintenanceReleases } from "./changelog-release";

export type ChangelogRelease = {
  description: string;
  displayName: string;
  heading: string | null;
  /** ISO publication timestamp, or null when the release has no date entry. */
  publishedAt: string | null;
  slug: string;
  tagName: string;
};

// Widen the literal-keyed JSON import so lookups by arbitrary tag are typed as
// possibly absent (a new release lands before its date entry is committed).
// A `null` entry records a stable tag whose release was built but never
// promoted to production: its notes file exists, and nothing here lists it.
const RELEASE_DATES: Partial<Record<string, string | null>> = releaseDates;

const isUnpromoted = (tagName: string) => RELEASE_DATES[tagName] === null;

const CHANGELOG_DIR = resolveRepoPath("docs", "changelog");
const STABLE_CHANGELOG_FILE_PATTERN = /^v\d+\.\d+\.\d+\.md$/u;

export const releaseAnchorId = (tagName: string) =>
  tagName
    .toLowerCase()
    .replaceAll(".", "-")
    .replace(/[^a-z0-9-]/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");

const listReleaseTags = (): string[] => {
  if (!existsSync(CHANGELOG_DIR)) {
    return [];
  }

  const tags: string[] = [];
  for (const fileName of readdirSync(CHANGELOG_DIR)) {
    if (!STABLE_CHANGELOG_FILE_PATTERN.test(fileName)) {
      continue;
    }
    const tagName = fileName.replace(/\.md$/u, "");
    if (!isUnpromoted(tagName)) {
      tags.push(tagName);
    }
  }

  return tags.sort((left, right) =>
    right.localeCompare(left, "en", { numeric: true }),
  );
};

const readRelease = (tagName: string): ChangelogRelease => {
  const markdown = readFileSync(
    path.join(CHANGELOG_DIR, `${tagName}.md`),
    "utf-8",
  );
  const heading = findHeading(markdown, 1);
  const description =
    findHeading(markdown, 2) ??
    `Release notes for ${formatReleaseName(tagName)}.`;

  return {
    description,
    displayName: formatReleaseName(tagName),
    heading,
    publishedAt: RELEASE_DATES[tagName] ?? null,
    slug: releaseAnchorId(tagName),
    tagName,
  };
};

export const getChangelogReleases = (): ChangelogRelease[] =>
  listReleaseTags().map(readRelease);

/**
 * Stable tags recorded as never promoted. The live GitHub feed on the
 * changelog page drops these too: their release objects may still be
 * published, since the draft-until-promoted publication came later.
 */
export const getUnpromotedReleaseTags = (): string[] =>
  Object.entries(RELEASE_DATES)
    .filter(([, publishedAt]) => publishedAt === null)
    .map(([tagName]) => tagName);

export const getChangelogReleaseEntries = () =>
  groupMaintenanceReleases(
    getChangelogReleases(),
    (release) => release.heading,
  );

export const getLatestFeatureRelease = (): ChangelogRelease | undefined => {
  const tagName = listReleaseTags().find(
    (tag) => getReleaseKind(tag) !== "patch",
  );

  return tagName ? readRelease(tagName) : undefined;
};

const findHeading = (markdown: string, level: 1 | 2) => {
  const marker = "#".repeat(level);
  const heading = markdown
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith(`${marker} `));

  if (!heading) {
    return null;
  }

  return normalizeMarkdownText(heading.slice(marker.length + 1));
};

const normalizeMarkdownText = (text: string) =>
  stripMarkdownLinks(text).replace(/[*_`]/gu, "").replace(/\s+/gu, " ").trim();

const stripMarkdownLinks = (text: string) => {
  let output = "";
  let cursor = 0;

  while (cursor < text.length) {
    const openLabel = text.indexOf("[", cursor);
    if (openLabel === -1) {
      output += text.slice(cursor);
      break;
    }

    const closeLabel = text.indexOf("](", openLabel);
    if (closeLabel === -1) {
      output += text.slice(cursor);
      break;
    }

    const closeTarget = text.indexOf(")", closeLabel + 2);
    if (closeTarget === -1) {
      output += text.slice(cursor);
      break;
    }

    output += text.slice(cursor, openLabel);
    output += text.slice(openLabel + 1, closeLabel);
    cursor = closeTarget + 1;
  }

  return output;
};

const formatReleaseName = (tagName: string) => {
  const version = tagName.startsWith("v") ? tagName.slice(1) : tagName;
  return `stella ${version}`;
};

function resolveRepoPath(...segments: string[]) {
  const fromRoot = path.join(process.cwd(), ...segments);
  if (existsSync(fromRoot)) {
    return fromRoot;
  }

  return path.join(process.cwd(), "..", "..", ...segments);
}
