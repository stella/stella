import * as v from "valibot";

import {
  canonicalizePublicCountry,
  PUBLIC_COUNTRIES,
} from "@stll/api-contract/public-country-capability";
import { STATUTE_COLUMN_IDS } from "@stll/api-contract/public-law-table";

import {
  NO_COLUMN_SIZING,
  publicLawStoredLayoutEntries,
  publicLawTableLayout,
  publicLawTableLayouts,
} from "@/components/public-law-table/public-law-table-layout.logic";
import type { PublicLawTableLayout } from "@/components/public-law-table/public-law-table-layout.logic";

export type StatuteTableLayout = PublicLawTableLayout;

export const DEFAULT_STATUTE_TABLE_LAYOUT: StatuteTableLayout = {
  hidden: [],
  order: [],
  pinned: [],
  sizing: NO_COLUMN_SIZING,
  contentMode: "tight",
};

/** What storage holds, per jurisdiction. */
export const StoredStatuteLayoutSchema = v.pipe(
  v.unknown(),
  v.check(
    (value) =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  v.record(
    v.picklist(PUBLIC_COUNTRIES.map(canonicalizePublicCountry)),
    v.strictObject(publicLawStoredLayoutEntries(STATUTE_COLUMN_IDS)),
  ),
);

/** Every stored arrangement, read once; see `publicLawTableLayouts`. */
export const statuteTableLayouts = (
  stored: v.InferOutput<typeof StoredStatuteLayoutSchema>,
): Record<string, StatuteTableLayout> =>
  publicLawTableLayouts(stored, (value) =>
    publicLawTableLayout(value, DEFAULT_STATUTE_TABLE_LAYOUT),
  );
