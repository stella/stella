// The capability catalog the CLI ships is generated from API sources when the
// CLI is built; nothing under packages/cli records it. Both changeset guards
// read what it is derived from here: the CLI contract guard to decide whether
// to compare catalogs, the package relevance check to count those sources as
// release inputs of the CLI.

import type { DerivedReleaseInputs } from "./changeset-guard";
import { GENERATORS, matchesGeneratedGlob } from "./generated-files";

class CapabilityCatalogSourcesError extends Error {
  readonly _tag = "CapabilityCatalogSourcesError";

  constructor(message: string) {
    super(message);
    this.name = "CapabilityCatalogSourcesError";
  }
}

const CAPABILITY_CATALOG_GENERATOR = "capability-catalog";

/** What the capability catalog generator reads, as generator globs. */
export const CAPABILITY_CATALOG_SOURCES = ((): readonly string[] => {
  const generator = GENERATORS.find(
    ({ id }) => id === CAPABILITY_CATALOG_GENERATOR,
  );
  if (generator === undefined) {
    throw new CapabilityCatalogSourcesError(
      `the generator manifest has no ${CAPABILITY_CATALOG_GENERATOR} entry`,
    );
  }
  return [...generator.inputs, ...(generator.checkInputs ?? [])];
})();

const isCatalogSource = (file: string): boolean =>
  CAPABILITY_CATALOG_SOURCES.some((glob) => matchesGeneratedGlob(glob, file));

/** The changed files the capability catalog is derived from. */
export const catalogSourceFiles = (
  changedFiles: readonly string[],
): readonly string[] => changedFiles.filter(isCatalogSource);

/** Whether a change touches anything the capability catalog is derived from. */
export const touchesCatalogSources = (
  changedFiles: readonly string[],
): boolean => changedFiles.some(isCatalogSource);

/** The CLI ships the catalog, so its sources are release inputs of the CLI. */
export const CAPABILITY_CATALOG_RELEASE_INPUTS = {
  packageName: "@stll/cli",
  label: "capability catalog sources",
  sources: catalogSourceFiles,
} as const satisfies DerivedReleaseInputs;
