import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ChangelogRelease = {
  description: string;
  displayName: string;
  heading: string | null;
  slug: string;
  tagName: string;
};

const CHANGELOG_DIR = resolveRepoPath("docs", "changelog");
const CHANGELOG_FILE_PATTERN = /^v[\w.-]+\.md$/;

export const releaseAnchorId = (tagName: string) =>
  tagName
    .toLowerCase()
    .replaceAll(".", "-")
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

export const getChangelogReleases = (): ChangelogRelease[] => {
  if (!existsSync(CHANGELOG_DIR)) {
    return [];
  }

  return readdirSync(CHANGELOG_DIR)
    .filter((fileName) => CHANGELOG_FILE_PATTERN.test(fileName))
    .map((fileName) => {
      const tagName = fileName.replace(/\.md$/, "");
      const markdown = readFileSync(join(CHANGELOG_DIR, fileName), "utf-8");
      const heading = findHeading(markdown, 1);
      const description =
        findHeading(markdown, 2) ??
        `Release notes for ${formatReleaseName(tagName)}.`;

      return {
        description,
        displayName: formatReleaseName(tagName),
        heading,
        slug: releaseAnchorId(tagName),
        tagName,
      };
    })
    .sort((left, right) =>
      right.tagName.localeCompare(left.tagName, "en", { numeric: true }),
    );
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
  stripMarkdownLinks(text).replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

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
  const fromRoot = join(process.cwd(), ...segments);
  if (existsSync(fromRoot)) {
    return fromRoot;
  }

  return join(process.cwd(), "..", "..", ...segments);
}
