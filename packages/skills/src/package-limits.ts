/** Shared limits for every skill-package ingestion path and CI preflight. */
export const SKILL_PACKAGE_LIMITS = {
  archiveFilesMax: 100,
  archiveUncompressedMaxBytes: 6 * 1024 * 1024,
  bodyMaxChars: 80_000,
  compatibilityMaxChars: 1000,
  descriptionMaxChars: 1000,
  githubDirectoriesMax: 100,
  licenseMaxChars: 256,
  metadataEntriesMax: 32,
  metadataKeyMaxChars: 64,
  metadataValueMaxChars: 512,
  resourceMaxChars: 100_000,
  resourcesPerSkillMax: 50,
  versionMaxChars: 64,
} as const;

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
