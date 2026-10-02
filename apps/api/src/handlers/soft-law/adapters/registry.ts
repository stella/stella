import type { SoftLawSourceAdapter } from "@/api/lib/legal-search/soft-law-types";

import { uoouAdapter } from "./uoou";

/** Guidance adapters have a different payload contract from court adapters. */
export const SOFT_LAW_ADAPTERS = {
  [uoouAdapter.key]: uoouAdapter,
} as const satisfies Record<string, SoftLawSourceAdapter>;
