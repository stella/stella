import type { OwnershipEntry } from "../ownership-types.ts";

export default {
  id: "stable-stringify",
  capability:
    "Deterministic string form of a JSON-shaped value for hashing and keys",
  owner: ["packages/stable-stringify/"],
  summary:
    "Sorted keys, cycle detection, and one spelling for bigint, symbol, and " +
    "function values, so a hash or cache key computed in the api and in the " +
    "browser agree byte for byte. `StableStringifyInput` is the contract: a " +
    "live Date, Map, or Set would read as `{}`, so it is a compile error " +
    "rather than a colliding fingerprint.",
  enforcement: { kind: "none" },
} as const satisfies OwnershipEntry;
