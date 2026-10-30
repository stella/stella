import type { LegacyRepairNamespace } from "@/api/lib/legal-search/quarantine-identity";

export const PLAIN_TEXT_QUARANTINE_PREFIX = "plaintext-quarantine:";
export const PL_NCOURT_POSITION_QUARANTINE_PREFIX = "ncourt-quarantine:";

/** Stored legacy keys retain their original prefixes at every producer and reader. */
export const LEGACY_QUARANTINE_PREFIXES = {
  ris: "ris-quarantine:",
  findok: "findok-quarantine:",
  "pl-kio": "uzp-quarantine:",
  "pl-kis": "eureka-quarantine:",
  "pl-nsa": "pl-nsa-quarantine:",
  "ncourt-listed": "ncourt-listed:",
  "sk-courts-plaintext": PLAIN_TEXT_QUARANTINE_PREFIX,
} as const satisfies Record<LegacyRepairNamespace, string>;
