import { ARES_COURT_INSTRUMENTAL_TOKEN } from "./court-names.js";

export const ARES_FILE_REFERENCE_TOKEN = "file reference" as const;

// FORMA company codes: v.o.s., s.r.o., k.s., a.s., and European company.
export const isAresCommercialCompany = (legalForm: string | null): boolean =>
  legalForm !== null && ["111", "112", "113", "121", "932"].includes(legalForm);

// Registry-language legal wording, shared by the editor and default renderer.
export const ARES_DEFAULT_FORMAT_PARTS = {
  name: "společnost **[company name]**",
  address: "se sídlem [address]",
  identifier: "IČO: [registry number]",
  registration: `zapsaná v obchodním rejstříku vedeném [${ARES_COURT_INSTRUMENTAL_TOKEN}] pod sp. zn. [${ARES_FILE_REFERENCE_TOKEN}]`,
} as const;

export const ARES_DEFAULT_FORMAT = Object.values(
  ARES_DEFAULT_FORMAT_PARTS,
).join(", ");

