import { panic } from "better-result";

/**
 * A row's identity within a court breakdown; a tier row stands for its whole
 * tier, and the row for the courts beyond the listed ones stands beside it.
 */
export const courtTierRowKey = (
  row:
    | { type: "court"; court: string }
    | { type: "tier"; tier: string }
    | { type: "unlisted"; tier: string },
): string => {
  switch (row.type) {
    case "court":
      return row.court;
    case "tier":
      return row.tier;
    case "unlisted":
      return `${row.tier}:unlisted`;
    default: {
      row satisfies never;
      return panic("Unhandled case-law court row type");
    }
  }
};
