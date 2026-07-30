export type ReleaseKind = "major" | "minor" | "patch";

const STELLA_RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+$/u;

export const isStellaReleaseTag = (tagName: string) =>
  STELLA_RELEASE_TAG_PATTERN.test(tagName);

export const getReleaseKind = (tagName: string): ReleaseKind => {
  const [, minor, patch] = tagName.replace(/^v/u, "").split(".").map(Number);

  if (patch !== 0) {
    return "patch";
  }

  return minor === 0 ? "major" : "minor";
};
