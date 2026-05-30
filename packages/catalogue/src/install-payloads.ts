import { GENERATED_SKILL_INSTALL_PAYLOADS } from "./catalogue-install-payloads.gen";

export type LoadedCatalogueResource = {
  readonly content: string;
  readonly path: string;
  readonly sizeBytes: number;
};

export type LoadedCatalogueSkillInstallPayload = {
  readonly body: string;
  readonly resourceFiles: readonly LoadedCatalogueResource[];
  readonly slug: string;
};

const skillInstallPayloads: readonly LoadedCatalogueSkillInstallPayload[] =
  GENERATED_SKILL_INSTALL_PAYLOADS;

export const loadCatalogueSkillInstallPayloads =
  (): readonly LoadedCatalogueSkillInstallPayload[] => skillInstallPayloads;

export const findCatalogueSkillInstallPayload = (
  slug: string,
): LoadedCatalogueSkillInstallPayload | undefined =>
  skillInstallPayloads.find((payload) => payload.slug === slug);
