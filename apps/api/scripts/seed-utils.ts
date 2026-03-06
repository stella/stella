/**
 * Shared utilities for seed scripts.
 *
 * Deterministic IDs, user constants, and helpers used by
 * both `seed-dev.ts` and `seed-templates.ts`.
 */

import { createHash } from "node:crypto";

import { toSafeId } from "@/api/lib/branded-types";

// ─── Constants ──────────────────────────────────────────

export const DEFAULT_USER_ID = "test-user-stella-dev";
export const DEFAULT_ORG_ID = toSafeId<"organization">("test-org-stella-dev");

export const ALL_USER_IDS = [
  DEFAULT_USER_ID,
  "test-user-alice-johnson",
  "test-user-bob-martinez",
  "test-user-clara-novak",
  "test-user-david-kim",
  "test-user-eva-schmidt",
  "test-user-frank-horvat",
  "test-user-greta-jones",
];

export const pickAuthor = (index: number): string =>
  ALL_USER_IDS[index % ALL_USER_IDS.length];

// ─── Deterministic ID generator ─────────────────────────

export const seedId = (label: string): string => {
  const hash = createHash("sha256").update(label).digest("hex");
  return hash.slice(0, 21);
};

/** Safe array access for seed data (panics on out-of-bounds). */
export const at = <T>(arr: readonly T[], i: number): T => {
  const item = arr[i];
  if (item === undefined) {
    throw new Error(`Seed data: index ${i} out of bounds`);
  }
  return item;
};
