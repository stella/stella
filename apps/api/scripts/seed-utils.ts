/**
 * Shared utilities for seed scripts.
 *
 * Deterministic IDs, user constants, and helpers used by
 * both `seed-dev.ts` and `seed-templates.ts`.
 */

import { toSafeId } from "@/api/lib/branded-types";

// ─── Constants ──────────────────────────────────────────

export const DEFAULT_USER_ID = "test-user-stella-dev";
export const DEFAULT_ORG_ID = toSafeId<"organization">("test-org-stella-dev");

export const DEFAULT_SEED_COLLEAGUE_COUNT = 3;
export const DEFAULT_TEST_USER_COLLEAGUE_COUNT = 7;
export const MAX_SEED_COLLEAGUE_COUNT = 120;

export type SeedColleague = {
  id: string;
  name: string;
  email: string;
  image: string;
  hourlyRate: number;
};

const BASE_SEED_COLLEAGUES: SeedColleague[] = [
  {
    id: "test-user-alice-johnson",
    name: "Alice Johnson",
    email: "alice@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=alice&backgroundColor=b6e3f4",
    hourlyRate: 4500,
  },
  {
    id: "test-user-bob-martinez",
    name: "Bob Martinez",
    email: "bob@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=bob&backgroundColor=d1d4f9",
    hourlyRate: 2500,
  },
  {
    id: "test-user-clara-novak",
    name: "Clara Novak",
    email: "clara@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=clara&backgroundColor=ffd5dc",
    hourlyRate: 4500,
  },
  {
    id: "test-user-david-kim",
    name: "David Kim",
    email: "david@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=david&backgroundColor=c0aede",
    hourlyRate: 6500,
  },
  {
    id: "test-user-eva-schmidt",
    name: "Eva Schmidt",
    email: "eva@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=eva&backgroundColor=b6e3f4",
    hourlyRate: 3500,
  },
  {
    id: "test-user-frank-horvat",
    name: "Frank Horvát",
    email: "frank@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=frank&backgroundColor=d1d4f9",
    hourlyRate: 2500,
  },
  {
    id: "test-user-greta-jones",
    name: "Greta Jones",
    email: "greta@stella.dev",
    image:
      "https://api.dicebear.com/9.x/avataaars/svg?seed=greta&backgroundColor=ffd5dc",
    hourlyRate: 5500,
  },
];

const GENERATED_FIRST_NAMES = [
  "Ava",
  "Liam",
  "Nora",
  "Ethan",
  "Mila",
  "Noah",
  "Ivy",
  "Leo",
  "Ruby",
  "Mason",
  "Zoe",
  "Owen",
  "Luna",
  "Finn",
  "Clara",
  "Jude",
  "Elsa",
  "Theo",
  "Maya",
  "Hugo",
] as const;

const GENERATED_LAST_NAMES = [
  "Carter",
  "Bennett",
  "Foster",
  "Hayes",
  "Turner",
  "Parker",
  "Brooks",
  "Morris",
  "Reed",
  "Bailey",
] as const;

const GENERATED_HOURLY_RATES = [2500, 3500, 4500, 5500, 6500] as const;

const getGeneratedSeedColleague = (index: number): SeedColleague => {
  const firstName = GENERATED_FIRST_NAMES[index % GENERATED_FIRST_NAMES.length];
  const lastName =
    GENERATED_LAST_NAMES[
      Math.floor(index / GENERATED_FIRST_NAMES.length) %
        GENERATED_LAST_NAMES.length
    ];

  if (!firstName || !lastName) {
    throw new Error(`Seed data: generated colleague name missing at ${index}`);
  }

  const ordinal = String(index + 1).padStart(3, "0");
  const slug = `${firstName.toLowerCase()}-${lastName.toLowerCase()}-${ordinal}`;

  return {
    id: `test-user-${slug}`,
    name: `${firstName} ${lastName}`,
    email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}.${ordinal}@stella.dev`,
    image: `https://api.dicebear.com/9.x/avataaars/svg?seed=${slug}&backgroundColor=b6e3f4`,
    hourlyRate:
      GENERATED_HOURLY_RATES[index % GENERATED_HOURLY_RATES.length] ?? 4000,
  };
};

const GENERATED_SEED_COLLEAGUES = Array.from({
  length: MAX_SEED_COLLEAGUE_COUNT - BASE_SEED_COLLEAGUES.length,
}).map((_, index) => getGeneratedSeedColleague(index));

export const SEED_COLLEAGUES: readonly SeedColleague[] = [
  ...BASE_SEED_COLLEAGUES,
  ...GENERATED_SEED_COLLEAGUES,
];

export const getSeedColleagues = (
  colleagueCount: number,
): readonly SeedColleague[] => {
  if (colleagueCount > SEED_COLLEAGUES.length) {
    throw new Error(
      `Seed data: requested ${colleagueCount} colleagues but only ${SEED_COLLEAGUES.length} are available`,
    );
  }

  return SEED_COLLEAGUES.slice(0, colleagueCount);
};

export const ALL_TEST_USER_IDS = [
  DEFAULT_USER_ID,
  ...getSeedColleagues(DEFAULT_TEST_USER_COLLEAGUE_COUNT).map(
    (colleague) => colleague.id,
  ),
];

export const buildSeedUserIds = ({
  primaryUserId,
  colleagueCount = DEFAULT_SEED_COLLEAGUE_COUNT,
}: {
  primaryUserId: string;
  colleagueCount?: number;
}): string[] => [
  primaryUserId,
  ...getSeedColleagues(colleagueCount).map((colleague) => colleague.id),
];

export const buildSeedUserRates = (
  userIds: readonly string[],
): Record<string, number> => {
  const entries = userIds.map((userId, index) => {
    if (index === 0) {
      return [userId, 6500] as const;
    }

    return [userId, SEED_COLLEAGUES[index - 1]?.hourlyRate ?? 4000] as const;
  });

  return Object.fromEntries(entries);
};

export const pickAuthor = (
  userIds: readonly string[],
  index: number,
): string => {
  const id = userIds[index % userIds.length];
  if (!id) {
    throw new Error("Empty seed user list");
  }
  return id;
};

// ─── Deterministic ID generator ─────────────────────────

export const seedId = (label: string): string => {
  const hash = new Bun.CryptoHasher("sha256").update(label).digest("hex");
  const raw = hash.slice(0, 32);
  if (raw.length !== 32) {
    throw new Error(`Seed data: failed to create UUID for label "${label}"`);
  }
  const uuid = `${raw.slice(0, 12)}5${raw.slice(13, 16)}8${raw.slice(17)}`;
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20, 32)}`;
};

/** Safe array access for seed data (panics on out-of-bounds). */
export const at = <T>(arr: readonly T[], i: number): T => {
  const item = arr[i];
  if (item === undefined) {
    throw new Error(`Seed data: index ${i} out of bounds`);
  }
  return item;
};
