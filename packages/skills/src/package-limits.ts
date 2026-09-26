/** Shared limits for every skill-package ingestion path and CI preflight. */
export const SKILL_PACKAGE_LIMITS = {
  archiveFilesMax: 100,
  archiveUncompressedMaxBytes: 6 * 1024 * 1024,
  bodyMaxChars: 80_000,
  compatibilityMaxChars: 500,
  descriptionMaxChars: 1024,
  githubDirectoriesMax: 100,
  licenseMaxChars: 256,
  metadataEntriesMax: 32,
  metadataKeyMaxChars: 64,
  metadataValueMaxChars: 512,
  resourceMaxChars: 100_000,
  resourcePathMaxChars: 512,
  resourcesPerSkillMax: 50,
  versionMaxChars: 64,
} as const;

/**
 * Frontmatter `name` rule every skill-package ingestion path enforces: 1-64
 * lowercase letters, digits and single hyphens, neither leading nor trailing
 * (Agent Skills specification).
 */
export const SKILL_NAME_PATTERN = /^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/u;
